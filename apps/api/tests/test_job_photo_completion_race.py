"""Job's done while the worker settles the last pending after photo (#298, Gatekeeper R2-B1).

The worker locks the photo, not the job, so the job's lock never keeps it out of completion.
Completion decides from one read of the photos' ids and statuses: a copy the worker settles
right after that read answers 409 after_photos_processing, never a 500, and the pro's next try
decides from the settled status. Committed data on separate connections, as in production;
only the moment the worker runs is arranged, the queries and the copier are real.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import cast

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import Storage
from app.modules.jobs.errors import AfterPhotosProcessingError, AfterPhotosRequiredError
from app.modules.jobs.execution import JobExecutionService
from app.modules.jobs.models import JobPhoto, JobPhotoKind, JobStatus
from app.modules.jobs.photos import SANITIZE_PHOTOS_TASK, enqueue_photo_sanitize
from app.modules.jobs.service import JobStateMachine
from app.modules.jobs.tasks import sanitize_job_photos
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.pros.service import ProService
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES
from tests.conftest import make_settings
from tests.test_arrival_code import CONFIG, CommittedJob, committed_job
from tests.test_job_photos_api import FakeStorage, RecordingQueue, key_of
from tests.test_media_copies import MAX_TRIES, MemoryStorage, gps_jpeg

__all__ = ["committed_job"]  # the fixture, used by name

WAIT_SECONDS = 10


@pytest.fixture
async def working(committed_job: CommittedJob) -> AsyncIterator[CommittedJob]:
    """The committed job in progress; its photos deleted after."""
    async with committed_job.sessions() as session:
        machine = JobStateMachine(session, ProService(session))
        await machine.transition(committed_job.job_id, JobStatus.IN_PROGRESS, committed_job.pro)
        await session.commit()
    try:
        yield committed_job
    finally:
        async with committed_job.sessions() as session:
            await session.execute(delete(JobPhoto).where(JobPhoto.job_id == committed_job.job_id))
            await session.commit()


def service(session: AsyncSession) -> JobExecutionService:
    # The fake signs the views' photos; the rest of the port is never reached here.
    return JobExecutionService(session, CONFIG, lambda: cast(Storage, FakeStorage()))


async def pending_after_photo(job: CommittedJob) -> tuple[uuid.UUID, str]:
    async with job.sessions() as session:
        photo = JobPhoto(
            job_id=job.job_id,
            kind=JobPhotoKind.AFTER,
            file_key=key_of(job.pro.id),
            uploaded_by=job.pro.id,
        )
        session.add(photo)
        await session.commit()
        return photo.id, photo.file_key


async def status_of(job: CommittedJob, photo_id: uuid.UUID) -> MediaSafeStatus:
    async with job.sessions() as session:
        photo = await session.get(JobPhoto, photo_id)
        assert photo is not None
        return photo.safe_status


@pytest.mark.parametrize(
    ("image", "settled"),
    [(True, MediaSafeStatus.READY), (False, MediaSafeStatus.FAILED)],
    ids=["becomes-ready", "becomes-failed"],
)
async def test_the_last_pending_after_photo_settling_after_the_read_answers_409(
    working: CommittedJob,
    monkeypatch: pytest.MonkeyPatch,
    image: bool,
    settled: MediaSafeStatus,
) -> None:
    job = working
    photo_id, key = await pending_after_photo(job)
    files = MemoryStorage()
    files.objects[key] = gps_jpeg() if image else b"not an image"
    queue = RecordingQueue()
    async with job.sessions() as session:
        subject = service(session)
        read = subject._photos.statuses

        async def read_then_the_worker_settles(
            job_id: uuid.UUID, kind: JobPhotoKind
        ) -> list[tuple[uuid.UUID, MediaSafeStatus]]:
            result = await read(job_id, kind)
            assert result == [(photo_id, MediaSafeStatus.PENDING)]
            # The real task, on its own connection, on its last try: it settles the photo.
            async with asyncio.timeout(WAIT_SECONDS):
                await sanitize_job_photos(
                    {
                        "settings": make_settings(media_sanitize_max_tries=MAX_TRIES),
                        "session_factory": job.sessions,
                        "storage": files,
                        "job_try": MAX_TRIES + SANITIZE_SPARE_TRIES,
                    },
                    str(job.job_id),
                    [str(photo_id)],
                )
            assert await status_of(job, photo_id) is settled
            return result

        monkeypatch.setattr(subject._photos, "statuses", read_then_the_worker_settles)
        with pytest.raises(AfterPhotosProcessingError):
            await subject.complete(job.pro, job.job_id, queue)
    # The batch from the read is queued again (a settled id in it is skipped: photos.py).
    assert list(queue.jobs.values()) == [(SANITIZE_PHOTOS_TASK, (str(job.job_id), [str(photo_id)]))]

    # The pro's next try decides from the settled photo.
    async with job.sessions() as session:
        retry = service(session)
        if settled is MediaSafeStatus.READY:
            done = await retry.complete(job.pro, job.job_id, RecordingQueue())
            assert done.status is JobStatus.COMPLETED
        else:
            with pytest.raises(AfterPhotosRequiredError):
                await retry.complete(job.pro, job.job_id, RecordingQueue())


async def test_an_empty_batch_queues_nothing() -> None:
    queue = RecordingQueue()
    assert await enqueue_photo_sanitize(queue, uuid.uuid4(), [], timeout_seconds=1.0) is False
    assert queue.jobs == {}
