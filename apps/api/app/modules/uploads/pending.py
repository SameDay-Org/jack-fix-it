"""The ceiling on one user's pending uploads (#529; Cesar 2026-11-23: 200 MB, the Foreman's
conditions 2026-11-24).

An upload is pending while nothing holds it: stored in the bucket and referenced by no row, or
issued (a PUT URL handed out) and not landed yet. Before a new URL is given, the caller's
pending bytes plus the new upload's size must stay within UPLOAD_PENDING_MAX_BYTES, or the
answer is 413 pending_uploads_too_large.

- What is counted: the caller's own prefix (`u/<user_id>/`) only, listed from the bucket, each
  object by its stored size; the keys some row references (the orphan sweep's own test,
  orphans.referenced_keys) left out. The orphan sweep deletes what nothing references after
  ORPHAN_UPLOAD_MIN_AGE_HOURS, which frees those bytes.
- The burst guard: each URL given is recorded in Redis, with its key and size, until
  UPLOAD_URL_TTL_SECONDS passes (when the URL itself expires), and counted while its key is
  not in the bucket yet. One Lua step adds up, decides and records, so two requests at once
  cannot both pass the ceiling.
- Fail closed: a listing or a Redis call that fails gives no URL (503 uploads_unavailable).
- Logs carry the user's id and byte counts, never a key or a path.
"""

import asyncio
import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final, Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import Storage, StorageUnavailableError, StoredObject
from app.modules.uploads.errors import PendingUploadsTooLargeError, UploadsUnavailableError
from app.modules.uploads.orphans import referenced_keys

logger = logging.getLogger(__name__)

GRANTS_PREFIX: Final = "upload-grants"
# Everything in a listing: no object is newer than this.
_ALL: Final = datetime.max.replace(tzinfo=UTC)

# KEYS[1]: the user's grants, a sorted set of "<key>|<size>" scored by when each one expires
# (ms). ARGV: now (ms), the URL lifetime (ms), the bytes already pending in the bucket, the
# ceiling, the new key, its size, then the keys already in the bucket (not counted twice).
# 1 and the new grant recorded when it fits; 0 and nothing written when it does not.
_ADMIT_SCRIPT: Final = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local landed = {}
for i = 7, #ARGV do landed[ARGV[i]] = true end
local total = tonumber(ARGV[3])
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local cut = string.find(member, '|', 1, true)
  if not landed[string.sub(member, 1, cut - 1)] then
    total = total + tonumber(string.sub(member, cut + 1))
  end
end
if total + tonumber(ARGV[6]) > tonumber(ARGV[4]) then
  return 0
end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[5] .. '|' .. ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
"""


class UploadGrants(Protocol):
    async def admit(
        self,
        user_id: uuid.UUID,
        key: str,
        size_bytes: int,
        *,
        stored_bytes: int,
        landed: Sequence[str],
        now: datetime,
    ) -> bool:
        """Records the grant and answers True when the stored pending bytes, the grants not
        landed and this one fit the ceiling; False, and nothing recorded, when they do not.
        May raise RedisError or OSError."""
        ...


class RedisUploadGrants:
    def __init__(
        self, redis: Redis, *, ttl_seconds: int, max_bytes: int, timeout_seconds: float
    ) -> None:
        self._ttl_ms = ttl_seconds * 1000
        self._max = max_bytes
        self._timeout = timeout_seconds
        self._script = redis.register_script(_ADMIT_SCRIPT)

    async def admit(
        self,
        user_id: uuid.UUID,
        key: str,
        size_bytes: int,
        *,
        stored_bytes: int,
        landed: Sequence[str],
        now: datetime,
    ) -> bool:
        async with asyncio.timeout(self._timeout):
            answer = await self._script(
                keys=[f"{GRANTS_PREFIX}:{user_id}"],
                args=[
                    int(now.timestamp() * 1000),
                    self._ttl_ms,
                    stored_bytes,
                    self._max,
                    key,
                    size_bytes,
                    *landed,
                ],
            )
        return bool(answer)


def _listed(storage: Storage, prefix: str) -> list[list[StoredObject]]:
    """The caller's objects, a listing page at a time (S3's pages hold at most 1,000)."""
    return [list(page.objects) for page in storage.list_older_than(prefix, _ALL)]


class PendingUploads:
    def __init__(
        self,
        session: AsyncSession,
        storage: Storage,
        grants: UploadGrants,
        *,
        list_timeout_seconds: float,
    ) -> None:
        """`list_timeout_seconds`: the most the listing may take in all
        (UPLOAD_PENDING_LIST_TIMEOUT_SECONDS)."""
        self._session = session
        self._storage = storage
        self._grants = grants
        self._list_timeout = list_timeout_seconds

    async def admit(self, user_id: uuid.UUID, key: str, size_bytes: int) -> None:
        """Lets the URL for `key` be given, or raises PendingUploadsTooLargeError (413) or
        UploadsUnavailableError (503)."""
        ids = {"user_id": str(user_id)}
        # The request's transaction (its authentication's reads) ends here: no pooled
        # connection waits on the storage.
        await self._session.commit()
        try:
            # boto3 is blocking: the listing runs in a thread, the caller's own prefix only,
            # within UPLOAD_PENDING_LIST_TIMEOUT_SECONDS in all (the API's client has short
            # timeouts and few attempts of its own, so the thread ends soon after).
            async with asyncio.timeout(self._list_timeout):
                pages = await asyncio.to_thread(_listed, self._storage, f"u/{user_id}/")
        except StorageUnavailableError:
            logger.error("pending_uploads_listing_failed", extra=ids)
            raise UploadsUnavailableError from None
        except TimeoutError:
            logger.error("pending_uploads_listing_timed_out", extra=ids)
            raise UploadsUnavailableError from None
        stored_bytes = 0
        for page in pages:
            # One page's keys per statement, as the sweep checks them: a whole account's in
            # one would pass the driver's limit on arguments.
            held = await referenced_keys(self._session, [item.key for item in page])
            stored_bytes += sum(item.size_bytes for item in page if item.key not in held)
        await self._session.commit()  # nothing is held while Redis answers
        try:
            admitted = await self._grants.admit(
                user_id,
                key,
                size_bytes,
                stored_bytes=stored_bytes,
                landed=[item.key for page in pages for item in page],
                now=datetime.now(UTC),
            )
        except (RedisError, OSError):  # OSError includes TimeoutError
            logger.error("pending_uploads_grants_unavailable", extra=ids)
            raise UploadsUnavailableError from None
        if not admitted:
            logger.warning(
                "pending_uploads_too_large",
                extra={**ids, "stored_bytes": stored_bytes, "size_bytes": size_bytes},
            )
            raise PendingUploadsTooLargeError
