"""A sanitize try ends itself before ARQ's timeout, and accepted settings start a file (#173).

ARQ ends a job that reaches its timeout for good: no retry, and the rows would stay pending.
So these tests run the real ARQ worker on the real Redis of REDIS_URL (a private queue, its keys
deleted afterwards) with the task as app/worker.py registers it, against a storage that hangs
like a dead connection. Real database (rolled back), real Pillow.
"""

import asyncio
import logging
import threading
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from arq.connections import ArqRedis
from arq.worker import Worker
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.media import sanitize as sanitize_module
from app.modules.media.sanitize import SafeFile, SanitizeConfig
from app.modules.requests.media_copies import (
    MediaCopier,
    MediaCopyConfig,
    sanitize_job_id,
)
from app.modules.requests.models import MediaSafeStatus, RequestMedia, RequestMediaKind
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES, sanitize_task
from tests.conftest import make_settings
from tests.test_dispatch import sessions_of
from tests.test_media_copies import Media, MemoryStorage, gps_jpeg, make_media, row
from tests.test_schema_requests_jobs import add

# Steps of 0.1 s and a job of 2 s: one file's budget is 6 x 0.1 + 0.2 (its write) = 0.8 s, and
# the job needs 0.2 (the query) + 0.8 + 0.5 (the settle reserve) = 1.5 s at least.
FAST: dict[str, object] = {
    "media_sanitize_timeout_seconds": 0.1,
    "media_sanitize_overhead_seconds": 0.2,
    "media_sanitize_settle_seconds": 0.5,
    "media_sanitize_job_timeout_seconds": 2,
    "media_sanitize_max_tries": 2,
    "media_sanitize_retry_seconds": 1,
}


class StalledStorage(MemoryStorage):
    """A transfer at `stage` hangs until `release` is set, as on a dead connection. Then its
    thread does the transfer's work after all, writing or reading its file, and records how
    that went: a thread must never find its file removed under it."""

    def __init__(self, stage: str) -> None:
        super().__init__()
        self.stage = stage
        self.release = threading.Event()
        self.files: list[Path] = []
        self.finished: list[str] = []

    def _stall(self, path: Path, work: Callable[[], object]) -> None:
        self.files.append(path)
        self.release.wait()
        try:
            work()
        except OSError as error:
            self.finished.append(type(error).__name__)
        else:
            self.finished.append("ok")

    def download_to(self, key: str, path: Path) -> None:
        if self.stage != "download":
            return super().download_to(key, path)
        self._stall(path, lambda: path.write_bytes(self.objects[key]))

    def upload_from(self, path: Path, key: str, content_type: str) -> None:
        if self.stage != "upload":
            return super().upload_from(path, key, content_type)

        def read() -> None:
            path.read_bytes()

        self._stall(path, read)


@pytest.fixture
def released() -> Iterator[list[StalledStorage]]:
    """Every stalled storage of the test, released at its end so no thread outlives it."""
    storages: list[StalledStorage] = []
    yield storages
    for storage in storages:
        storage.release.set()


def stalled(released: list[StalledStorage], stage: str) -> StalledStorage:
    storage = StalledStorage(stage)
    released.append(storage)
    return storage


async def more_photos(
    session: AsyncSession, storage: MemoryStorage, media: Media, count: int
) -> None:
    for _ in range(count):
        extra = RequestMedia(
            request_id=media.request_id,
            kind=RequestMediaKind.PHOTO,
            file_key=f"u/{media.customer_id}/request_media/{uuid.uuid4().hex}.jpg",
        )
        await add(session, extra)
        storage.objects[extra.file_key] = gps_jpeg()


async def statuses(session: AsyncSession, request_id: uuid.UUID) -> list[MediaSafeStatus]:
    statement = (
        select(RequestMedia.safe_status)
        .where(RequestMedia.request_id == request_id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def eventually(check: Callable[[], bool], seconds: float = 5) -> None:
    async with asyncio.timeout(seconds):
        # A thread changes the state, not a coroutine: there is no asyncio event to wait on.
        while not check():  # noqa: ASYNC110
            await asyncio.sleep(0.01)


# The real worker


@asynccontextmanager
async def worker_for(
    session: AsyncSession, settings: Settings, storage: MemoryStorage, request_id: uuid.UUID
) -> AsyncIterator[tuple[Worker, ArqRedis]]:
    """A burst worker on a private queue, with sanitize_request_media as app/worker.py
    registers it. It runs until no job is left, deferred retries included. The request's job
    keys and the queue are deleted afterwards."""
    redis = ArqRedis.from_url(Settings().redis_url)
    redis.default_queue_name = f"test-media-{uuid.uuid4().hex}"
    worker = Worker(
        functions=[sanitize_task(settings)],
        redis_pool=redis,
        queue_name=redis.default_queue_name,
        ctx={"settings": settings, "storage": storage, "session_factory": sessions_of(session)},
        burst=True,
        max_jobs=1,
        handle_signals=False,
        poll_delay=0.01,
    )
    try:
        yield worker, redis
    finally:
        job_id = sanitize_job_id(request_id)
        keys = [f"arq:{kind}:{job_id}" for kind in ("job", "retry", "in-progress", "result")]
        await redis.delete(redis.default_queue_name, worker.health_check_key, *keys)
        await redis.aclose()


async def run_job(
    worker: Worker, redis: ArqRedis, request_id: uuid.UUID, job_try: int | None = None
) -> bool:
    """Runs the request's sanitize job to its end; whether it is still queued after."""
    job_id = sanitize_job_id(request_id)
    await redis.enqueue_job(
        "sanitize_request_media", str(request_id), _job_id=job_id, _job_try=job_try
    )
    async with asyncio.timeout(15):
        await worker.async_run()
    return await redis.zscore(redis.default_queue_name, job_id) is not None


@pytest.mark.parametrize("stage", ["download", "upload"])
async def test_a_stalled_transfer_is_retried_then_failed_never_left_pending(
    db_session: AsyncSession, released: list[StalledStorage], stage: str
) -> None:
    storage = stalled(released, stage)
    media = await make_media(db_session, storage, gps_jpeg())
    settings = make_settings(**FAST)

    async with worker_for(db_session, settings, storage, media.request_id) as (worker, redis):
        queued = await run_job(worker, redis, media.request_id)

    # Try 1 waits on the step's timeout and asks for a retry; try 2 (MEDIA_SANITIZE_MAX_TRIES)
    # fails the row. ARQ's own timeout never ends a try.
    assert (worker.jobs_retried, worker.jobs_failed, worker.jobs_complete) == (1, 0, 1)
    assert not queued
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.FAILED
    assert len(storage.files) == settings.media_sanitize_max_tries


async def test_a_stall_on_the_last_try_still_settles_every_row(
    db_session: AsyncSession, released: list[StalledStorage], caplog: pytest.LogCaptureFixture
) -> None:
    # Ten stalled photos: the try can attempt some, has no time left for the rest, and must
    # fail them all before ARQ's timeout.
    storage = stalled(released, "download")
    media = await make_media(db_session, storage, gps_jpeg())
    await more_photos(db_session, storage, media, 9)
    settings = make_settings(**FAST)
    final = settings.media_sanitize_max_tries + SANITIZE_SPARE_TRIES

    with caplog.at_level(logging.INFO):
        async with worker_for(db_session, settings, storage, media.request_id) as (worker, redis):
            queued = await run_job(worker, redis, media.request_id, job_try=final)

    assert (worker.jobs_retried, worker.jobs_failed, worker.jobs_complete) == (0, 0, 1)
    assert not queued
    assert await statuses(db_session, media.request_id) == [MediaSafeStatus.FAILED] * 10
    attempted = len(storage.files)
    assert 0 < attempted < 10  # the rest had no time: failed in the settlement
    failures = [r for r in caplog.records if r.getMessage() == "media_sanitize_failed"]
    assert len(failures) == 10
    assert {r.__dict__["reason"] for r in failures} == {"timeout"}


async def test_files_without_time_are_deferred_and_the_next_try_goes_on(
    db_session: AsyncSession,
) -> None:
    # Steps of 0.25 s: a file's budget is 1.7 s, so of the 2.5 s of work in a 3 s job, 0.8 s
    # may start files. Downloads of 0.12 s (half a step) fit about six; the rest go on in the
    # next try, through ARQ's retry.
    class SlowDownloads(MemoryStorage):
        def download_to(self, key: str, path: Path) -> None:
            threading.Event().wait(0.12)
            super().download_to(key, path)

    storage = SlowDownloads()
    media = await make_media(db_session, storage, gps_jpeg())
    await more_photos(db_session, storage, media, 9)
    settings = make_settings(
        **{
            **FAST,
            "media_sanitize_timeout_seconds": 0.25,
            "media_sanitize_job_timeout_seconds": 3,
            "media_sanitize_max_tries": 5,
        }
    )

    async with worker_for(db_session, settings, storage, media.request_id) as (worker, redis):
        queued = await run_job(worker, redis, media.request_id)

    assert worker.jobs_retried >= 1
    assert (worker.jobs_failed, worker.jobs_complete) == (0, 1)
    assert not queued
    assert await statuses(db_session, media.request_id) == [MediaSafeStatus.READY] * 10


# One try, on a clock the test moves


class JumpClock:
    """Reads `before` until `reads` reads were made, then `after`: time that passed at once."""

    def __init__(self, reads: int, before: float, after: float) -> None:
        self.reads, self.before, self.after = reads, before, after

    def __call__(self) -> float:
        self.reads -= 1
        return self.before if self.reads >= 0 else self.after


def fast_copier(session: AsyncSession, storage: MemoryStorage, settings: Settings) -> MediaCopier:
    return MediaCopier(sessions_of(session), storage, MediaCopyConfig.from_settings(settings))


@pytest.mark.parametrize("final", [False, True])
async def test_the_deadline_cuts_a_running_step(
    db_session: AsyncSession, released: list[StalledStorage], final: bool
) -> None:
    # The try starts and queries at 0 s; when the download starts, 1.45 s have passed: 0.05 s
    # of work is left, less than the step's 0.1 s. The deadline cuts the stalled download.
    storage = stalled(released, "download")
    media = await make_media(db_session, storage, gps_jpeg())
    settings = make_settings(**FAST)
    clock = JumpClock(reads=2, before=0.0, after=1.45)

    outcome = await fast_copier(db_session, storage, settings).copy_request_media(
        media.request_id, attempt=1, final=final, clock=clock
    )

    expected = MediaSafeStatus.FAILED if final else MediaSafeStatus.PENDING
    assert (outcome.deferred, outcome.failed) == ((0, 1) if final else (1, 0))
    assert (await row(db_session, media.media_id)).safe_status == expected


async def test_the_accepted_minimum_budget_copies_a_file(db_session: AsyncSession) -> None:
    # The Gatekeeper's case: accepted settings at their lowest, a pending-row query of 1 ms.
    storage = MemoryStorage()
    media = await make_media(db_session, storage, gps_jpeg())
    settings = make_settings(
        media_sanitize_timeout_seconds=120,
        media_sanitize_overhead_seconds=30,
        media_sanitize_settle_seconds=60,
        media_sanitize_job_timeout_seconds=840,
    )
    assert settings.media_sanitize_min_job_seconds == 840

    outcome = await fast_copier(db_session, storage, settings).copy_request_media(
        media.request_id, attempt=1, clock=JumpClock(reads=1, before=0.0, after=0.001)
    )

    assert (outcome.ready, outcome.deferred) == (1, 0)
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.READY
    assert len(storage.uploads) == 1


async def test_a_file_starts_on_the_terms_the_settings_check(db_session: AsyncSession) -> None:
    # The same lowest settings, and a query that took its whole allowance (30 s): exactly one
    # file's budget is left, so a second file still starts. Validation and admission agree.
    storage = MemoryStorage()
    media = await make_media(db_session, storage, gps_jpeg())
    await more_photos(db_session, storage, media, 1)
    settings = make_settings(
        media_sanitize_timeout_seconds=120,
        media_sanitize_overhead_seconds=30,
        media_sanitize_settle_seconds=60,
        media_sanitize_job_timeout_seconds=840,
    )

    outcome = await fast_copier(db_session, storage, settings).copy_request_media(
        media.request_id, attempt=1, clock=JumpClock(reads=2, before=0.0, after=30.0)
    )

    assert (outcome.ready, outcome.deferred) == (2, 0)


def test_the_job_timeout_must_cover_the_query_one_file_and_the_reserve() -> None:
    lowest = {
        "media_sanitize_timeout_seconds": 120,
        "media_sanitize_overhead_seconds": 30,
        "media_sanitize_settle_seconds": 60,
    }
    make_settings(**lowest, media_sanitize_job_timeout_seconds=840)
    with pytest.raises(ValueError, match="MEDIA_SANITIZE_JOB_TIMEOUT_SECONDS"):
        make_settings(**lowest, media_sanitize_job_timeout_seconds=839)


def test_the_settle_reserve_must_outlast_one_database_step() -> None:
    with pytest.raises(ValueError, match="MEDIA_SANITIZE_SETTLE_SECONDS"):
        make_settings(media_sanitize_overhead_seconds=30, media_sanitize_settle_seconds=30)


# A thread a timeout left behind


@pytest.mark.parametrize("stage", ["download", "upload"])
async def test_a_stalled_transfer_keeps_its_files_until_its_thread_ends(
    db_session: AsyncSession, released: list[StalledStorage], stage: str
) -> None:
    storage = stalled(released, stage)
    media = await make_media(db_session, storage, gps_jpeg())
    sanitize = SanitizeConfig(1_000_000, 85, "ffmpeg", 0.1)
    jobs = MediaCopier(sessions_of(db_session), storage, MediaCopyConfig(3, sanitize))

    outcome = await jobs.copy_request_media(media.request_id, attempt=1)

    assert outcome.waiting == 1  # the step timed out; the row waits for the next try
    [path] = storage.files
    assert path.parent.is_dir()  # the row is over, but its thread still runs
    storage.release.set()
    await eventually(lambda: not path.parent.exists())
    assert storage.finished == ["ok"]  # the thread's late write or read met its file


async def test_a_slow_image_transform_times_out_and_keeps_its_files(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    storage = MemoryStorage()
    media = await make_media(db_session, storage, gps_jpeg())
    release = threading.Event()
    finished: list[str] = []
    workdirs: list[Path] = []
    real = sanitize_module.sanitize_image

    def slow_image(
        source: Path, content_type: str, workdir: Path, config: SanitizeConfig
    ) -> SafeFile:
        workdirs.append(workdir)
        release.wait()
        try:
            return real(source, content_type, workdir, config)
        finally:
            finished.append("ok" if (workdir / "safe.jpg").exists() else "no file")

    monkeypatch.setattr(sanitize_module, "sanitize_image", slow_image)
    sanitize = SanitizeConfig(1_000_000, 85, "ffmpeg", 0.1)
    jobs = MediaCopier(sessions_of(db_session), storage, MediaCopyConfig(3, sanitize))

    try:
        with caplog.at_level(logging.WARNING):
            outcome = await jobs.copy_request_media(media.request_id, attempt=1)
        [workdir] = workdirs
        assert workdir.is_dir()
    finally:
        release.set()

    assert outcome.waiting == 1
    [retry] = [r for r in caplog.records if r.getMessage() == "media_sanitize_retry"]
    assert retry.__dict__["reason"] == "timeout"
    await eventually(lambda: not workdir.exists())
    assert finished == ["ok"]
    assert storage.uploads == []  # the late copy is never uploaded
