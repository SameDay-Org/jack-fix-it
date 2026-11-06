"""Worker side of the jobs module: privacy-safe copies of the job photos (#298)."""

from typing import Any

from arq.worker import Function

from app.config import Settings
from app.modules.jobs.photos import JOB_PHOTO_ROWS
from app.modules.requests.tasks import media_copy_task, run_media_copy


async def sanitize_job_photos(ctx: dict[str, Any], job_id: str) -> str:
    """ARQ task: makes the safe copy of each pending photo of one job, as for request media."""
    return await run_media_copy(ctx, job_id, JOB_PHOTO_ROWS)


def photo_sanitize_task(settings: Settings) -> Function:
    """sanitize_job_photos as the worker registers it (app/worker.py)."""
    return media_copy_task(sanitize_job_photos, settings)
