"""The orphan sweep and job photo attaches (#298, Vault B2): disjoint ages keep the sweep from
ever deleting a key a job accepted, with no lock between them (orphans.py, execution.py).

Committed data on separate connections, as in production: the sweep reads references in its
own transaction and deletes after it ends, while an attach commits on another connection.
"""

import asyncio
import threading
import uuid
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select

from app.integrations.storage import DeleteResult
from app.modules.jobs.errors import JobPhotoUploadExpiredError
from app.modules.jobs.execution import JobExecutionService
from app.modules.jobs.models import JobPhoto, JobPhotoKind
from app.modules.uploads.orphans import OrphanSweepConfig, OrphanUploadSweeper
from app.modules.uploads.schemas import UploadPurpose
from tests.test_arrival_code import CONFIG, CommittedJob, committed_job
from tests.test_job_photos_api import RecordingQueue, key_of
from tests.test_orphan_uploads import ListingStorage, upload_key

__all__ = ["committed_job"]  # the fixture, used by name

MIN_AGE = timedelta(hours=24)
ATTACH_MAX_AGE = MIN_AGE / 2
SWEEP = OrphanSweepConfig(mode="delete", min_age=MIN_AGE)
ATTACH = replace(CONFIG, photo_attach_max_age=ATTACH_MAX_AGE)
WAIT_SECONDS = 10


@dataclass
class PausedDeleteStorage(ListingStorage):
    """Holds the sweep's delete call until released: the gap after its reference check."""

    deleting: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)

    def delete_many(self, keys: Sequence[str]) -> DeleteResult:
        self.deleting.set()
        if not self.release.wait(WAIT_SECONDS):
            raise AssertionError("the test never released the delete")
        return super().delete_many(keys)


@pytest.fixture
async def job_with_photos(committed_job: CommittedJob) -> AsyncIterator[CommittedJob]:
    """The committed job on the way (before photos allowed); its photos deleted after."""
    try:
        yield committed_job
    finally:
        async with committed_job.sessions() as session:
            await session.execute(delete(JobPhoto).where(JobPhoto.job_id == committed_job.job_id))
            await session.commit()


async def attach(job: CommittedJob, key: str, storage: ListingStorage) -> None:
    async with job.sessions() as session:
        service = JobExecutionService(session, ATTACH, lambda: storage)
        await service.add_photos(job.pro, job.job_id, JobPhotoKind.BEFORE, [key], RecordingQueue())


async def references(job: CommittedJob, key: str) -> int:
    async with job.sessions() as session:
        return len((await session.scalars(select(JobPhoto).where(JobPhoto.file_key == key))).all())


@pytest.mark.parametrize("token", ["time_ordered", "legacy"])
async def test_the_sweep_cannot_delete_a_photo_attached_before_its_delete(
    job_with_photos: CommittedJob, token: str
) -> None:
    # The Vault's probe: the sweep checked an old upload unreferenced and waits on its delete;
    # the attach that comes now is refused, so the delete never removes a referenced file.
    job = job_with_photos
    now = datetime.now(UTC)
    uploaded = now - MIN_AGE - timedelta(hours=1)
    if token == "time_ordered":
        key = key_of(job.pro.id, issued_at=uploaded)
    else:
        key = f"u/{job.pro.id}/job_photo/{uuid.uuid4().hex}.jpg"
    storage = PausedDeleteStorage({key: uploaded})
    sweeper = OrphanUploadSweeper(job.sessions, storage, SWEEP, clock=lambda: now)

    sweep = asyncio.create_task(sweeper.sweep())
    try:
        assert await asyncio.to_thread(storage.deleting.wait, WAIT_SECONDS)
        with pytest.raises(JobPhotoUploadExpiredError):
            await attach(job, key, storage)
        assert await references(job, key) == 0
    finally:
        storage.release.set()
        counts = await sweep

    assert (counts.orphaned, counts.deleted) == (1, 1)
    assert key not in storage.objects
    assert await references(job, key) == 0


async def test_a_photo_attached_at_the_edge_of_its_window_is_kept_by_any_later_sweep(
    job_with_photos: CommittedJob,
) -> None:
    # The control: the oldest key an attach accepts is referenced well before any sweep may
    # reach it; that sweep keeps it and still deletes a genuinely unreferenced old job photo.
    job = job_with_photos
    now = datetime.now(UTC)
    issued = now - ATTACH_MAX_AGE + timedelta(minutes=1)
    kept = key_of(job.pro.id, issued_at=issued)
    orphan = upload_key(job.pro.id, UploadPurpose.JOB_PHOTO)
    storage = ListingStorage({kept: issued, orphan: issued})
    await attach(job, kept, storage)

    # The first sweep that may delete `kept`: its clock past the upload's minimum age.
    later = issued + MIN_AGE + timedelta(seconds=1)
    counts = await OrphanUploadSweeper(job.sessions, storage, SWEEP, clock=lambda: later).sweep()

    assert (counts.referenced, counts.orphaned, counts.deleted) == (1, 1, 1)
    assert set(storage.objects) == {kept}
    assert await references(job, kept) == 1
