"""Safe copies an outage left pending (#473), and one copy per row at a time with fair sweeps
(#491 round 1): the copier postpones a row instead of failing it when the storage outlasted its
tries, claims each row before it copies it, and the worker's sweep queues the copy again, one
photo at a time, leaving rows another run holds and reaching rows behind postponed ones.

The copier runs on the rolled-back test session with the storage in memory
(tests/test_media_copies.py); the claims and the sweep's history are in memory too
(MemoryStore, which trims its history by its keep as Redis does, with no wall clock), except
for the Redis store's own test; the sweep's queue records what it queued."""

import asyncio
import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.disputes.models import Dispute, DisputePhoto, DisputeReason
from app.modules.jobs.models import JobPhoto, JobPhotoKind, JobStatus
from app.modules.media.copy_store import RedisMediaCopyStore, row_key
from app.modules.media.resweep import requeue_stale_media_copies
from app.modules.requests.media_copies import (
    REQUEST_MEDIA_ROWS,
    MediaCopier,
    MediaCopyConfig,
    sanitize_job_id,
)
from app.modules.requests.models import MediaSafeStatus, RequestMedia
from app.modules.requests.tasks import sanitize_request_media
from tests.conftest import make_settings
from tests.job_world import build_world, make_job
from tests.test_dispatch import sessions_of
from tests.test_disputes_api import RecordingQueue
from tests.test_media_copies import (
    MAX_TRIES,
    MemoryStorage,
    SlowStorage,
    copier,
    ctx,
    gps_jpeg,
    make_media,
    make_two_photos,
    row,
    short_copier,
)

AFTER = timedelta(minutes=60)
KIND = REQUEST_MEDIA_ROWS.parent_field


@dataclass
class MemoryStore:
    """The rows' claims and the sweep's history, in memory, as RedisMediaCopyStore keeps
    them: each kind's last-queued times, trimmed to the keep on every write. `skew` records
    every write that many seconds late (a sweep slow between choosing and recording)."""

    claims: dict[str, str] = field(default_factory=dict)
    queued: dict[str, dict[str, float]] = field(default_factory=dict)
    skew: float = 0.0
    claimed: list[str] = field(default_factory=list)

    async def claim(self, key: str) -> str | None:
        if key in self.claims:
            return None
        token = uuid.uuid4().hex
        self.claims[key] = token
        self.claimed.append(key)
        return token

    async def release(self, key: str, token: str) -> None:
        if self.claims.get(key) == token:
            del self.claims[key]

    async def held(self, keys: Any) -> set[str]:
        return {key for key in keys if key in self.claims}

    async def last_queued(self, kind: str, keys: Any) -> dict[str, float]:
        history = self.queued.get(kind, {})
        return {key: history[key] for key in keys if key in history}

    async def record_queued(self, kind: str, keys: Any, at: float, keep_seconds: int) -> None:
        history = self.queued.setdefault(kind, {})
        for key in keys:
            history[key] = at + self.skew
        for key in [key for key, when in history.items() if when < at - keep_seconds]:
            del history[key]


@pytest.fixture
def storage() -> MemoryStorage:
    return MemoryStorage()


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


def sweep_ctx(
    session: AsyncSession, queue: Any, store: MemoryStore, **settings: object
) -> dict[str, Any]:
    return {
        "session_factory": sessions_of(session),
        "settings": make_settings(
            media_sanitize_resweep_after_minutes=int(AFTER.total_seconds() // 60), **settings
        ),
        "redis": queue,
        "media_copy_store": store,
    }


def later() -> datetime:
    """A clock past the sweep's wait for anything attached now."""
    return datetime.now(UTC) + AFTER + timedelta(minutes=5)


async def attached_earlier(session: AsyncSession, media: Any) -> None:
    """The media row an hour older than the others: rows made in one test transaction share
    their created_at, and the sweep reads the oldest first."""
    await session.execute(
        update(RequestMedia)
        .where(RequestMedia.id == media.media_id)
        .values(created_at=datetime.now(UTC) - timedelta(hours=1))
    )
    await session.commit()


def claiming(session: AsyncSession, storage: MemoryStorage, store: MemoryStore) -> MediaCopier:
    """The test copier with the claims in `store`."""
    base = copier(session, storage)
    return MediaCopier(sessions_of(session), storage, base._config, store=store)


# --- #473: an outage postpones the row; the sweep queues it again ------------------------------


async def test_an_outage_that_outlasts_the_tries_postpones_the_row_and_the_sweep_copies_it(
    db_session: AsyncSession,
    storage: MemoryStorage,
    store: MemoryStore,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The storage is down for every try: the last one leaves the photo pending (an ERROR for
    staff), never failed. Once the storage is back the sweep queues its copy, and the copy is
    made: the pro gets the photo after all."""
    media = await make_media(db_session, storage, gps_jpeg())
    storage.unavailable = True
    jobs = claiming(db_session, storage, store)
    for attempt in range(1, MAX_TRIES):
        assert (await jobs.copy_pending(media.request_id, attempt=attempt)).waiting == 1

    with caplog.at_level(logging.INFO):
        last = await jobs.copy_pending(media.request_id, attempt=MAX_TRIES)

    assert (last.postponed, last.failed, last.waiting) == (1, 0, 0)
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.PENDING
    [postponed] = [r for r in caplog.records if r.getMessage() == "media_sanitize_postponed"]
    assert (postponed.levelno, postponed.__dict__["reason"]) == (
        logging.ERROR,
        "storage_unavailable",
    )
    assert "media_sanitize_failed" not in [r.getMessage() for r in caplog.records]
    assert store.claims == {}  # released after every try

    storage.unavailable = False
    queue = RecordingQueue()
    await requeue_stale_media_copies(sweep_ctx(db_session, queue, store), clock=later)

    assert queue.jobs == {
        sanitize_job_id(media.request_id): ("sanitize_request_media", (str(media.request_id),))
    }
    await sanitize_request_media(
        {**ctx(db_session, storage, 1), "media_copy_store": store}, str(media.request_id)
    )
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.READY


async def test_the_task_s_last_try_postpones_without_asking_for_a_retry(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    media = await make_media(db_session, storage, gps_jpeg())
    storage.unavailable = True

    outcome = await sanitize_request_media(
        ctx(db_session, storage, MAX_TRIES + 1), str(media.request_id)
    )

    assert outcome.endswith("postponed=1")
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.PENDING


async def test_a_file_s_own_fault_still_fails_and_is_never_queued_again(
    db_session: AsyncSession, storage: MemoryStorage, store: MemoryStore
) -> None:
    """A missing original is the file's fault, not an outage: it fails at the last try as
    before, and the sweep leaves a failed row alone."""
    media = await make_media(db_session, storage, content=None)
    jobs = copier(db_session, storage)
    for attempt in range(1, MAX_TRIES + 1):
        await jobs.copy_pending(media.request_id, attempt=attempt)
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.FAILED
    queue = RecordingQueue()

    await requeue_stale_media_copies(sweep_ctx(db_session, queue, store), clock=later)

    assert queue.jobs == {}


async def photos_of_a_job_and_a_dispute(
    session: AsyncSession,
) -> tuple[uuid.UUID, list[JobPhoto], uuid.UUID, DisputePhoto]:
    """A disputed job with two pending photos, and its dispute with one, committed."""
    world = await build_world(session)
    job = await make_job(session, world, JobStatus.DISPUTED)
    photos = [
        JobPhoto(
            job_id=job.id,
            kind=JobPhotoKind.AFTER,
            file_key=f"u/{world.pro.id}/job_photo/{uuid.uuid4().hex}.jpg",
            uploaded_by=world.pro.id,
        )
        for _ in range(2)
    ]
    session.add_all(photos)
    await session.flush()
    dispute = Dispute(
        job_id=job.id,
        opened_by=world.customer.id,
        reason_code=DisputeReason.DAMAGE,
        description="zq473 a dent",
    )
    session.add(dispute)
    await session.flush()
    dispute_photo = DisputePhoto(
        dispute_id=dispute.id,
        file_key=f"u/{world.customer.id}/dispute_photo/{uuid.uuid4().hex}.jpg",
        uploaded_by=world.customer.id,
    )
    session.add(dispute_photo)
    await session.commit()
    ordered = sorted(photos, key=lambda photo: (photo.created_at, photo.id))
    return job.id, ordered, dispute.id, dispute_photo


async def test_the_sweep_queues_every_kind_once_it_has_waited_one_photo_at_a_time(
    db_session: AsyncSession, storage: MemoryStorage, store: MemoryStore
) -> None:
    """Request media, a job's photos and a dispute's photo still pending: nothing is queued
    before the wait has passed; after it, each request's copy once, and each photo under its
    own job id (#491 round 1: a repeated sweep's task dedupes against its own)."""
    media = await make_media(db_session, storage, gps_jpeg())
    job_id, photos, dispute_id, dispute_photo = await photos_of_a_job_and_a_dispute(db_session)
    early, queue = RecordingQueue(), RecordingQueue()

    await requeue_stale_media_copies(
        sweep_ctx(db_session, early, store), clock=lambda: datetime.now(UTC)
    )
    await requeue_stale_media_copies(sweep_ctx(db_session, queue, store), clock=later)

    assert early.jobs == {}
    assert queue.jobs == {
        sanitize_job_id(media.request_id): ("sanitize_request_media", (str(media.request_id),)),
        **{
            f"sanitize-job-photos:{photo.id}": (
                "sanitize_job_photos",
                (str(job_id), [str(photo.id)]),
            )
            for photo in photos
        },
        f"sanitize-dispute-photos:{dispute_photo.id}": (
            "sanitize_dispute_photos",
            (str(dispute_id), [str(dispute_photo.id)]),
        ),
    }


# --- #491 round 1, B1: one copy of a row at a time ---------------------------------------------


async def test_a_row_another_run_holds_is_left_to_it_by_the_task_and_by_the_sweep(
    db_session: AsyncSession, storage: MemoryStorage, store: MemoryStore
) -> None:
    """Batch A/B: A is ready, B is being copied by another run (its claim held). The sweep does
    not queue B, and a run that reaches B anyway (a retry, the request's task) skips it: never
    two copies of B at once, and B is never settled under the run copying it."""
    first = await make_media(db_session, storage, gps_jpeg())
    job_id, photos, _, _ = await photos_of_a_job_and_a_dispute(db_session)
    holder = await store.claim(row_key(KIND, first.media_id))
    photo_holder = await store.claim(row_key("job_id", photos[1].id))
    queue = RecordingQueue()

    await requeue_stale_media_copies(sweep_ctx(db_session, queue, store), clock=later)
    outcome = await claiming(db_session, storage, store).copy_pending(
        first.request_id, attempt=MAX_TRIES, final=True
    )

    assert sanitize_job_id(first.request_id) not in queue.jobs
    assert f"sanitize-job-photos:{photos[1].id}" not in queue.jobs
    assert f"sanitize-job-photos:{photos[0].id}" in queue.jobs
    assert (outcome.ready, outcome.failed) == (0, 0)
    assert (await row(db_session, first.media_id)).safe_status == MediaSafeStatus.PENDING
    assert storage.uploads == []
    # The holder's claims are untouched: only a claim's own token releases it.
    assert holder is not None
    assert photo_holder is not None
    assert store.claims[row_key(KIND, first.media_id)] == holder
    assert job_id


@pytest.mark.parametrize("ending", ["ready", "fault", "outage", "bug", "out_of_time"])
async def test_the_claim_is_released_on_every_way_out(
    db_session: AsyncSession, storage: MemoryStorage, store: MemoryStore, ending: str
) -> None:
    content = None if ending == "fault" else gps_jpeg()
    media = await make_media(db_session, storage, content)
    storage.unavailable = ending == "outage"
    if ending == "bug":
        storage.broken.add(media.file_key)
    jobs = claiming(db_session, storage, store)
    if ending == "out_of_time":
        clock = iter([0.0, 0.0, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9, 1e9])
        await jobs.copy_pending(media.request_id, attempt=1, clock=lambda: next(clock))
    else:
        await jobs.copy_pending(media.request_id, attempt=MAX_TRIES)

    assert store.claimed == [row_key(KIND, media.media_id)]
    assert store.claims == {}


class BlockingStorage(MemoryStorage):
    """A download that waits for the test: a copy under way."""

    started: threading.Event
    go_on: threading.Event

    def download_to(self, key: str, path: Path) -> None:
        self.started.set()
        self.go_on.wait(10)
        super().download_to(key, path)


async def test_a_cancelled_run_releases_its_claim(
    db_session: AsyncSession, store: MemoryStore
) -> None:
    blocking = BlockingStorage()
    blocking.started, blocking.go_on = threading.Event(), threading.Event()
    media = await make_media(db_session, blocking, gps_jpeg())
    run = asyncio.create_task(
        claiming(db_session, blocking, store).copy_pending(media.request_id, attempt=1)
    )
    try:
        await asyncio.to_thread(blocking.started.wait, 10)
        assert store.claims  # held while the copy is under way
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run
    finally:
        blocking.go_on.set()

    assert store.claims == {}


# --- #491 round 1, B2: fair progress behind postponed rows -------------------------------------


async def test_a_row_behind_a_postponed_one_is_reached_with_a_batch_of_one(
    db_session: AsyncSession, storage: MemoryStorage, store: MemoryStore
) -> None:
    """The oldest request keeps being postponed (its copy never succeeds); a newer one's task
    was lost. With a batch of one, the first run queues the oldest and records it; the next run
    skips it for its window and queues the newer one."""
    oldest = await make_media(db_session, storage, gps_jpeg())
    newer = await make_media(db_session, storage, gps_jpeg())
    await attached_earlier(db_session, oldest)
    first, second = RecordingQueue(), RecordingQueue()

    await requeue_stale_media_copies(
        sweep_ctx(db_session, first, store, media_sanitize_resweep_batch_size=1), clock=later
    )
    await requeue_stale_media_copies(
        sweep_ctx(db_session, second, store, media_sanitize_resweep_batch_size=1), clock=later
    )

    assert list(first.jobs) == [sanitize_job_id(oldest.request_id)]
    assert list(second.jobs) == [sanitize_job_id(newer.request_id)]
    assert set(store.queued[KIND]) == {
        row_key(KIND, oldest.request_id),
        row_key(KIND, newer.request_id),
    }


class FlakyQueue(RecordingQueue):
    """Redis refuses the first job it is given."""

    refused: int = 0

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        if not self.refused:
            self.refused += 1
            raise RedisError("down")
        return await super().enqueue_job(function, *args, _job_id=_job_id)


async def test_one_queue_failure_never_stops_the_others_and_leaves_it_unmarked(
    db_session: AsyncSession,
    storage: MemoryStorage,
    store: MemoryStore,
    caplog: pytest.LogCaptureFixture,
) -> None:
    first = await make_media(db_session, storage, gps_jpeg())
    second = await make_media(db_session, storage, gps_jpeg())
    await attached_earlier(db_session, first)
    queue = FlakyQueue()

    with caplog.at_level(logging.INFO):
        await requeue_stale_media_copies(sweep_ctx(db_session, queue, store), clock=later)

    assert list(queue.jobs) == [sanitize_job_id(second.request_id)]
    # The refused one is not recorded: the next run tries it again first.
    assert list(store.queued[KIND]) == [row_key(KIND, second.request_id)]
    assert first.request_id
    [failed] = [r for r in caplog.records if r.getMessage() == "media_resweep_enqueue_failed"]
    assert failed.levelno == logging.ERROR
    [summary] = [r for r in caplog.records if r.getMessage() == "media_copies_requeued"]
    assert summary.__dict__["queued"]["failed"] == 1


async def test_a_batch_that_cannot_be_read_ends_the_run(
    db_session: AsyncSession, store: MemoryStore, caplog: pytest.LogCaptureFixture
) -> None:
    def broken() -> Any:
        raise OSError("database down")

    context = {**sweep_ctx(db_session, RecordingQueue(), store), "session_factory": broken}

    with caplog.at_level(logging.INFO):
        await requeue_stale_media_copies(context, clock=later)

    [error] = [r for r in caplog.records if r.getMessage() == "media_resweep_unavailable"]
    assert (error.levelno, error.__dict__["error"]) == (logging.ERROR, "OSError")


# --- The Redis store ---------------------------------------------------------------------------


async def test_the_redis_store_claims_once_releases_by_token_and_expires() -> None:
    """On the real Redis of REDIS_URL, under a key prefix of its own, deleted afterwards."""
    redis = Redis.from_url(Settings().redis_url)
    prefix = f"media-copy-test-{uuid.uuid4().hex}"
    store = RedisMediaCopyStore(redis, claim_seconds=30, prefix=prefix)
    key = row_key(KIND, uuid.uuid4())
    try:
        token = await store.claim(key)
        assert token is not None
        assert await store.claim(key) is None
        await store.release(key, "not-the-token")
        assert await store.held([key]) == {key}
        assert 0 < await redis.ttl(f"{prefix}:claim:{key}") <= 30  # a dead worker's ends
        await store.release(key, token)
        assert await store.held([key]) == set()
        await store.record_queued(KIND, [key], 1_000.0, 60)
        await store.record_queued(KIND, ["other"], 2_000.0, 60)  # trims the first: too old
        assert await store.last_queued(KIND, [key, "other"]) == {"other": 2_000.0}
        assert 0 < await redis.ttl(f"{prefix}:queued:{KIND}") <= 60
    finally:
        keys = [k async for k in redis.scan_iter(match=f"{prefix}:*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()


# --- #491 round 1, B3: invalid optional settings fall back -----------------------------------


DEFAULTS = {
    "MEDIA_SANITIZE_RESWEEP_MINUTES": 30,
    "MEDIA_SANITIZE_RESWEEP_AFTER_MINUTES": 60,
    "MEDIA_SANITIZE_RESWEEP_BATCH_SIZE": 100,
    "MEDIA_SANITIZE_RESWEEP_TIMEOUT_SECONDS": 120,
}


@pytest.mark.parametrize("name", list(DEFAULTS))
@pytest.mark.parametrize("value", ["", "oops", "0", "-1", "1.5"])
def test_an_invalid_sweep_setting_falls_back_to_its_default(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    """The worker still starts: the value is its documented default."""
    monkeypatch.setenv(name, value)

    settings = make_settings()

    assert getattr(settings, name.lower()) == DEFAULTS[name]


@pytest.mark.parametrize("name", list(DEFAULTS))
def test_a_valid_sweep_setting_is_kept(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setenv(name, "45")

    assert getattr(make_settings(), name.lower()) == 45


def test_without_sweep_settings_the_defaults_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in DEFAULTS:
        monkeypatch.delenv(name, raising=False)

    settings = make_settings()

    assert {name: getattr(settings, name.lower()) for name in DEFAULTS} == DEFAULTS


def test_the_minutes_above_an_hour_fall_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEDIA_SANITIZE_RESWEEP_MINUTES", "61")

    assert make_settings().media_sanitize_resweep_minutes == 30


def test_the_config_dataclass_is_reused(storage: MemoryStorage) -> None:
    """The claim lives longer than one row's whole budget (MediaCopyConfig)."""
    config = MediaCopyConfig.from_settings(make_settings())
    from app.modules.requests.media_copies import claim_seconds

    assert claim_seconds(config) > config.row_budget_seconds


async def test_a_final_try_never_fails_a_row_another_run_is_copying(
    db_session: AsyncSession, store: MemoryStore
) -> None:
    """The final try has time for one file only, and another run holds the second: the final
    settlement claims each row it fails, so the held one stays pending, never failed under the
    run copying it."""
    slow = SlowStorage(seconds=20)
    media, second = await make_two_photos(db_session, slow)
    later_row = max(media.media_id, second)  # read second: oldest first, then by id
    holder = await store.claim(row_key(KIND, later_row))
    base = short_copier(db_session, slow)
    jobs = MediaCopier(sessions_of(db_session), slow, base._config, store=store)

    outcome = await jobs.copy_pending(
        media.request_id, attempt=MAX_TRIES + 2, final=True, clock=slow.clock
    )

    assert (outcome.ready, outcome.failed) == (1, 0)
    assert (await row(db_session, later_row)).safe_status == MediaSafeStatus.PENDING
    assert store.claims == {row_key(KIND, later_row): holder}


# --- #491 round 2: fair progress across the window's expiry -----------------------------------


def fixed(when: datetime) -> Callable[[], datetime]:
    """A clock that reads `when`."""
    return lambda: when


async def five_units(
    session: AsyncSession, storage: MemoryStorage, kind: str
) -> tuple[list[str], str]:
    """Five pending units of `kind`, oldest first: the queue job ids of the four oldest, which
    keep being postponed, and of the newest, a healthy one whose task was lost."""
    hours_ago = [5, 4, 3, 2, 1]
    if kind == "requests":
        media = [await make_media(session, storage, gps_jpeg()) for _ in hours_ago]
        for item, hours in zip(media, hours_ago, strict=True):
            await session.execute(
                update(RequestMedia)
                .where(RequestMedia.id == item.media_id)
                .values(created_at=datetime.now(UTC) - timedelta(hours=hours))
            )
        ids = [sanitize_job_id(item.request_id) for item in media]
    else:
        world = await build_world(session)
        job = await make_job(session, world, JobStatus.DISPUTED)
        dispute = Dispute(
            job_id=job.id,
            opened_by=world.customer.id,
            reason_code=DisputeReason.DAMAGE,
            description="zq491 a dent",
        )
        session.add(dispute)
        await session.flush()
        photos: list[JobPhoto | DisputePhoto] = []
        for hours in hours_ago:
            created = datetime.now(UTC) - timedelta(hours=hours)
            if kind == "jobs":
                photos.append(
                    JobPhoto(
                        job_id=job.id,
                        kind=JobPhotoKind.AFTER,
                        file_key=f"u/{world.pro.id}/job_photo/{uuid.uuid4().hex}.jpg",
                        uploaded_by=world.pro.id,
                        created_at=created,
                    )
                )
            else:
                photos.append(
                    DisputePhoto(
                        dispute_id=dispute.id,
                        file_key=f"u/{world.customer.id}/dispute_photo/{uuid.uuid4().hex}.jpg",
                        uploaded_by=world.customer.id,
                        created_at=created,
                    )
                )
        session.add_all(photos)
        await session.flush()
        prefix = "sanitize-job-photos" if kind == "jobs" else "sanitize-dispute-photos"
        ids = [f"{prefix}:{photo.id}" for photo in photos]
    await session.commit()
    return ids[:4], ids[4]


@pytest.mark.parametrize("skew", [0.0, 1.0], ids=["recorded_at_once", "recorded_1s_late"])
@pytest.mark.parametrize("kind", ["requests", "jobs", "disputes"])
async def test_a_healthy_unit_behind_four_postponed_ones_is_reached_across_the_window(
    db_session: AsyncSession, storage: MemoryStorage, kind: str, skew: float
) -> None:
    """Batch 1, a sweep every 30 minutes, a 60-minute window, an expiring history: four units
    that are never copied (an outage that lasts) sit ahead of a healthy one. Oldest-first after
    the window expires would serve A, B, A, B... forever; least recently queued first reaches
    the healthy one within five runs, and every run queues exactly one unit."""
    store = MemoryStore(skew=skew)
    postponed, healthy = await five_units(db_session, storage, kind)
    start = later()
    picked: list[list[str]] = []
    for run in range(12):
        queue = RecordingQueue()
        await requeue_stale_media_copies(
            sweep_ctx(db_session, queue, store, media_sanitize_resweep_batch_size=1),
            clock=fixed(start + timedelta(minutes=30 * run)),
        )
        picked.append(list(queue.jobs))

    assert all(len(ids) == 1 for ids in picked), picked
    first_healthy = next(run for run, ids in enumerate(picked) if healthy in ids)
    assert first_healthy < 5, picked
    # Every unit takes its turn: none of the five is starved.
    assert {job_id for ids in picked for job_id in ids} == {*postponed, healthy}


async def test_a_healthy_image_behind_videos_ffmpeg_cannot_copy_is_copied(
    db_session: AsyncSession, store: MemoryStore
) -> None:
    """Database-backed: four older requests hold a video each and ffmpeg is missing, so every
    copy of them is postponed (their last try); a newer request's image was never queued. Each
    sweep's queued copy is run on its last try: the image is ready within five runs, the videos
    stay pending, never failed."""
    storage = MemoryStorage()
    videos = [await make_media(db_session, storage, b"not decodable", ".mp4") for _ in range(4)]
    image = await make_media(db_session, storage, gps_jpeg())
    for hours, item in zip([5, 4, 3, 2], videos, strict=True):
        await db_session.execute(
            update(RequestMedia)
            .where(RequestMedia.id == item.media_id)
            .values(created_at=datetime.now(UTC) - timedelta(hours=hours))
        )
    await db_session.commit()
    copy_ctx = {
        **ctx(db_session, storage, MAX_TRIES + 1),
        "settings": make_settings(
            media_sanitize_max_tries=MAX_TRIES,
            ffmpeg_path="missing-ffmpeg-491",
            ffprobe_path="missing-ffprobe-491",
        ),
        "media_copy_store": store,
    }
    start = later()
    for run in range(5):
        queue = RecordingQueue()
        await requeue_stale_media_copies(
            sweep_ctx(db_session, queue, store, media_sanitize_resweep_batch_size=1),
            clock=fixed(start + timedelta(minutes=30 * run)),
        )
        for function, args in queue.jobs.values():
            assert function == "sanitize_request_media"
            await sanitize_request_media(copy_ctx, str(args[0]))
        if (await row(db_session, image.media_id)).safe_status == MediaSafeStatus.READY:
            break
    else:
        pytest.fail("the healthy image was never copied")
    for video in videos:
        assert (await row(db_session, video.media_id)).safe_status == MediaSafeStatus.PENDING
