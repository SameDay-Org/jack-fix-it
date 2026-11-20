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
- fair progress (#491 rounds 1 to 3): it reads up to SCAN_FACTOR times
  MEDIA_SANITIZE_RESWEEP_BATCH_SIZE of the oldest rows per kind, skips the units (a request, a
  photo) it queued within the wait window, and queues up to the batch size of the rest, never
  queued first, then least recently queued, then oldest. When each unit was last queued is kept
  in the queue's Redis (a sorted set per kind, trimmed by time to history_keep(), which outlasts
  any rotation of the scan at any valid wait and cadence), so rows that keep being postponed take
  turns with the others however the window expires: every unit within the scan is queued within
  as many runs as there are units ahead of it.

A copy is claimed per row (media_copies), so a sweep's copy never runs at once with another copy
of the same row. Rows that failed for good (a file that can never be made safe) are never queued
again. A batch that cannot be read, or a store that does not answer (its claims or its history,
read or written), ends the run before any further batch; one queue failure is logged and never
stops the next. Nothing raises out of it. Logs carry ids and counts only.
"""

import logging
import math
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
# units that are recent or held.
SCAN_FACTOR: Final = 10
# The history's keep, in its two floors (history_keep): wait windows or cron runs, whichever is
# longer, and rotations of the scan.
HISTORY_WINDOWS: Final = 168
HISTORY_ROTATIONS: Final = 24


def utc_now() -> datetime:
    return datetime.now(UTC)


def history_keep(settings: Settings) -> timedelta:
    """How long the history remembers when a unit was queued (#491 round 3).

    A unit the history forgot counts as never queued, so it goes first again: forgotten within
    a rotation, units ahead of the rest take every turn (A, B, C, D, A... and E never). So the
    keep outlasts any rotation of the scan, at any valid wait (MEDIA_SANITIZE_RESWEEP_AFTER_
    MINUTES) and cadence (MEDIA_SANITIZE_RESWEEP_MINUTES), which are independent. The scan holds
    at most SCAN_FACTOR batches and a run queues one, so every unit of it has its turn within
    SCAN_FACTOR runs once due, and a unit waits a window between turns: a rotation lasts at most
    SCAN_FACTOR * max(window, cadence). The keep is the longer of HISTORY_WINDOWS (168) times
    max(window, cadence) and HISTORY_ROTATIONS (24) rotations of SCAN_FACTOR runs at the
    cadence: a week at the defaults, ten days at an hourly cadence. Still bounded: it is trimmed
    by time on every write (never by count) and the set expires after it.
    """
    window = settings.media_sanitize_resweep_after_minutes
    cadence = settings.media_sanitize_resweep_minutes
    by_window = max(window, cadence) * HISTORY_WINDOWS
    return timedelta(minutes=max(by_window, cadence * SCAN_FACTOR * HISTORY_ROTATIONS))


@dataclass(frozen=True)
class _Unit:
    """What one queued copy covers: a request's pending rows, or one photo."""

    parent_id: uuid.UUID
    row_ids: tuple[uuid.UUID, ...]
    mark: str


@dataclass(frozen=True)
class _Kind:
    """One kind of media row: its name in the counts, its rows' parent field (the claims' and
    the history's namespace), and whether a unit is one row (photos) or a parent (requests)."""

    name: str
    field: str
    per_row: bool


_REQUESTS: Final = _Kind("requests", REQUEST_MEDIA_ROWS.parent_field, per_row=False)
_JOBS: Final = _Kind("jobs", JobPhotoRows.parent_field, per_row=True)
_DISPUTES: Final = _Kind("disputes", DisputePhotoRows.parent_field, per_row=True)


def store_of(ctx: dict[str, Any], settings: Settings) -> MediaCopyStore:
    """The rows' claims and the sweep's history: the queue's own Redis (tests pass their own)."""
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
    now = clock()
    window = timedelta(minutes=settings.media_sanitize_resweep_after_minutes)
    limit = settings.media_sanitize_resweep_batch_size
    timeout = settings.job_enqueue_timeout_seconds
    keep = int(history_keep(settings).total_seconds())
    counts = {"requests": 0, "jobs": 0, "disputes": 0, "failed": 0}
    try:
        async with sessions() as session:
            scan = limit * SCAN_FACTOR
            rows = {
                _REQUESTS: await stale_pending_request_media(session, now - window, scan),
                _JOBS: await stale_job_photos(session, now - window, scan),
                _DISPUTES: await stale_dispute_photos(session, now - window, scan),
            }
        store = store_of(ctx, settings)
        chosen = {
            kind: await _choose(store, kind, found, limit, now=now, window=window)
            for kind, found in rows.items()
        }
        for kind, units in chosen.items():
            queued: list[str] = []
            for unit in units:
                if await _queue(
                    counts, kind.name, unit.parent_id, _enqueue(queue, kind, unit, timeout)
                ):
                    queued.append(unit.mark)
            # Unrecorded, these units would go first again on every run: a history that cannot
            # be written ends the run before the next kind's batch (#491 round 3).
            await store.record_queued(kind.field, queued, now.timestamp(), keep)
    # A batch that cannot be read, or a store that does not answer, ends the run; the next run
    # reads it again. By class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        logger.error("media_resweep_unavailable", extra={"error": type(error).__name__})
    finally:
        logger.info("media_copies_requeued", extra={"queued": counts})


def _enqueue(queue: JobQueue, kind: _Kind, unit: _Unit, timeout: float) -> Awaitable[bool]:
    if kind is _REQUESTS:
        return enqueue_sanitize(queue, unit.parent_id, timeout)
    if kind is _JOBS:
        return enqueue_photo_sanitize(queue, unit.parent_id, unit.row_ids, timeout)
    return enqueue_dispute_photo_sanitize(queue, unit.parent_id, unit.row_ids, timeout)


async def _choose(
    store: MediaCopyStore,
    kind: _Kind,
    rows: Sequence[tuple[uuid.UUID, uuid.UUID]],
    limit: int,
    *,
    now: datetime,
    window: timedelta,
) -> list[_Unit]:
    """Up to `limit` units from `rows` (oldest first): rows another run holds are left out,
    and units queued within the window; the rest never queued first, then least recently
    queued, then oldest."""
    held = await store.held([row_key(kind.field, row_id) for _, row_id in rows])
    free = [(parent, row) for parent, row in rows if row_key(kind.field, row) not in held]
    units: list[_Unit]
    if kind.per_row:
        units = [_Unit(parent, (row,), row_key(kind.field, row)) for parent, row in free]
    else:
        grouped: dict[uuid.UUID, list[uuid.UUID]] = {}
        for parent, row in free:
            grouped.setdefault(parent, []).append(row)
        units = [
            _Unit(parent, tuple(row_ids), row_key(kind.field, parent))
            for parent, row_ids in grouped.items()
        ]
    last = await store.last_queued(kind.field, [unit.mark for unit in units])
    since = (now - window).timestamp()
    due = [unit for unit in units if last.get(unit.mark, -math.inf) <= since]
    turns = sorted(range(len(due)), key=lambda index: (last.get(due[index].mark, -math.inf), index))
    return [due[index] for index in turns][:limit]


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
