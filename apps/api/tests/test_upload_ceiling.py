"""The ceiling on a user's pending uploads (#529; Cesar 2026-11-23: 200 MB; the Foreman's
conditions 2026-11-24): what is stored and attached to nothing, plus the URLs issued and not
landed, never passes UPLOAD_PENDING_MAX_BYTES.

The bucket is a fake that lists, deletes and presigns; the grants are the in-memory ones of
tests/conftest.py on the API, and the real Redis script in its own tests.
"""

import uuid
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.storage import (
    DeleteResult,
    ObjectPage,
    PresignedUpload,
    StorageUnavailableError,
    StoredObject,
    get_storage,
)
from app.modules.uploads.orphans import OrphanSweepConfig, OrphanUploadSweeper
from app.modules.uploads.pending import GRANTS_PREFIX, RedisUploadGrants
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.conftest import make_app, make_settings
from tests.test_orphan_uploads import MIN_AGE, NOW, sessions_of
from tests.test_uploads_api import Caller, ask_upload, make_caller

MIB = 1024 * 1024
MB = 1_000_000
CEILING = 200 * MIB  # UPLOAD_PENDING_MAX_BYTES's default
TOO_LARGE = {
    "error": {
        "code": "pending_uploads_too_large",
        "message": (
            "Your uploads waiting to be used are over the limit. Finish what you started, or "
            "wait a day for unused ones to clear, then try again."
        ),
    }
}
UNAVAILABLE = {
    "error": {
        "code": "uploads_unavailable",
        "message": "Uploads are unavailable right now. Try again later.",
    }
}


@dataclass
class FakeBucket:
    """What a bucket answers: its objects listed by prefix, deleted, and PUT URLs presigned."""

    objects: dict[str, StoredObject] = field(default_factory=dict)
    puts: list[str] = field(default_factory=list)
    listed: list[str] = field(default_factory=list)
    failing: bool = False

    def store(self, key: str, size: int, at: datetime) -> None:
        self.objects[key] = StoredObject(key, at, size)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:
        self.puts.append(key)
        headers: Mapping[str, str] = {"Content-Type": content_type}
        return PresignedUpload(url=f"https://storage.example.invalid/put/{key}", headers=headers)

    def presign_get(self, key: str, expires_in: int) -> str:
        return f"https://storage.example.invalid/get/{key}"

    def list_older_than(self, prefix: str, before: datetime) -> Iterator[ObjectPage]:
        self.listed.append(prefix)
        if self.failing:
            raise StorageUnavailableError("list failed: test")
        mine = [item for key, item in sorted(self.objects.items()) if key.startswith(prefix)]
        older = [item for item in mine if item.last_modified < before]
        yield ObjectPage(objects=older, newer=len(mine) - len(older))

    def download_to(self, key: str, path: Path) -> None:
        raise AssertionError("the ceiling never downloads")

    def upload_from(self, path: Path, key: str, content_type: str) -> None:
        raise AssertionError("the ceiling never uploads")

    def delete_many(self, keys: Sequence[str]) -> DeleteResult:
        for key in keys:
            self.objects.pop(key, None)
        return DeleteResult(deleted=len(keys), failed=0)


@pytest.fixture
def bucket() -> FakeBucket:
    return FakeBucket()


def client_for(
    settings: Settings, bucket: FakeBucket, db_session: AsyncSession
) -> httpx.AsyncClient:
    app = make_app(settings)
    app.dependency_overrides[get_storage] = lambda: bucket

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


def a_key(caller: Caller, purpose: str = "request_media", extension: str = ".mp4") -> str:
    return f"u/{caller.id}/{purpose}/{uuid.uuid4().hex}{extension}"


async def test_a_burst_is_refused_at_the_url_that_passes_the_ceiling(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    """The Foreman's case: 30 URLs of 150 MB in a row (the video maximum raised to 150 MB for
    it; 100 MiB by default). The second would put 300 MB pending: 413, and so every one after
    it while the first is pending. Another account is not affected."""
    settings = make_settings(upload_max_video_bytes=150 * MB)
    async with client_for(settings, bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        bruno = await make_caller(db_session, UserRole.CUSTOMER)
        burst = [
            await ask_upload(client, ana, "request_media", "video/mp4", 150 * MB) for _ in range(30)
        ]
        other = await ask_upload(client, bruno, "request_media", "video/mp4", 150 * MB)

    assert [response.status_code for response in burst] == [201] + [413] * 29
    for refused in burst[1:]:
        assert refused.json() == TOO_LARGE
        assert str(ana.id) not in refused.text  # no key, no path (condition 4)
    assert len([key for key in bucket.puts if key.startswith(f"u/{ana.id}/")]) == 1
    assert other.status_code == 201
    # The listing is the caller's own prefix only (condition 1).
    assert set(bucket.listed) == {f"u/{ana.id}/", f"u/{bruno.id}/"}


async def test_a_storage_outage_gives_no_url(db_session: AsyncSession, bucket: FakeBucket) -> None:
    """Fail closed (condition 1): the pending bytes cannot be counted, so 503, never a URL."""
    bucket.failing = True
    async with client_for(make_settings(), bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        response = await ask_upload(client, ana, "request_media", "image/jpeg", 1_000)

    assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert bucket.puts == []


async def test_stored_bytes_count_by_their_real_size(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    """Condition 2: what is in the bucket counts by its stored size, whatever was declared."""
    async with client_for(make_settings(), bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        bucket.store(a_key(ana), CEILING - 10, NOW)
        fits = await ask_upload(client, ana, "request_media", "image/jpeg", 10)
        over = await ask_upload(client, ana, "request_media", "image/jpeg", 1)

    assert fits.status_code == 201
    assert (over.status_code, over.json()) == (413, TOO_LARGE)


async def test_an_attached_upload_does_not_count(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    async with client_for(make_settings(), bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        photo = a_key(ana, "profile_photo", ".jpg")
        bucket.store(photo, CEILING, NOW)
        refused = await ask_upload(client, ana, "request_media", "image/jpeg", 1)
        await db_session.execute(update(User).where(User.id == ana.id).values(photo_key=photo))
        await db_session.flush()
        admitted = await ask_upload(client, ana, "request_media", "image/jpeg", 1)

    assert refused.status_code == 413
    assert admitted.status_code == 201


async def test_an_orphan_the_sweep_deletes_frees_its_bytes(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    """Condition 5: an upload nothing holds counts until the orphan sweep (delete, the default)
    removes it after ORPHAN_UPLOAD_MIN_AGE_HOURS; then its bytes are free."""
    async with client_for(make_settings(), bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        bucket.store(a_key(ana), 150 * MIB, NOW - timedelta(hours=25))
        before_sweep = await ask_upload(client, ana, "request_media", "video/mp4", 60 * MIB)
        counts = await OrphanUploadSweeper(
            sessions_of(db_session), bucket, OrphanSweepConfig("delete", MIN_AGE), lambda: NOW
        ).sweep()
        after_sweep = await ask_upload(client, ana, "request_media", "video/mp4", 60 * MIB)

    assert (before_sweep.status_code, before_sweep.json()) == (413, TOO_LARGE)
    assert counts.deleted == 1
    assert after_sweep.status_code == 201


# The grants in Redis: the real script


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
def user_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
async def grants(redis: Redis, user_id: uuid.UUID) -> AsyncIterator[RedisUploadGrants]:
    try:
        yield RedisUploadGrants(redis, ttl_seconds=300, max_bytes=1_000, timeout_seconds=2.0)
    finally:
        await redis.delete(f"{GRANTS_PREFIX}:{user_id}")


T0 = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)


async def test_grants_add_up_to_the_ceiling(
    grants: RedisUploadGrants, user_id: uuid.UUID, redis: Redis
) -> None:
    async def admit(key: str, size: int, stored: int = 0, at: datetime = T0) -> bool:
        return await grants.admit(user_id, key, size, stored_bytes=stored, landed=[], now=at)

    assert await admit("u/a", 600)
    assert not await admit("u/b", 500)  # 600 + 500 > 1000: refused, and not recorded
    assert await admit("u/c", 400)  # exactly 1000
    assert not await admit("u/d", 1)
    assert not await admit("u/e", 0 + 1, stored=1)
    # The key lives no longer than a URL (condition 3).
    ttl_ms = await redis.pttl(f"{GRANTS_PREFIX}:{user_id}")
    assert 0 < ttl_ms <= 300_000


async def test_a_grant_ends_with_its_url(grants: RedisUploadGrants, user_id: uuid.UUID) -> None:
    """Condition 3: a URL issued UPLOAD_URL_TTL_SECONDS ago can no longer be used, so its
    grant no longer counts."""
    assert await grants.admit(user_id, "u/a", 900, stored_bytes=0, landed=[], now=T0)
    later = T0 + timedelta(seconds=300)

    assert not await grants.admit(
        user_id, "u/b", 900, stored_bytes=0, landed=[], now=later - timedelta(milliseconds=1)
    )
    assert await grants.admit(user_id, "u/b", 900, stored_bytes=0, landed=[], now=later)


async def test_a_landed_grant_counts_once(grants: RedisUploadGrants, user_id: uuid.UUID) -> None:
    """Once its file is in the bucket, an upload counts by its stored size (the listing), not
    again as a grant."""
    assert await grants.admit(user_id, "u/a", 600, stored_bytes=0, landed=[], now=T0)

    # The file landed: 600 stored, and the grant for "u/a" is not counted a second time.
    assert await grants.admit(user_id, "u/b", 400, stored_bytes=600, landed=["u/a"], now=T0)
    assert not await grants.admit(user_id, "u/c", 1, stored_bytes=600, landed=["u/a"], now=T0)
