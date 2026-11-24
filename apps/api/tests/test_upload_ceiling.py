"""The ceiling on a user's pending uploads (#529; Cesar 2026-11-23: 200 MB; the Foreman's
conditions 2026-11-24): what is stored and attached to nothing, plus the URLs issued and not
landed, never passes UPLOAD_PENDING_MAX_BYTES.

The bucket is a fake that lists, deletes and presigns; the grants are the in-memory ones of
tests/conftest.py on the API, and the real Redis script in its own tests.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.storage import (
    DeleteResult,
    ObjectPage,
    PresignedUpload,
    S3Storage,
    StorageUnavailableError,
    StoredObject,
    get_storage,
)
from app.modules.uploads.orphans import OrphanSweepConfig, OrphanUploadSweeper
from app.modules.uploads.pending import GRANTS_PREFIX, RedisUploadGrants, UploadGrants
from app.modules.uploads.router import get_upload_grants
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import TEST_STORAGE_SETTINGS, make_app, make_settings
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
    page_size: int = 1_000  # S3's own
    delay_seconds: float = 0.0
    # Called while listing: what it returns is kept (the test's own probe).
    probe: Callable[[], object] | None = None
    probed: list[object] = field(default_factory=list)

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
        if self.probe is not None:
            self.probed.append(self.probe())
        if self.delay_seconds:
            time.sleep(self.delay_seconds)
        if self.failing:
            raise StorageUnavailableError("list failed: test")
        mine = [item for key, item in sorted(self.objects.items()) if key.startswith(prefix)]
        for start in range(0, max(len(mine), 1), self.page_size):
            chunk = mine[start : start + self.page_size]
            older = [item for item in chunk if item.last_modified < before]
            yield ObjectPage(objects=older, newer=len(chunk) - len(older))

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


def app_for(settings: Settings, bucket: FakeBucket, db_session: AsyncSession) -> FastAPI:
    app = make_app(settings)
    app.dependency_overrides[get_storage] = lambda: bucket

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    return app


def client_of(app: FastAPI) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


def client_for(
    settings: Settings, bucket: FakeBucket, db_session: AsyncSession
) -> httpx.AsyncClient:
    return client_of(app_for(settings, bucket, db_session))


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


async def test_no_transaction_is_open_while_the_bucket_is_listed(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    """#635 Gatekeeper (1): the request's own reads (its authentication) end before the
    listing, so no pooled connection waits on the storage."""
    bucket.probe = db_session.in_transaction
    async with client_for(make_settings(), bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        response = await ask_upload(client, ana, "request_media", "image/jpeg", 1_000)

    assert response.status_code == 201
    assert bucket.probed == [False]


async def test_a_slow_listing_gives_a_quick_503(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    """#635 Gatekeeper (2): UPLOAD_PENDING_LIST_TIMEOUT_SECONDS bounds the whole listing (0.3 s
    here); a stalled storage answers 503 then, not after the worker's long timeouts."""
    bucket.delay_seconds = 3.0
    settings = make_settings(upload_pending_list_timeout_seconds=0.3)
    async with client_for(settings, bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        started = time.monotonic()
        response = await ask_upload(client, ana, "request_media", "image/jpeg", 1_000)
        took = time.monotonic() - started

    assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert took < 2.0
    assert bucket.puts == []


def test_the_apis_storage_client_has_short_bounds() -> None:
    """#635 Gatekeeper (2): the API's client (get_storage) uses S3_REQUEST_* (the worker keeps
    its long ones for transfers)."""
    settings = make_settings(
        **TEST_STORAGE_SETTINGS,
        s3_request_connect_timeout_seconds=1.5,
        s3_request_read_timeout_seconds=4.0,
        s3_request_max_attempts=2,
    )
    app = FastAPI()
    app.state.settings = settings
    built = get_storage(Request({"type": "http", "app": app}))
    assert isinstance(built, S3Storage)
    api = built._client.meta.config
    worker = S3Storage.from_settings(settings)._client.meta.config  # the worker's (worker.py)

    assert (api.connect_timeout, api.read_timeout) == (1.5, 4.0)
    assert api.retries == {"total_max_attempts": 2, "mode": "standard"}  # 1 call + 1 retry
    assert (worker.connect_timeout, worker.read_timeout) == (
        settings.s3_connect_timeout_seconds,
        settings.s3_read_timeout_seconds,
    )


class FailingGrants:
    def __init__(self, error: Exception) -> None:
        self.error = error

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
        raise self.error


class HalfListedBucket(FakeBucket):
    """A listing that fails after its first page."""

    def list_older_than(self, prefix: str, before: datetime) -> Iterator[ObjectPage]:
        self.listed.append(prefix)
        yield ObjectPage(objects=[], newer=0)
        raise StorageUnavailableError("list failed: test")


def dead_redis_grants() -> RedisUploadGrants:
    """The real client and script, on a port nothing answers."""
    redis = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.3)
    return RedisUploadGrants(
        redis, ttl_seconds=300, grace_seconds=60, max_bytes=CEILING, timeout_seconds=1.0
    )


@pytest.mark.parametrize(
    "case",
    ["listing fails", "listing fails after a page", "redis error", "redis timeout", "redis down"],
)
async def test_no_url_when_the_count_cannot_be_made(db_session: AsyncSession, case: str) -> None:
    """#635 Gatekeeper (3) and the Vault's U3: the pending bytes cannot be counted, or the
    grants cannot be read or written: 503, never a URL."""
    bucket = HalfListedBucket() if case == "listing fails after a page" else FakeBucket()
    bucket.failing = case == "listing fails"
    app = app_for(make_settings(), bucket, db_session)
    failing: UploadGrants | None = None
    if case == "redis error":
        failing = FailingGrants(RedisConnectionError("redis is down"))
    if case == "redis timeout":
        failing = FailingGrants(TimeoutError())
    if case == "redis down":
        failing = dead_redis_grants()
    if failing is not None:
        grants = failing
        app.dependency_overrides[get_upload_grants] = lambda: grants
    async with client_of(app) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        refused = await ask_upload(client, ana, "request_media", "video/mp4", 1)

    assert (refused.status_code, refused.json()) == (503, UNAVAILABLE), case
    assert bucket.puts == []  # nothing was presigned


def rendered(caplog: pytest.LogCaptureFixture) -> str:
    """The log lines as the API writes them (JSON with their extras), and pytest's text."""
    formatter = JsonFormatter()
    return caplog.text + "\n".join(formatter.format(record) for record in caplog.records)


def served_by(response: httpx.Response) -> str:
    return response.text + "".join(f"{k}: {v};" for k, v in response.headers.items())


async def test_a_refusal_names_no_key_and_no_path_and_neither_do_the_logs(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """Condition 4, and the Vault's U2 (#635): a 413 and both 503s say nothing of the caller's
    files, and their log lines carry the user's id and byte counts only: no key, no prefix, no
    path, not even one inside an error's own text."""
    bucket = FakeBucket()
    app = app_for(make_settings(), bucket, db_session)
    caplog.set_level(logging.DEBUG)
    async with client_of(app) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        granted = await ask_upload(client, ana, "request_media", "video/mp4", 100 * MIB)
        bucket.store(a_key(ana), 150 * MIB, datetime.now(UTC) - timedelta(hours=1))
        too_large = await ask_upload(client, ana, "request_media", "video/mp4", 100 * MIB)
        bucket.failing = True
        no_listing = await ask_upload(client, ana, "request_media", "video/mp4", 1)
        bucket.failing = False
        secret = f"u/{ana.id}/request_media/in-the-error-text.mp4"
        grants = FailingGrants(RedisConnectionError(secret))
        app.dependency_overrides[get_upload_grants] = lambda: grants
        no_grants = await ask_upload(client, ana, "request_media", "video/mp4", 1)

    assert granted.status_code == 201, granted.text
    assert (too_large.status_code, too_large.json()) == (413, TOO_LARGE)
    assert (no_listing.status_code, no_listing.json()) == (503, UNAVAILABLE)
    assert (no_grants.status_code, no_grants.json()) == (503, UNAVAILABLE)
    needles = (f"u/{ana.id}", str(ana.id), "request_media", ".mp4", "storage.example")
    for refused in (too_large, no_listing, no_grants):
        for needle in (*needles, GRANTS_PREFIX):
            assert needle not in served_by(refused), (refused.status_code, needle)
    logs = rendered(caplog)
    for event in (
        "pending_uploads_too_large",
        "pending_uploads_listing_failed",
        "pending_uploads_grants_unavailable",
    ):
        assert event in logs
    # The user's id is in the logs (ids are allowed); a key, a prefix or a path never is.
    for needle in (f"u/{ana.id}", "/request_media/", ".mp4", "storage.example", "in-the-error"):
        assert needle not in logs, needle


async def test_thousands_of_files_are_checked_a_page_at_a_time(
    db_session: AsyncSession, bucket: FakeBucket
) -> None:
    """#635 Gatekeeper (4): 6,000 files (six pages) in one account. Checked in one statement
    they would pass the driver's 32,767 arguments (six per key) and fail every URL."""
    async with client_for(make_settings(), bucket, db_session) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        for index in range(6_000):
            bucket.store(f"u/{ana.id}/request_media/{index:05}.jpg", 1, NOW)
        response = await ask_upload(client, ana, "request_media", "image/jpeg", 1_000)

    assert response.status_code == 201


def test_the_decided_values_are_the_defaults() -> None:
    """Cesar's values (2026-11-23), unset in the environment: 30 URLs an hour, 200 MiB
    pending, orphans deleted after a day."""
    fields = Settings.model_fields
    assert fields["upload_url_limit"].default == 30
    assert fields["upload_url_window_seconds"].default == 3_600
    assert fields["upload_pending_max_bytes"].default == CEILING
    assert fields["orphan_upload_mode"].default == "delete"
    assert fields["orphan_upload_min_age_hours"].default == 24


def test_the_ceiling_holds_the_largest_upload() -> None:
    with pytest.raises(ValueError, match="UPLOAD_PENDING_MAX_BYTES"):
        make_settings(upload_pending_max_bytes=10, upload_max_video_bytes=11)


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
        yield RedisUploadGrants(
            redis, ttl_seconds=300, grace_seconds=GRACE, max_bytes=1_000, timeout_seconds=2.0
        )
    finally:
        await redis.delete(f"{GRANTS_PREFIX}:{user_id}")


T0 = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)
GRACE = 60


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
    # The key lives no longer than a grant: its URL's lifetime and the grace (N1).
    ttl_ms = await redis.pttl(f"{GRANTS_PREFIX}:{user_id}")
    assert 300_000 < ttl_ms <= (300 + GRACE) * 1000


async def test_a_grant_outlives_its_url_by_the_grace(
    grants: RedisUploadGrants, user_id: uuid.UUID
) -> None:
    """The Vault's N1 (#635; the Foreman 2026-11-24): storage checks a URL when the upload
    starts, so one begun just before its URL ends can still be landing. Its grant counts for
    UPLOAD_GRANT_GRACE_SECONDS more, then no longer: by then it has landed (and counts by its
    stored size) or it never will."""
    assert await grants.admit(user_id, "u/a", 900, stored_bytes=0, landed=[], now=T0)
    url_ended = T0 + timedelta(seconds=300)
    grace_ended = url_ended + timedelta(seconds=GRACE)

    for still_landing in (url_ended, grace_ended - timedelta(milliseconds=1)):
        assert not await grants.admit(
            user_id, "u/b", 900, stored_bytes=0, landed=[], now=still_landing
        )
    assert await grants.admit(user_id, "u/b", 900, stored_bytes=0, landed=[], now=grace_ended)


def test_the_apps_grants_count_for_the_url_and_the_grace() -> None:
    """The route's grants (get_upload_grants): UPLOAD_URL_TTL_SECONDS plus
    UPLOAD_GRANT_GRACE_SECONDS, and the ceiling."""
    settings = make_settings(upload_url_ttl_seconds=300, upload_grant_grace_seconds=900)
    app = FastAPI()
    app.state.redis = Redis.from_url(settings.redis_url)  # no connection is made here
    built = get_upload_grants(Request({"type": "http", "app": app}), settings)

    assert isinstance(built, RedisUploadGrants)
    assert (built._lifetime_ms, built._max) == (1_200_000, settings.upload_pending_max_bytes)


async def test_an_upload_still_landing_after_its_url_ends_is_counted(
    db_session: AsyncSession, bucket: FakeBucket, redis: Redis
) -> None:
    """The Vault's U4, through the API on the real script, with URLs of one second: two
    100 MiB URLs are given and the third refused; the uploads are still going when the URLs
    end, so nothing more is given until they land or the grace ends. When they land they count
    once, by their stored size."""
    settings = make_settings(upload_url_ttl_seconds=1, upload_grant_grace_seconds=GRACE)
    app = app_for(settings, bucket, db_session)
    grants = RedisUploadGrants(
        redis, ttl_seconds=1, grace_seconds=GRACE, max_bytes=CEILING, timeout_seconds=2.0
    )
    app.dependency_overrides[get_upload_grants] = lambda: grants
    async with client_of(app) as client:
        ana = await make_caller(db_session, UserRole.CUSTOMER)
        try:
            given = [
                await ask_upload(client, ana, "request_media", "video/mp4", 100 * MIB)
                for _ in range(2)
            ]
            third = await ask_upload(client, ana, "request_media", "video/mp4", 100 * MIB)
            await asyncio.sleep(1.2)  # the URLs end; the uploads are still going
            after_the_urls = await ask_upload(client, ana, "request_media", "video/mp4", 1)
            for key in bucket.puts:  # ...and now they land
                bucket.store(key, 100 * MIB, datetime.now(UTC))
            after_landing = await ask_upload(client, ana, "request_media", "video/mp4", 1)
        finally:
            await redis.delete(f"{GRANTS_PREFIX}:{ana.id}")

    assert [response.status_code for response in given] == [201, 201]
    assert (third.status_code, third.json()) == (413, TOO_LARGE)
    assert (after_the_urls.status_code, after_the_urls.json()) == (413, TOO_LARGE)
    assert (after_landing.status_code, after_landing.json()) == (413, TOO_LARGE)
    assert len(bucket.puts) == 2


async def test_a_landed_grant_counts_once(grants: RedisUploadGrants, user_id: uuid.UUID) -> None:
    """Once its file is in the bucket, an upload counts by its stored size (the listing), not
    again as a grant."""
    assert await grants.admit(user_id, "u/a", 600, stored_bytes=0, landed=[], now=T0)

    # The file landed: 600 stored, and the grant for "u/a" is not counted a second time.
    assert await grants.admit(user_id, "u/b", 400, stored_bytes=600, landed=["u/a"], now=T0)
    assert not await grants.admit(user_id, "u/c", 1, stored_bytes=600, landed=["u/a"], now=T0)
