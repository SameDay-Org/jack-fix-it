"""The job photos' privacy-safe copies (#298): the request media's copier (#173) on job_photos
rows, through sanitize_job_photos."""

import io
import logging
import uuid

import pytest
from arq import Retry
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import JobPhoto, JobPhotoKind, JobStatus
from app.modules.jobs.tasks import sanitize_job_photos
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.requests.media_copies import safe_key_for
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES
from app.observability import configure_logging
from tests.job_world import JobWorld, build_world, make_job
from tests.test_media_copies import MAX_TRIES, SAFE_KEY, MemoryStorage, ctx, gps_jpeg
from tests.test_media_logging import leaks


async def make_photos(
    session: AsyncSession,
    storage: MemoryStorage,
    *contents: bytes | None,
    world: JobWorld | None = None,
) -> tuple[uuid.UUID, list[JobPhoto]]:
    """An in-progress job with one after photo per content; None leaves the file missing."""
    world = world or await build_world(session)
    job = await make_job(session, world, JobStatus.IN_PROGRESS)
    photos = []
    for content in contents:
        key = f"u/{world.pro.id}/job_photo/{uuid.uuid4().hex}.jpg"
        photo = JobPhoto(
            job_id=job.id, kind=JobPhotoKind.AFTER, file_key=key, uploaded_by=world.pro.id
        )
        session.add(photo)
        await session.flush()
        if content is not None:
            storage.objects[key] = content
        photos.append(photo)
    return job.id, photos


def ids(*photos: JobPhoto) -> list[str]:
    return [str(photo.id) for photo in photos]


async def reload(session: AsyncSession, photo_id: uuid.UUID) -> JobPhoto:
    statement = (
        select(JobPhoto).where(JobPhoto.id == photo_id).execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def test_pending_job_photos_get_a_safe_copy(db_session: AsyncSession) -> None:
    storage = MemoryStorage()
    job_id, [photo] = await make_photos(db_session, storage, gps_jpeg())

    result = await sanitize_job_photos(ctx(db_session, storage, 1), str(job_id), ids(photo))

    assert result == "ready=1 failed=0 waiting=0 deferred=0"
    saved = await reload(db_session, photo.id)
    assert saved.safe_status is MediaSafeStatus.READY
    assert saved.safe_key == safe_key_for(photo.id, ".jpg")
    assert SAFE_KEY.fullmatch(str(saved.safe_key))
    assert saved.safe_content_type == "image/jpeg"
    copy = storage.objects[str(saved.safe_key)]
    assert dict(Image.open(io.BytesIO(copy)).getexif()) == {}
    assert b"Jane Customer" not in copy

    again = await sanitize_job_photos(ctx(db_session, storage, 1), str(job_id), ids(photo))
    assert again == "ready=0 failed=0 waiting=0 deferred=0"
    assert len(storage.uploads) == 1


async def test_a_missing_file_retries_then_fails_and_logs_ids_only(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    storage = MemoryStorage()
    job_id, [missing, good] = await make_photos(db_session, storage, None, gps_jpeg())

    with caplog.at_level(logging.DEBUG):
        configure_logging("DEBUG")
        with pytest.raises(Retry):
            await sanitize_job_photos(ctx(db_session, storage, 1), str(job_id), ids(missing, good))
        assert (await reload(db_session, missing.id)).safe_status is MediaSafeStatus.PENDING
        last = await sanitize_job_photos(
            ctx(db_session, storage, MAX_TRIES + SANITIZE_SPARE_TRIES),
            str(job_id),
            ids(missing, good),
        )

    assert last == "ready=0 failed=1 waiting=0 deferred=0"
    assert (await reload(db_session, missing.id)).safe_status is MediaSafeStatus.FAILED
    assert (await reload(db_session, good.id)).safe_status is MediaSafeStatus.READY
    [failed] = [r for r in caplog.records if r.message == "media_sanitize_failed"]
    assert (failed.__dict__["media_id"], failed.__dict__["job_id"]) == (
        str(missing.id),
        str(job_id),
    )
    assert "service_request_id" not in failed.__dict__
    keys = [missing.file_key, good.file_key, str((await reload(db_session, good.id)).safe_key)]
    assert not leaks(caplog.records, *keys, *(key.rsplit("/", 1)[1] for key in keys))


async def test_without_storage_the_photos_stay_pending(db_session: AsyncSession) -> None:
    job_id, [photo] = await make_photos(db_session, MemoryStorage(), gps_jpeg())

    result = await sanitize_job_photos(ctx(db_session, None, 1), str(job_id), ids(photo))

    assert result == "storage_unconfigured"
    assert (await reload(db_session, photo.id)).safe_status is MediaSafeStatus.PENDING


async def test_a_run_copies_only_its_own_batch(db_session: AsyncSession) -> None:
    # The last try of an earlier batch's run fails what it cannot copy: never a later batch's
    # photo, which its own run copies.
    storage = MemoryStorage()
    world = await build_world(db_session)
    job_id, [missing, later] = await make_photos(db_session, storage, None, gps_jpeg(), world=world)

    last = await sanitize_job_photos(
        ctx(db_session, storage, MAX_TRIES + SANITIZE_SPARE_TRIES), str(job_id), ids(missing)
    )

    assert last == "ready=0 failed=1 waiting=0 deferred=0"
    assert (await reload(db_session, later.id)).safe_status is MediaSafeStatus.PENDING
    assert await sanitize_job_photos(ctx(db_session, storage, 1), str(job_id), ids(later)) == (
        "ready=1 failed=0 waiting=0 deferred=0"
    )
    # A photo id of another job is never copied under this one.
    _, [other] = await make_photos(db_session, storage, gps_jpeg(), world=world)
    assert await sanitize_job_photos(ctx(db_session, storage, 1), str(job_id), ids(other)) == (
        "ready=0 failed=0 waiting=0 deferred=0"
    )
    assert (await reload(db_session, other.id)).safe_status is MediaSafeStatus.PENDING
