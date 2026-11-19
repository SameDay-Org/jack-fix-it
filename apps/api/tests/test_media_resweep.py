"""Safe copies an outage left pending (#473): the copier postpones a row instead of failing it
when the storage outlasted its tries, and the worker's sweep queues its copy again.

The copier runs on the rolled-back test session with the storage in memory
(tests/test_media_copies.py); the sweep's queue records what it queued."""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.disputes.models import Dispute, DisputePhoto, DisputeReason
from app.modules.jobs.models import JobPhoto, JobPhotoKind, JobStatus
from app.modules.media.resweep import requeue_stale_media_copies
from app.modules.requests.media_copies import sanitize_job_id
from app.modules.requests.models import MediaSafeStatus
from app.modules.requests.tasks import sanitize_request_media
from tests.conftest import make_settings
from tests.job_world import build_world, make_job
from tests.test_dispatch import sessions_of
from tests.test_disputes_api import RecordingQueue
from tests.test_media_copies import MAX_TRIES, MemoryStorage, copier, ctx, gps_jpeg, make_media, row

AFTER = timedelta(minutes=60)


@pytest.fixture
def storage() -> MemoryStorage:
    return MemoryStorage()


def sweep_ctx(session: AsyncSession, queue: Any) -> dict[str, Any]:
    return {
        "session_factory": sessions_of(session),
        "settings": make_settings(
            media_sanitize_resweep_after_minutes=int(AFTER.total_seconds() // 60)
        ),
        "redis": queue,
    }


def later() -> datetime:
    """A clock past the sweep's wait for anything attached now."""
    return datetime.now(UTC) + AFTER + timedelta(minutes=5)


async def test_an_outage_that_outlasts_the_tries_postpones_the_row_and_the_sweep_copies_it(
    db_session: AsyncSession, storage: MemoryStorage, caplog: pytest.LogCaptureFixture
) -> None:
    """The storage is down for every try: the last one leaves the photo pending (an ERROR for
    staff), never failed. Once the storage is back the sweep queues its copy, and the copy is
    made: the pro gets the photo after all."""
    media = await make_media(db_session, storage, gps_jpeg())
    storage.unavailable = True
    jobs = copier(db_session, storage)
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

    storage.unavailable = False
    queue = RecordingQueue()
    await requeue_stale_media_copies(sweep_ctx(db_session, queue), clock=later)

    assert queue.jobs == {
        sanitize_job_id(media.request_id): ("sanitize_request_media", (str(media.request_id),))
    }
    await sanitize_request_media(ctx(db_session, storage, 1), str(media.request_id))
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
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    """A missing original is the file's fault, not an outage: it fails at the last try as
    before, and the sweep leaves a failed row alone."""
    media = await make_media(db_session, storage, content=None)
    jobs = copier(db_session, storage)
    for attempt in range(1, MAX_TRIES + 1):
        await jobs.copy_pending(media.request_id, attempt=attempt)
    assert (await row(db_session, media.media_id)).safe_status == MediaSafeStatus.FAILED
    queue = RecordingQueue()

    await requeue_stale_media_copies(sweep_ctx(db_session, queue), clock=later)

    assert queue.jobs == {}


async def test_the_sweep_queues_every_kind_once_it_has_waited(
    db_session: AsyncSession, storage: MemoryStorage
) -> None:
    """Request media, a job's photos and a dispute's photos still pending: nothing is queued
    before the wait has passed; after it, each parent's copy once, its photos as one batch."""
    media = await make_media(db_session, storage, gps_jpeg())
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.DISPUTED)
    photos = [
        JobPhoto(
            job_id=job.id,
            kind=JobPhotoKind.AFTER,
            file_key=f"u/{world.pro.id}/job_photo/{uuid.uuid4().hex}.jpg",
            uploaded_by=world.pro.id,
        )
        for _ in range(2)
    ]
    db_session.add_all(photos)
    await db_session.flush()
    dispute = Dispute(
        job_id=job.id,
        opened_by=world.customer.id,
        reason_code=DisputeReason.DAMAGE,
        description="zq473 a dent",
    )
    db_session.add(dispute)
    await db_session.flush()
    dispute_photo = DisputePhoto(
        dispute_id=dispute.id,
        file_key=f"u/{world.customer.id}/dispute_photo/{uuid.uuid4().hex}.jpg",
        uploaded_by=world.customer.id,
    )
    db_session.add(dispute_photo)
    await db_session.commit()
    early, queue = RecordingQueue(), RecordingQueue()

    await requeue_stale_media_copies(sweep_ctx(db_session, early), clock=lambda: datetime.now(UTC))
    await requeue_stale_media_copies(sweep_ctx(db_session, queue), clock=later)

    assert early.jobs == {}
    ordered = sorted(photos, key=lambda photo: (photo.created_at, photo.id))
    assert queue.jobs[sanitize_job_id(media.request_id)] == (
        "sanitize_request_media",
        (str(media.request_id),),
    )
    assert queue.jobs[f"sanitize-job-photos:{ordered[0].id}"] == (
        "sanitize_job_photos",
        (str(job.id), [str(photo.id) for photo in ordered]),
    )
    assert queue.jobs[f"sanitize-dispute-photos:{dispute_photo.id}"] == (
        "sanitize_dispute_photos",
        (str(dispute.id), [str(dispute_photo.id)]),
    )


class FlakyQueue(RecordingQueue):
    """Redis refuses the first job it is given."""

    refused: int = 0

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        if not self.refused:
            self.refused += 1
            raise RedisError("down")
        return await super().enqueue_job(function, *args, _job_id=_job_id)


async def test_one_queue_failure_never_stops_the_others(
    db_session: AsyncSession, storage: MemoryStorage, caplog: pytest.LogCaptureFixture
) -> None:
    first = await make_media(db_session, storage, gps_jpeg())
    second = await make_media(db_session, storage, gps_jpeg())
    queue = FlakyQueue()

    with caplog.at_level(logging.INFO):
        await requeue_stale_media_copies(sweep_ctx(db_session, queue), clock=later)

    assert len(queue.jobs) == 1
    assert set(queue.jobs) <= {
        sanitize_job_id(first.request_id),
        sanitize_job_id(second.request_id),
    }
    [failed] = [r for r in caplog.records if r.getMessage() == "media_resweep_enqueue_failed"]
    assert failed.levelno == logging.ERROR
    [summary] = [r for r in caplog.records if r.getMessage() == "media_copies_requeued"]
    assert summary.__dict__["queued"]["failed"] == 1


async def test_a_batch_that_cannot_be_read_ends_the_run(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    def broken() -> Any:
        raise OSError("database down")

    context = {**sweep_ctx(db_session, RecordingQueue()), "session_factory": broken}

    with caplog.at_level(logging.INFO):
        await requeue_stale_media_copies(context, clock=later)

    [error] = [r for r in caplog.records if r.getMessage() == "media_resweep_unavailable"]
    assert (error.levelno, error.__dict__["error"]) == (logging.ERROR, "OSError")
