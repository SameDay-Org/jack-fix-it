"""Who has a job's chat open, and when its last new-message push went out (#73 part 1).

The app lists a thread only while its chat screen is focused and the app in the foreground,
every EXPO_PUBLIC_CHAT_POLL_SECONDS (#74). So a participant who listed it, or moved their read
marker, within CHAT_PRESENCE_SECONDS has the chat open: a new message reaches them there and no
push is sent. One who is away gets at most one push per job per CHAT_PUSH_COOLDOWN_SECONDS, and
listing the thread ends that cooldown, so the first message after they leave pushes at once.

Two Redis keys per participant per job, each with a TTL (nothing to clean up):
`chat:present:<job id>:<user id>` and `chat:pushed:<job id>:<user id>`. Each step is one Lua
script, so a listing and a claim never interleave halfway.

Best effort, and failing toward the push: a Redis error, or a call longer than
RATE_LIMIT_TIMEOUT_SECONDS (the budget of a Redis call on a request's path), counts as away and
not cooled down. It is logged with ids only (`chat_presence_unavailable`) and never fails the
request. A push carries no text (the catalog's lock-screen rule), so an extra one costs only a
notification, while a lost one could leave a message unseen.
"""

import asyncio
import logging
import uuid
from enum import StrEnum
from typing import Annotated, Final, Protocol

from fastapi import Depends, Request
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.config import Settings, get_app_settings

logger = logging.getLogger(__name__)

KEY_PREFIX: Final = "chat"

# KEYS: present, pushed. ARGV: presence seconds. The participant has the chat open, so the
# cooldown of their last push ends with it.
_SEEN_SCRIPT: Final = """
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
redis.call('DEL', KEYS[2])
return 1
"""

# KEYS: present, pushed. ARGV: cooldown seconds. 'present' while the chat is open, 'cooldown'
# while a push for this job went out within the cooldown, else the claim is taken: 'push'.
_CLAIM_SCRIPT: Final = """
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 'present'
end
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[1]) then
  return 'push'
end
return 'cooldown'
"""


class PushClaim(StrEnum):
    PUSH = "push"
    PRESENT = "present"  # the recipient has the chat open
    COOLDOWN = "cooldown"  # a push for this job went out to them within the cooldown


class ChatPresence(Protocol):
    async def seen(self, job_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """The participant has the chat open now. Never raises."""
        ...

    async def claim_push(self, job_id: uuid.UUID, user_id: uuid.UUID) -> PushClaim:
        """Whether a new message in the job pushes to the participant; PUSH takes the cooldown.
        Never raises: PUSH when Redis cannot tell."""
        ...


def present_key(prefix: str, job_id: uuid.UUID, user_id: uuid.UUID) -> str:
    return f"{prefix}:present:{job_id}:{user_id}"


def pushed_key(prefix: str, job_id: uuid.UUID, user_id: uuid.UUID) -> str:
    return f"{prefix}:pushed:{job_id}:{user_id}"


class RedisChatPresence:
    def __init__(
        self,
        redis: Redis,
        *,
        presence_seconds: int,
        cooldown_seconds: int,
        timeout_seconds: float,
        prefix: str = KEY_PREFIX,
    ) -> None:
        self._seen = redis.register_script(_SEEN_SCRIPT)
        self._claim = redis.register_script(_CLAIM_SCRIPT)
        self._presence_seconds = presence_seconds
        self._cooldown_seconds = cooldown_seconds
        self._timeout = timeout_seconds
        self._prefix = prefix

    def _keys(self, job_id: uuid.UUID, user_id: uuid.UUID) -> list[str]:
        return [
            present_key(self._prefix, job_id, user_id),
            pushed_key(self._prefix, job_id, user_id),
        ]

    async def seen(self, job_id: uuid.UUID, user_id: uuid.UUID) -> None:
        try:
            async with asyncio.timeout(self._timeout):
                await self._seen(keys=self._keys(job_id, user_id), args=[self._presence_seconds])
        except (RedisError, OSError):  # OSError includes TimeoutError
            _unavailable("seen", job_id, user_id)

    async def claim_push(self, job_id: uuid.UUID, user_id: uuid.UUID) -> PushClaim:
        try:
            async with asyncio.timeout(self._timeout):
                raw = await self._claim(
                    keys=self._keys(job_id, user_id), args=[self._cooldown_seconds]
                )
        except (RedisError, OSError):  # OSError includes TimeoutError
            _unavailable("claim_push", job_id, user_id)
            return PushClaim.PUSH
        answer = raw.decode() if isinstance(raw, bytes) else str(raw)
        return PushClaim(answer)


def _unavailable(step: str, job_id: uuid.UUID, user_id: uuid.UUID) -> None:
    # By step only: a Redis error's text can name the server.
    logger.warning(
        "chat_presence_unavailable",
        extra={"step": step, "job_id": str(job_id), "user_id": str(user_id)},
    )


def get_chat_presence(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> ChatPresence:
    """FastAPI dependency: presence on the app's Redis (created at startup; tests override)."""
    redis: Redis = request.app.state.redis
    return RedisChatPresence(
        redis,
        presence_seconds=settings.chat_presence_seconds,
        cooldown_seconds=settings.chat_push_cooldown_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )
