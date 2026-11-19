"""The customer's photos of a dispute (#75): their privacy-safe copies and how each side is shown
them, as for the pro's job photos (#298).

After the report commits, a sanitize_dispute_photos run makes each photo's safe copy with the
request media's copier (#173): metadata stripped (EXIF, GPS), under an opaque key (m/<32 hex>
<ext>) with no user id.

- The pro (and later staff) are shown the ready safe copies only, signed here: a key outside the
  safe copies' prefix is refused (logged with the photo id). Pending ones are counted, failed
  ones neither listed nor counted.
- The customer is shown each of their own photos as its safe copy once ready, else the
  original they uploaded.

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
from app.modules.disputes.models import DisputePhoto
from app.modules.disputes.repository import DisputePhotoRepository
from app.modules.disputes.schemas import DisputePhotoOut
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.requests.media_copies import SAFE_KEY_PREFIX
from app.modules.uploads.keys import upload_content_type
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

SANITIZE_DISPUTE_PHOTOS_TASK: Final = "sanitize_dispute_photos"


class DisputePhotoRows:
    """One dispute's photos, for the safe-copy copier (requests.media_copies.MediaRows)."""

    parent_field = "dispute_id"

    def __init__(self, photo_ids: Collection[uuid.UUID]) -> None:
        self._photo_ids = frozenset(photo_ids)

    async def pending(
        self, session: AsyncSession, parent_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, str]]:
        rows = await DisputePhotoRepository(session).pending(parent_id, self._photo_ids)
        return [(photo.id, photo.file_key) for photo in rows]

    async def mark_ready(
        self, session: AsyncSession, row_id: uuid.UUID, safe_key: str, content_type: str
    ) -> bool:
        photo = await DisputePhotoRepository(session).get_for_update(row_id)
        if photo is None or photo.safe_status != MediaSafeStatus.PENDING:
            return False
        photo.safe_key = safe_key
        photo.safe_content_type = content_type
        photo.safe_status = MediaSafeStatus.READY
        return True

    async def fail_pending(
        self, session: AsyncSession, row_ids: Sequence[uuid.UUID]
    ) -> list[uuid.UUID]:
        return await DisputePhotoRepository(session).fail_pending(row_ids)


async def stale_pending_photos(
    session: AsyncSession, before: datetime, limit: int
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """The photos still waiting for their safe copy since before `before`, by dispute, oldest
    first: for the sweep (app.modules.media.resweep, #473)."""
    found: dict[uuid.UUID, list[uuid.UUID]] = {}
    for parent_id, photo_id in await DisputePhotoRepository(session).stale_pending(before, limit):
        found.setdefault(parent_id, []).append(photo_id)
    return found


async def enqueue_dispute_photo_sanitize(
    queue: JobQueue,
    dispute_id: uuid.UUID,
    photo_ids: Sequence[uuid.UUID],
    timeout_seconds: float,
) -> bool:
    """Queues sanitize_dispute_photos for the dispute's photos (after the commit). An empty
    batch queues nothing (False)."""
    if not photo_ids:
        return False
    return await enqueue(
        queue,
        SANITIZE_DISPUTE_PHOTOS_TASK,
        str(dispute_id),
        [str(photo_id) for photo_id in photo_ids],
        job_id=f"sanitize-dispute-photos:{photo_ids[0]}",
        timeout_seconds=timeout_seconds,
    )


def dispute_photo_keys_among(keys: Collection[str]) -> Select[str]:
    """The upload keys among `keys` that a dispute photo holds, as a statement: the uploads
    module's sweep of unreferenced uploads (#191) runs it with the other referencing columns."""
    return DisputePhotoRepository.keys_among(keys)


class DisputePhotoSigner:
    """Signs a dispute's photos for its customer or for the other side. The storage is reached
    only when there is a photo to sign."""

    def __init__(self, storage: StorageProvider, ttl_seconds: int) -> None:
        self._storage = storage
        self._ttl = ttl_seconds

    def for_owner(self, photos: Sequence[DisputePhoto]) -> tuple[list[DisputePhotoOut], int]:
        """The customer's own photos: each safe copy once ready, else the original; and how
        many are still pending."""
        expires_at = self._expires_at()
        signed: list[DisputePhotoOut] = []
        pending = 0
        for photo in photos:
            if photo.safe_status is MediaSafeStatus.PENDING:
                pending += 1
            safe = _safe_copy(photo)
            if safe is None:
                content_type = upload_content_type(photo.file_key)
                if content_type is None:  # pragma: no cover - checked when attached
                    logger.error("dispute_photo_key_refused", extra={"photo_id": str(photo.id)})
                    continue
                safe = (photo.file_key, content_type)
            signed.append(self._sign(photo, *safe, expires_at))
        return signed, pending

    def for_other_side(self, photos: Sequence[DisputePhoto]) -> tuple[list[DisputePhotoOut], int]:
        """The ready safe copies only, and how many are still pending."""
        expires_at = self._expires_at()
        signed: list[DisputePhotoOut] = []
        pending = 0
        for photo in photos:
            if photo.safe_status is MediaSafeStatus.PENDING:
                pending += 1
                continue
            if photo.safe_status is not MediaSafeStatus.READY:
                continue  # failed: never served
            safe = _safe_copy(photo)
            if safe is None:
                logger.error("dispute_photo_key_refused", extra={"photo_id": str(photo.id)})
                continue
            signed.append(self._sign(photo, *safe, expires_at))
        return signed, pending

    def _expires_at(self) -> datetime:
        return datetime.now(UTC) + timedelta(seconds=self._ttl)

    def _sign(
        self, photo: DisputePhoto, key: str, content_type: str, expires_at: datetime
    ) -> DisputePhotoOut:
        return DisputePhotoOut(
            id=photo.id,
            content_type=content_type,
            url=self._storage().presign_get(key, self._ttl),
            expires_at=expires_at,
        )


def _safe_copy(photo: DisputePhoto) -> tuple[str, str] | None:
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
