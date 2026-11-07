"""Worker side of the jobs module: privacy-safe copies of the job photos (#298)."""

import uuid
from typing import Any

from arq.worker import Function

from app.config import Settings
from app.modules.jobs.photos import JobPhotoRows
from app.modules.requests.tasks import media_copy_task, run_media_copy


async def sanitize_job_photos(ctx: dict[str, Any], job_id: str, photo_ids: list[str]) -> str:
    """ARQ task: makes the safe copy of each pending photo of one batch of a job, as for
    request media."""
    rows = JobPhotoRows([uuid.UUID(photo_id) for photo_id in photo_ids])
    return await run_media_copy(ctx, job_id, rows)


def photo_sanitize_task(settings: Settings) -> Function:
    """sanitize_job_photos as the worker registers it (app/worker.py)."""
    return media_copy_task(sanitize_job_photos, settings)
