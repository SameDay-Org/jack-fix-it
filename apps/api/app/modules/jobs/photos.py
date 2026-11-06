"""The pro's before and after photos of a job (D12.2, #298): their privacy-safe copies and how
each side is shown them.

The pro attaches their own job_photo uploads (JobExecutionService.add_photos); after the commit
a sanitize_job_photos run makes each photo's safe copy with the request media's copier (#173):
metadata stripped (EXIF, GPS), under an opaque key (m/<32 hex><ext>) with no user id.

- The customer is shown the ready safe copies only, signed here and nowhere else: a key outside
  the safe copies' prefix is refused (logged with the photo id). A photo still pending is
  counted, a failed one is neither listed nor counted.
- The pro is shown each of their own photos as its safe copy once ready, else the original.

Logs carry ids only: never a key (an original's names its owner).
"""

import logging
import uuid
from collections.abc import Collection, Sequence
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import StorageProvider
from app.modules.jobs.models import JobPhoto, JobPhotoKind
from app.modules.jobs.repository import JobPhotoRepository
from app.modules.jobs.schemas import CustomerJobPhotos, JobPhotoOut, ProJobPhotos
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.requests.media_copies import SAFE_KEY_PREFIX
from app.modules.uploads.keys import upload_content_type
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

SANITIZE_PHOTOS_TASK: Final = "sanitize_job_photos"


class JobPhotoRows:
    """One batch of a job's photos, for the safe-copy copier (requests.media_copies.MediaRows).
    A run copies its own batch only: its tries and deadline never fail another batch's rows."""

    parent_field = "job_id"

    def __init__(self, photo_ids: Collection[uuid.UUID]) -> None:
        self._photo_ids = frozenset(photo_ids)

    async def pending(
        self, session: AsyncSession, parent_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, str]]:
        rows = await JobPhotoRepository(session).pending(parent_id, self._photo_ids)
        return [(photo.id, photo.file_key) for photo in rows]

    async def mark_ready(
        self, session: AsyncSession, row_id: uuid.UUID, safe_key: str, content_type: str
    ) -> bool:
        photo = await JobPhotoRepository(session).get_for_update(row_id)
        if photo is None or photo.safe_status != MediaSafeStatus.PENDING:
            return False
        photo.safe_key = safe_key
        photo.safe_content_type = content_type
        photo.safe_status = MediaSafeStatus.READY
        return True

    async def fail_pending(
        self, session: AsyncSession, row_ids: Sequence[uuid.UUID]
    ) -> list[uuid.UUID]:
        return await JobPhotoRepository(session).fail_pending(row_ids)


async def enqueue_photo_sanitize(
    queue: JobQueue, job_id: uuid.UUID, photo_ids: Sequence[uuid.UUID], timeout_seconds: float
) -> bool:
    """Queues sanitize_job_photos for one batch of the job's photos (after the commit), named
    after its first photo: a run already going for an earlier batch never hides a new one, and
    copies only its own photos."""
    return await enqueue(
        queue,
        SANITIZE_PHOTOS_TASK,
        str(job_id),
        [str(photo_id) for photo_id in photo_ids],
        job_id=f"sanitize-job-photos:{photo_ids[0]}",
        timeout_seconds=timeout_seconds,
    )


def job_photo_keys_among(keys: Collection[str]) -> Select[str]:
    """The upload keys among `keys` that a job photo holds, as a statement: the uploads
    module's sweep of unreferenced uploads (#191) runs it with the other referencing columns."""
    return JobPhotoRepository.keys_among(keys)


class JobPhotoSigner:
    """Signs the photos of a job for its pro or its customer. The storage is reached only when
    there is a photo to sign."""

    def __init__(self, storage: StorageProvider, ttl_seconds: int) -> None:
        self._storage = storage
        self._ttl = ttl_seconds

    def for_pro(self, photos: Sequence[JobPhoto]) -> ProJobPhotos:
        expires_at = self._expires_at()
        signed: dict[JobPhotoKind, list[JobPhotoOut]] = {kind: [] for kind in JobPhotoKind}
        for photo in photos:
            safe = _safe_copy(photo)
            if safe is not None:
                key, content_type = safe
            else:
                key, original_type = photo.file_key, upload_content_type(photo.file_key)
                if original_type is None:  # pragma: no cover - checked when attached
                    logger.error("job_photo_key_refused", extra={"photo_id": str(photo.id)})
                    continue
                content_type = original_type
            signed[photo.kind].append(self._sign(photo, key, content_type, expires_at))
        return ProJobPhotos(before=signed[JobPhotoKind.BEFORE], after=signed[JobPhotoKind.AFTER])

    def for_customer(self, photos: Sequence[JobPhoto]) -> CustomerJobPhotos:
        expires_at = self._expires_at()
        signed: dict[JobPhotoKind, list[JobPhotoOut]] = {kind: [] for kind in JobPhotoKind}
        pending = 0
        for photo in photos:
            if photo.safe_status is MediaSafeStatus.PENDING:
                pending += 1
                continue
            if photo.safe_status is not MediaSafeStatus.READY:
                continue  # failed: never served
            safe = _safe_copy(photo)
            if safe is None:
                logger.error("job_photo_key_refused", extra={"photo_id": str(photo.id)})
                continue
            signed[photo.kind].append(self._sign(photo, *safe, expires_at))
        return CustomerJobPhotos(
            before=signed[JobPhotoKind.BEFORE], after=signed[JobPhotoKind.AFTER], pending=pending
        )

    def _expires_at(self) -> datetime:
        return datetime.now(UTC) + timedelta(seconds=self._ttl)

    def _sign(
        self, photo: JobPhoto, key: str, content_type: str, expires_at: datetime
    ) -> JobPhotoOut:
        return JobPhotoOut(
            id=photo.id,
            content_type=content_type,
            url=self._storage().presign_get(key, self._ttl),
            expires_at=expires_at,
        )


def _safe_copy(photo: JobPhoto) -> tuple[str, str] | None:
    """The ready safe copy's key and type; None unless the row holds a whole one under the
    safe copies' prefix."""
    key, content_type = photo.safe_key, photo.safe_content_type
    if (
        photo.safe_status is not MediaSafeStatus.READY
        or key is None
        or not key.startswith(SAFE_KEY_PREFIX)
        or content_type is None
    ):
        return None
    return key, content_type
