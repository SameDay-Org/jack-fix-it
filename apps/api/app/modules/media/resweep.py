"""The sweep of safe copies left pending (#473): the net under the copy tasks of request media
(#173), job photos (#298) and dispute photos (#75), which share one copier
(app.modules.requests.media_copies).

A row stays pending when an outage of the storage, or of ffmpeg, outlasted its copy's tries
(media_sanitize_postponed), or when its copy was never queued (Redis down at the commit). Every
MEDIA_SANITIZE_RESWEEP_MINUTES this cron reads, per kind, the oldest rows still pending
MEDIA_SANITIZE_RESWEEP_AFTER_MINUTES after they were attached and queues their copy again,
through each module's own task:

- request media by its request (the task copies every pending row of the request), job and
  dispute photos one photo at a time, under a job id per row, so a repeated sweep's task dedupes
  against its own (#491 round 1);
- a row another run holds now (its claim in app.modules.media.copy_store) is left to it;
- fair progress (#491 round 1): each unit it queues (a request, a photo) is marked for one wait
  window and skipped while marked, so up to MEDIA_SANITIZE_RESWEEP_BATCH_SIZE units are queued
  per kind and run from up to SCAN_FACTOR times as many of the oldest rows: rows that keep
  being postponed never hold every slot, and the rows behind them are reached on the next runs.

A copy is claimed per row (media_copies), so a sweep's copy never runs at once with another copy
of the same row. Rows that failed for good (a file that can never be made safe) are never queued
again. A batch that cannot be read, or a store that does not answer, ends the run; one queue
failure is logged and never stops the next. Nothing raises out of it. Logs carry ids and counts
only.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.disputes.photos import DisputePhotoRows, enqueue_dispute_photo_sanitize
from app.modules.disputes.photos import stale_pending_photos as stale_dispute_photos
from app.modules.jobs.photos import JobPhotoRows, enqueue_photo_sanitize
from app.modules.jobs.photos import stale_pending_photos as stale_job_photos
from app.modules.media.copy_store import MediaCopyStore, RedisMediaCopyStore, row_key
from app.modules.requests.media_copies import (
    REQUEST_MEDIA_ROWS,
    MediaCopyConfig,
    claim_seconds,
    enqueue_sanitize,
    stale_pending_request_media,
)
from app.queue import JobQueue

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]
# How many of the oldest pending rows a run reads per unit it may queue: the reach behind
# units that are marked or held.
SCAN_FACTOR: Final = 10


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class _Unit:
    """What one queued copy covers: a request's pending rows, or one photo."""

    parent_id: uuid.UUID
    row_ids: tuple[uuid.UUID, ...]
    mark: str


def store_of(ctx: dict[str, Any], settings: Settings) -> MediaCopyStore:
    """The rows' claims and the sweep's marks: the queue's own Redis (tests pass their own)."""
    store: MediaCopyStore | None = ctx.get("media_copy_store")
    if store is not None:
        return store
    config = MediaCopyConfig.from_settings(settings)
    return RedisMediaCopyStore(ctx["redis"], claim_seconds=claim_seconds(config))


async def requeue_stale_media_copies(
    ctx: dict[str, Any], clock: Callable[[], datetime] = utc_now
) -> None:
    """ARQ cron: queues again the copy of the rows still pending (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    queue: JobQueue = ctx["redis"]
    window = timedelta(minutes=settings.media_sanitize_resweep_after_minutes)
    before = clock() - window
    limit = settings.media_sanitize_resweep_batch_size
    timeout = settings.job_enqueue_timeout_seconds
    counts = {"requests": 0, "jobs": 0, "disputes": 0, "failed": 0}
    try:
        try:
            async with sessions() as session:
                scan = limit * SCAN_FACTOR
                requests = await stale_pending_request_media(session, before, scan)
                jobs = await stale_job_photos(session, before, scan)
                disputes = await stale_dispute_photos(session, before, scan)
            store = store_of(ctx, settings)
            chosen = {
                "requests": await _choose(
                    store, REQUEST_MEDIA_ROWS.parent_field, requests, limit, per_row=False
                ),
                "jobs": await _choose(store, JobPhotoRows.parent_field, jobs, limit, per_row=True),
                "disputes": await _choose(
                    store, DisputePhotoRows.parent_field, disputes, limit, per_row=True
                ),
            }
        # A batch that cannot be read, or a store that does not answer, ends the run; the next
        # run reads it again. By class only: a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error("media_resweep_unavailable", extra={"error": type(error).__name__})
            return
        queued: list[str] = []
        for unit in chosen["requests"]:
            enqueued = enqueue_sanitize(queue, unit.parent_id, timeout)
            if await _queue(counts, "requests", unit.parent_id, enqueued):
                queued.append(unit.mark)
        for unit in chosen["jobs"]:
            enqueued = enqueue_photo_sanitize(queue, unit.parent_id, unit.row_ids, timeout)
            if await _queue(counts, "jobs", unit.parent_id, enqueued):
                queued.append(unit.mark)
        for unit in chosen["disputes"]:
            enqueued = enqueue_dispute_photo_sanitize(queue, unit.parent_id, unit.row_ids, timeout)
            if await _queue(counts, "disputes", unit.parent_id, enqueued):
                queued.append(unit.mark)
        await _mark(store, queued, int(window.total_seconds()))
    finally:
        logger.info("media_copies_requeued", extra={"queued": counts})


async def _choose(
    store: MediaCopyStore,
    kind: str,
    rows: Sequence[tuple[uuid.UUID, uuid.UUID]],
    limit: int,
    *,
    per_row: bool,
) -> list[_Unit]:
    """Up to `limit` units from `rows` (oldest first): rows another run holds are left out, and
    so are units the sweep queued within their window."""
    held = await store.held([row_key(kind, row_id) for _, row_id in rows])
    free = [(parent, row) for parent, row in rows if row_key(kind, row) not in held]
    units: list[_Unit] = []
    if per_row:
        units = [_Unit(parent, (row,), row_key(kind, row)) for parent, row in free]
    else:
        grouped: dict[uuid.UUID, list[uuid.UUID]] = {}
        for parent, row in free:
            grouped.setdefault(parent, []).append(row)
        units = [
            _Unit(parent, tuple(row_ids), row_key(kind, parent))
            for parent, row_ids in grouped.items()
        ]
    recent = await store.recent([unit.mark for unit in units])
    return [unit for unit in units if unit.mark not in recent][:limit]


async def _queue(
    counts: dict[str, int], kind: str, parent_id: uuid.UUID, enqueued: Awaitable[bool]
) -> bool:
    """One unit's copy queued (or already queued under its job id); a queue failure is logged
    (ids only), counted, and False."""
    try:
        await enqueued
    except (RedisError, OSError):  # TimeoutError is an OSError
        counts["failed"] += 1
        logger.error(
            "media_resweep_enqueue_failed", extra={"kind": kind, "parent_id": str(parent_id)}
        )
        return False
    counts[kind] += 1
    return True


async def _mark(store: MediaCopyStore, marks: Sequence[str], seconds: int) -> None:
    """The units queued, marked for one window. A store that fails is logged: the next run may
    then queue them again, which only repeats work."""
    try:
        await store.mark(marks, seconds)
    except (RedisError, OSError) as error:
        logger.warning("media_resweep_mark_failed", extra={"error": type(error).__name__})
