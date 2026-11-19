"""The sweep of safe copies left pending (#473): the net under the copy tasks of request media
(#173), job photos (#298) and dispute photos (#75), which share one copier
(app.modules.requests.media_copies).

A row stays pending when an outage of the storage, or of ffmpeg, outlasted its copy's tries
(media_sanitize_postponed), or when its copy was never queued (Redis down at the commit). Every
MEDIA_SANITIZE_RESWEEP_MINUTES this cron reads up to MEDIA_SANITIZE_RESWEEP_BATCH_SIZE rows of
each kind still pending MEDIA_SANITIZE_RESWEEP_AFTER_MINUTES after they were attached, oldest
first, and queues their copy again, through each module's own task and job id: a request's copy
by its id, a job's or a dispute's photos as one batch per parent. A copy is idempotent per row
(one safe key per row, marked ready only while pending), so a copy queued while an earlier chain
of tries still runs, or queued twice, only repeats its work. Rows that failed for good (a file
that can never be made safe) are never queued again.

A batch that cannot be read ends the run; one queue failure is logged and never stops the next.
Nothing raises out of it. Logs carry ids and counts only.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.disputes.photos import enqueue_dispute_photo_sanitize
from app.modules.disputes.photos import stale_pending_photos as stale_dispute_photos
from app.modules.jobs.photos import enqueue_photo_sanitize
from app.modules.jobs.photos import stale_pending_photos as stale_job_photos
from app.modules.requests.media_copies import enqueue_sanitize, stale_pending_requests
from app.queue import JobQueue

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


def utc_now() -> datetime:
    return datetime.now(UTC)


async def requeue_stale_media_copies(
    ctx: dict[str, Any], clock: Callable[[], datetime] = utc_now
) -> None:
    """ARQ cron: queues again the copy of every row still pending (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    queue: JobQueue = ctx["redis"]
    before = clock() - timedelta(minutes=settings.media_sanitize_resweep_after_minutes)
    limit = settings.media_sanitize_resweep_batch_size
    timeout = settings.job_enqueue_timeout_seconds
    counts = {"requests": 0, "jobs": 0, "disputes": 0, "failed": 0}
    try:
        try:
            async with sessions() as session:
                requests = await stale_pending_requests(session, before, limit)
                jobs = await stale_job_photos(session, before, limit)
                disputes = await stale_dispute_photos(session, before, limit)
        # A batch that cannot be read ends the run; the next run reads it again. By class only:
        # a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error("media_resweep_unavailable", extra={"error": type(error).__name__})
            return
        for request_id in requests:
            await _queue(
                counts, "requests", request_id, enqueue_sanitize(queue, request_id, timeout)
            )
        for job_id, photo_ids in jobs.items():
            await _queue(
                counts, "jobs", job_id, enqueue_photo_sanitize(queue, job_id, photo_ids, timeout)
            )
        for dispute_id, photo_ids in disputes.items():
            await _queue(
                counts,
                "disputes",
                dispute_id,
                enqueue_dispute_photo_sanitize(queue, dispute_id, photo_ids, timeout),
            )
    finally:
        logger.info("media_copies_requeued", extra={"queued": counts})


async def _queue(
    counts: dict[str, int], kind: str, parent_id: uuid.UUID, enqueued: Awaitable[bool]
) -> None:
    """One parent's copy queued; a queue failure is logged (ids only) and counted."""
    try:
        await enqueued
    except (RedisError, OSError):  # TimeoutError is an OSError
        counts["failed"] += 1
        logger.error(
            "media_resweep_enqueue_failed", extra={"kind": kind, "parent_id": str(parent_id)}
        )
        return
    counts[kind] += 1
