"""Worker side of the jobs module: privacy-safe copies of the job photos (#298), and the cron
that confirms jobs the customer left unanswered past JOB_AUTO_CONFIRM_AFTER_HOURS (#67).

auto_confirm_jobs takes one `now`, so one cut-off (now minus the window), and reads the jobs due
at it in batches of AUTO_CONFIRM_BATCH, by id, so each job comes up once per run. Each job is then
confirmed in a transaction of its own (JobAutoConfirmer.confirm_if_due: locked and checked again),
which holds that job's lock for its own few statements only: a customer confirming another job
never waits for the batch. A job that fails is rolled back and logged by error class, and the
run goes on with the next one; a batch that cannot be read ends the run. Whatever is left, the
next run does. Nothing raises out of the cron. Logs carry ids and counts only. One
`jobs_auto_confirmed` summary per run, even when the run is cut short.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from arq.worker import Function
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.jobs.confirmation import JobAutoConfirmer
from app.modules.jobs.photos import JobPhotoRows
from app.modules.requests.tasks import media_copy_task, run_media_copy

logger = logging.getLogger(__name__)

# Jobs read per query; each is then confirmed in its own transaction.
AUTO_CONFIRM_BATCH: Final = 200

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def sanitize_job_photos(ctx: dict[str, Any], job_id: str, photo_ids: list[str]) -> str:
    """ARQ task: makes the safe copy of each pending photo of one batch of a job, as for
    request media."""
    rows = JobPhotoRows([uuid.UUID(photo_id) for photo_id in photo_ids])
    return await run_media_copy(ctx, job_id, rows)


def photo_sanitize_task(settings: Settings) -> Function:
    """sanitize_job_photos as the worker registers it (app/worker.py)."""
    return media_copy_task(sanitize_job_photos, settings)


@dataclass
class _Counts:
    confirmed: int = 0
    skipped: int = 0
    failed: int = 0


async def auto_confirm_jobs(ctx: dict[str, Any]) -> None:
    """ARQ cron: confirms, as the system, the completed jobs whose confirmation window has
    passed (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    completed_before = datetime.now(UTC) - timedelta(hours=settings.job_auto_confirm_after_hours)
    counts = _Counts()
    after: uuid.UUID | None = None
    try:
        while True:
            try:
                async with sessions() as session:
                    due = await JobAutoConfirmer(session).due(
                        completed_before, after, AUTO_CONFIRM_BATCH
                    )
            # A batch that cannot be read, whatever the reason, ends the run; the next run
            # reads it again. By class only: a database error's text can hold SQL literals.
            except Exception as error:  # noqa: BLE001
                logger.error("job_auto_confirm_unavailable", extra={"error": type(error).__name__})
                return
            for job_id in due:
                await _confirm_one(sessions, job_id, completed_before, counts)
            if len(due) < AUTO_CONFIRM_BATCH:
                return
            after = due[-1]
    finally:
        logger.info(
            "jobs_auto_confirmed",
            extra={
                "confirmed": counts.confirmed,
                "skipped": counts.skipped,
                "failed": counts.failed,
            },
        )


async def _confirm_one(
    sessions: SessionFactory, job_id: uuid.UUID, completed_before: datetime, counts: _Counts
) -> None:
    """One job in its own transaction. Counted once; never raises."""
    try:
        async with sessions() as session:
            confirmed = await JobAutoConfirmer(session).confirm_if_due(job_id, completed_before)
            await session.commit()
    # One job's failure, whatever it is, never stops the others; the next run tries it again.
    # By class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        counts.failed += 1
        logger.error(
            "job_auto_confirm_failed",
            extra={"job_id": str(job_id), "error": type(error).__name__},
        )
        return
    if confirmed:
        counts.confirmed += 1
        logger.info("job_auto_confirmed", extra={"job_id": str(job_id)})
    else:
        # Confirmed by the customer or another run meanwhile, a problem opened, or gone.
        counts.skipped += 1
        logger.debug("job_auto_confirm_skipped", extra={"job_id": str(job_id)})
