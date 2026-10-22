"""The worker's privacy-safe copies of a request's media (#173): rows, storage, retries, logs.

Real database (rolled back), an in-memory object store, real Pillow. The file transforms
themselves are tested in test_media_sanitize.py.
"""

import io
import logging
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from arq import Retry
from arq.worker import Function
from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import (
    PresignedUpload,
    StorageObjectMissingError,
    StorageUnavailableError,
)
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.media.sanitize import SanitizeConfig
from app.modules.requests.media_copies import MediaCopier, MediaCopyConfig, MediaCopyOutcome
from app.modules.requests.models import (
    MediaSafeStatus,
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    ServiceRequest,
)
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES, sanitize_request_media
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.worker import WorkerSettings
from tests.conftest import make_settings
from tests.test_dispatch import sessions_of
from tests.test_schema_requests_jobs import add

SAFE_KEY = re.compile(r"^m/[0-9a-f]{32}\.(jpg|png|webp|mp4|mov)$")
MAX_TRIES = 3


@dataclass
class MemoryStorage:
    """The storage port in memory: objects by key, every upload recorded."""

    objects: dict[str, bytes] = field(default_factory=dict)
    uploads: list[tuple[str, str]] = field(default_factory=list)
    unavailable: bool = False
    broken: set[str] = field(default_factory=set)  # keys whose download hits a bug

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - the worker never presigns
        raise AssertionError("the worker never presigns")

    def presign_get(self, key: str, expires_in: int) -> str:  # pragma: no cover
        raise AssertionError("the worker never presigns")

    def download_to(self, key: str, path: Path) -> None:
        if self.unavailable:
            raise StorageUnavailableError("download failed: test")
        if key in self.broken:
            raise RuntimeError(f"unexpected failure for {key}")
        if key not in self.objects:
            raise StorageObjectMissingError("no object at this key")
        path.write_bytes(self.objects[key])

    def upload_from(self, path: Path, key: str, content_type: str) -> None:
        if self.unavailable:
            raise StorageUnavailableError("upload failed: test")
        self.objects[key] = path.read_bytes()
        self.uploads.append((key, content_type))


@dataclass(frozen=True)
class Media:
    customer_id: uuid.UUID
    request_id: uuid.UUID
    media_id: uuid.UUID
    file_key: str


def gps_jpeg(size: tuple[int, int] = (24, 12)) -> bytes:
    exif = Image.Exif()
    exif[0x013B] = "Jane Customer"
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2] = "N", (25.0, 45.0, 42.0)
    buffer = io.BytesIO()
    Image.new("RGB", size, "red").save(buffer, "JPEG", exif=exif)
    return buffer.getvalue()


async def make_media(
    session: AsyncSession, storage: MemoryStorage, content: bytes | None, extension: str = ".jpg"
) -> Media:
    """A request with one photo; the original is in `storage` unless `content` is None."""
    tag = uuid.uuid4().hex[:8]
    customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
    category = Category(slug=f"media-{tag}", names={"en": "Test", "es": "Prueba"})
    await add(session, customer, category)
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    await add(session, address)
    request = ServiceRequest(
        customer_id=customer.id,
        category_id=category.id,
        address_id=address.id,
        description="Fix a leak",
        origin=RequestOrigin.APP,
    )
    await add(session, request)
    file_key = f"u/{customer.id}/request_media/{uuid.uuid4().hex}{extension}"
    media = RequestMedia(request_id=request.id, kind=RequestMediaKind.PHOTO, file_key=file_key)
    await add(session, media)
    if content is not None:
        storage.objects[file_key] = content
    return Media(customer.id, request.id, media.id, file_key)


def copier(
    session: AsyncSession, storage: MemoryStorage, max_image_pixels: int = 1_000_000
) -> MediaCopier:
    sanitize = SanitizeConfig(max_image_pixels, 85, "ffmpeg", 60)
    return MediaCopier(sessions_of(session), storage, MediaCopyConfig(MAX_TRIES, sanitize))


async def row(session: AsyncSession, media_id: uuid.UUID) -> RequestMedia:
    statement = (
        select(RequestMedia)
        .where(RequestMedia.id == media_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


@pytest.fixture
def storage() -> MemoryStorage:
    return MemoryStorage()


async def test_a_pending_photo_gets_a_safe_copy(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())

    outcome = await copier(db_session, storage).copy_request_media(media.request_id, attempt=1)

    assert (outcome.ready, outcome.failed, outcome.waiting) == (1, 0, 0)
    saved = await row(db_session, media.media_id)
    assert saved.safe_status == MediaSafeStatus.READY
    assert saved.safe_content_type == "image/jpeg"
    assert saved.file_key == media.file_key  # the original stays for the customer
    [(key, content_type)] = storage.uploads
    assert (key, content_type) == (saved.safe_key, "image/jpeg")
    copy = Image.open(io.BytesIO(storage.objects[key]))
    assert dict(copy.getexif()) == {}
    assert b"Jane Customer" not in storage.objects[key]


async def test_safe_key_is_opaque(db_session: AsyncSession, storage: MemoryStorage) -> None:
    media = await make_media(db_session, storage, gps_jpeg())

    await copier(db_session, storage).copy_request_media(media.request_id, attempt=1)

    safe_key = (await row(db_session, media.media_id)).safe_key
    assert safe_key is not None
    assert SAFE_KEY.fullmatch(safe_key)
    assert str(media.customer_id) not in safe_key
    assert media.customer_id.hex not in safe_key
    assert "request_media" not in safe_key


async def test_rerun_skips_ready_rows_no_second_copy(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())
    jobs = copier(db_session, storage)

    await jobs.copy_request_media(media.request_id, attempt=1)
    first = (await row(db_session, media.media_id)).safe_key
    again = await jobs.copy_request_media(media.request_id, attempt=1)

    assert (again.ready, again.failed, again.waiting) == (0, 0, 0)
    assert len(storage.uploads) == 1
    assert (await row(db_session, media.media_id)).safe_key == first


async def test_missing_object_retries_then_fails(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, content=None)  # never uploaded
    jobs = copier(db_session, storage)

    for attempt in range(1, MAX_TRIES):
        outcome = await jobs.copy_request_media(media.request_id, attempt=attempt)
        assert (outcome.waiting, outcome.failed) == (1, 0)
        assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.PENDING
    last = await jobs.copy_request_media(media.request_id, attempt=MAX_TRIES)

    assert (last.waiting, last.failed) == (0, 1)
    saved = await row(db_session, media.media_id)
    assert (saved.safe_status, saved.safe_key) == (MediaSafeStatus.FAILED, None)
    assert storage.uploads == []


async def test_an_unavailable_storage_retries(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())
    storage.unavailable = True

    outcome = await copier(db_session, storage).copy_request_media(media.request_id, attempt=1)

    assert outcome.waiting == 1
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.PENDING


async def test_decompression_bomb_fails_and_is_never_ready(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, gps_jpeg(size=(200, 100)))
    jobs = copier(db_session, storage, max_image_pixels=1_000)  # 20 000 pixels is too many

    outcome = await jobs.copy_request_media(media.request_id, attempt=1)
    again = await jobs.copy_request_media(media.request_id, attempt=1)

    assert (outcome.failed, again.failed, again.ready) == (1, 0, 0)  # settled: never retried
    saved = await row(db_session, media.media_id)
    assert (saved.safe_status, saved.safe_key) == (MediaSafeStatus.FAILED, None)
    assert storage.uploads == []


async def test_wrong_type_bytes_fail(db_session: AsyncSession, storage: MemoryStorage) -> None:
    media = await make_media(db_session, storage, b"this is text, not a JPEG")

    outcome = await copier(db_session, storage).copy_request_media(media.request_id, attempt=1)

    assert outcome.failed == 1
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.FAILED


async def test_logs_have_no_keys_or_paths(
    db_session: AsyncSession, storage: MemoryStorage, caplog: pytest.LogCaptureFixture
) -> None:
    ready = await make_media(db_session, storage, gps_jpeg())
    broken = await make_media(db_session, storage, b"not an image")
    missing = await make_media(db_session, storage, content=None)

    with caplog.at_level(logging.DEBUG):
        for media in (ready, broken, missing):
            await copier(db_session, storage).copy_request_media(media.request_id, attempt=1)

    messages = {record.getMessage() for record in caplog.records}
    assert {"media_sanitized", "media_sanitize_failed", "media_sanitize_retry"} <= messages
    [failure] = [r for r in caplog.records if r.getMessage() == "media_sanitize_failed"]
    assert (failure.__dict__["media_id"], failure.__dict__["reason"]) == (
        str(broken.media_id),
        "unreadable",
    )
    logged = caplog.text + "".join(str(vars(record)) for record in caplog.records)
    safe_key = (await row(db_session, ready.media_id)).safe_key
    assert safe_key is not None
    for secret in (
        *(m.file_key for m in (ready, broken, missing)),
        *(str(m.customer_id) for m in (ready, broken, missing)),
        safe_key,
        "media-copy-",  # the temporary directory's name
        "u/",
    ):
        assert secret not in logged, secret


async def test_an_unexpected_error_on_one_row_never_stops_the_others(
    db_session: AsyncSession, storage: MemoryStorage, caplog: pytest.LogCaptureFixture
) -> None:
    broken = await make_media(db_session, storage, gps_jpeg())
    storage.broken.add(broken.file_key)
    second = RequestMedia(
        request_id=broken.request_id,
        kind=RequestMediaKind.PHOTO,
        file_key=f"u/{broken.customer_id}/request_media/{uuid.uuid4().hex}.jpg",
    )
    await add(db_session, second)
    storage.objects[second.file_key] = gps_jpeg()
    jobs = copier(db_session, storage)

    with caplog.at_level(logging.WARNING):
        first = await jobs.copy_request_media(broken.request_id, attempt=1)
    last = await jobs.copy_request_media(broken.request_id, attempt=MAX_TRIES)

    assert (first.ready, first.waiting) == (1, 1)
    assert (await row(db_session, second.id)).safe_status == MediaSafeStatus.READY
    assert last.failed == 1
    assert (await row(db_session, broken.media_id)).safe_status == MediaSafeStatus.FAILED
    [retry] = [r for r in caplog.records if r.getMessage() == "media_sanitize_retry"]
    assert (retry.__dict__["reason"], retry.__dict__["error_class"]) == ("internal", "RuntimeError")
    assert broken.file_key not in caplog.text


# The ARQ task and its registration


def ctx(session: AsyncSession, storage: MemoryStorage | None, job_try: int) -> dict[str, object]:
    settings: Settings = make_settings(media_sanitize_max_tries=MAX_TRIES)
    return {
        "settings": settings,
        "session_factory": sessions_of(session),
        "storage": storage,
        "job_try": job_try,
    }


async def test_the_task_asks_for_a_retry_while_a_copy_waits(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, content=None)

    with pytest.raises(Retry):
        await sanitize_request_media(ctx(db_session, storage, 1), str(media.request_id))
    outcome = await sanitize_request_media(
        ctx(db_session, storage, MAX_TRIES), str(media.request_id)
    )

    assert outcome == "ready=0 failed=1 waiting=0 deferred=0"


async def test_the_task_leaves_rows_pending_without_storage(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())

    outcome = await sanitize_request_media(ctx(db_session, None, 1), str(media.request_id))

    assert outcome == "storage_unconfigured"
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.PENDING


def test_worker_registers_the_task_with_its_tries_and_no_kept_result() -> None:
    [task] = [
        f
        for f in WorkerSettings.functions
        if isinstance(f, Function) and f.name == "sanitize_request_media"
    ]

    assert isinstance(task, Function)
    settings = make_settings()
    assert task.max_tries == settings.media_sanitize_max_tries + SANITIZE_SPARE_TRIES
    assert task.timeout_s == settings.media_sanitize_job_timeout_seconds
    assert task.keep_result_s == 0


# Second review (#173): a try that runs out of time, errors outside one file's copy.


class ManualClock:
    """Time moves only when a test (or a fake storage) moves it."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@dataclass
class SlowStorage(MemoryStorage):
    """Each download moves `clock` on by `seconds`: a file that takes that long to fetch."""

    clock: ManualClock = field(default_factory=ManualClock)
    seconds: float = 0.0

    def download_to(self, key: str, path: Path) -> None:
        self.clock.now += self.seconds
        super().download_to(key, path)


async def make_two_photos(session: AsyncSession, storage: MemoryStorage) -> tuple[Media, uuid.UUID]:
    media = await make_media(session, storage, gps_jpeg())
    second = RequestMedia(
        request_id=media.request_id,
        kind=RequestMediaKind.PHOTO,
        file_key=f"u/{media.customer_id}/request_media/{uuid.uuid4().hex}.jpg",
    )
    await add(session, second)
    storage.objects[second.file_key] = gps_jpeg()
    return media, second.id


def short_copier(session: AsyncSession, storage: MemoryStorage) -> MediaCopier:
    # A try of 25 s and 10 s per file: after a download of 20 s, the second file has no time.
    sanitize = SanitizeConfig(1_000_000, 85, "ffmpeg", 60)
    config = MediaCopyConfig(MAX_TRIES, sanitize, job_budget_seconds=25, row_budget_seconds=10)
    return MediaCopier(sessions_of(session), storage, config)


@pytest.fixture
def slow_storage() -> SlowStorage:
    return SlowStorage(seconds=20)


async def test_a_try_out_of_time_defers_the_rest_to_the_next(
    db_session: AsyncSession, slow_storage: SlowStorage
) -> None:
    media, second = await make_two_photos(db_session, slow_storage)
    jobs = short_copier(db_session, slow_storage)
    clock = slow_storage.clock

    first = await jobs.copy_request_media(media.request_id, attempt=1, clock=clock)
    then = await jobs.copy_request_media(media.request_id, attempt=2, clock=clock)

    assert (first.ready, first.deferred) == (1, 1)
    assert (then.ready, then.deferred) == (1, 0)
    assert (await row(db_session, second)).safe_status == MediaSafeStatus.READY


async def test_the_final_try_fails_what_it_has_no_time_for(
    db_session: AsyncSession, slow_storage: SlowStorage
) -> None:
    media, second = await make_two_photos(db_session, slow_storage)

    outcome = await short_copier(db_session, slow_storage).copy_request_media(
        media.request_id, attempt=MAX_TRIES + 2, final=True, clock=slow_storage.clock
    )

    assert (outcome.ready, outcome.failed, outcome.deferred) == (1, 1, 0)
    statuses = {(await row(db_session, i)).safe_status for i in (media.media_id, second)}
    assert statuses == {MediaSafeStatus.READY, MediaSafeStatus.FAILED}  # either may come first


async def test_a_failure_while_failing_a_row_leaves_it_waiting(
    db_session: AsyncSession, storage: MemoryStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())
    storage.broken.add(media.file_key)
    jobs = copier(db_session, storage)

    async def database_down(*args: object, **kwargs: object) -> None:
        raise ConnectionRefusedError("database restarting")

    monkeypatch.setattr(jobs, "_fail", database_down)

    outcome = await jobs.copy_request_media(media.request_id, attempt=MAX_TRIES)

    assert (outcome.waiting, outcome.failed) == (1, 0)
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.PENDING


@pytest.mark.parametrize(
    "error", [OperationalError("SELECT", {}, Exception("down")), OSError("down")]
)
async def test_the_task_retries_a_database_or_network_failure(
    db_session: AsyncSession,
    storage: MemoryStorage,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())

    async def failing(*args: object, **kwargs: object) -> None:
        raise error

    monkeypatch.setattr(MediaCopier, "copy_request_media", failing)

    with caplog.at_level(logging.WARNING), pytest.raises(Retry):
        await sanitize_request_media(ctx(db_session, storage, 1), str(media.request_id))
    [record] = [r for r in caplog.records if r.getMessage() == "media_sanitize_retry"]
    assert record.__dict__["error_class"] == type(error).__name__
    assert "down" not in caplog.text


async def test_the_task_asks_for_a_retry_while_files_are_deferred(
    db_session: AsyncSession, storage: MemoryStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())

    async def deferring(*args: object, **kwargs: object) -> MediaCopyOutcome:
        return MediaCopyOutcome(deferred=1)

    monkeypatch.setattr(MediaCopier, "copy_request_media", deferring)

    with pytest.raises(Retry):
        await sanitize_request_media(ctx(db_session, storage, 1), str(media.request_id))


def test_the_job_timeout_must_cover_one_file() -> None:
    with pytest.raises(ValueError, match="MEDIA_SANITIZE_JOB_TIMEOUT_SECONDS"):
        make_settings(media_sanitize_timeout_seconds=120, media_sanitize_job_timeout_seconds=300)
