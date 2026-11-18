"""Worker side of the disputes module: the privacy-safe copies of the customer's dispute photos
(#75), made by the request media's copier as the job photos' are (#298)."""

import uuid
from typing import Any

from arq.worker import Function

from app.config import Settings
from app.modules.disputes.photos import DisputePhotoRows
from app.modules.requests.tasks import media_copy_task, run_media_copy


async def sanitize_dispute_photos(
    ctx: dict[str, Any], dispute_id: str, photo_ids: list[str]
) -> str:
    """ARQ task: makes the safe copy of each pending photo of a dispute."""
    rows = DisputePhotoRows([uuid.UUID(photo_id) for photo_id in photo_ids])
    return await run_media_copy(ctx, dispute_id, rows)


def dispute_photo_sanitize_task(settings: Settings) -> Function:
    """sanitize_dispute_photos as the worker registers it (app/worker.py)."""
    return media_copy_task(sanitize_dispute_photos, settings)
