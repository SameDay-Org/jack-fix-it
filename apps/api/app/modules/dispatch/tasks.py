"""Worker side of dispatch (D9.1, #48): the ARQ task POST /v1/requests queues, and the
re-dispatch of requests no dispatch reached (#478, dispatch.stalled).

The re-dispatch never dispatches inline: it queues `dispatch_request` for each stalled request
under its own job id (`dispatch:<request id>`, deduped while queued), and that run locks the
request and checks everything again, so overlapping sweeps, a sweep and a kick, or a sweep and
the BDC never make a second row for a request and pro. A request that has a row by then, or that
the BDC moved on, is left as it is (ALREADY_DISPATCHED, NOT_DISPATCHABLE). Logs carry ids and
counts only.
"""

import logging
import uuid
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

from redis.exceptions import RedisError

from app.config import Settings
from app.modules.dispatch.history import RedispatchHistory, RedisRedispatchHistory
from app.modules.dispatch.service import DispatchService, enqueue_dispatch
from app.modules.dispatch.stalled import (
    StalledScan,
    SweepConfig,
    stalled_requests_for_pro,
    sweep_batch,
)
from app.modules.notifications.events import push_new_request
from app.queue import JobQueue

logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    return datetime.now(UTC)


async def dispatch_request(ctx: dict[str, Any], request_id: str) -> str:
    """ARQ task: dispatches one request in its own transaction and returns the outcome. A
    database error fails the job (ARQ logs it); the request keeps its status, and the BDC can
    run dispatch again (#82). Once committed, each dispatched pro gets a new request push
    (#55); a push that cannot be queued is logged, never undone."""
    async with ctx["session_factory"]() as session:
        result = await DispatchService(session).dispatch(uuid.UUID(request_id))
        await session.commit()
    if result.new:
        settings: Settings = ctx["settings"]
        # ARQ's own pool (an ArqRedis) queues the pushes; tests pass a fake queue.
        queue: JobQueue = ctx["redis"]
        for dispatch in result.new:
            await push_new_request(
                queue,
                pro_user_id=dispatch.pro_user_id,
                dispatch_id=dispatch.id,
                public_code=dispatch.public_code,
                timeout_seconds=settings.job_enqueue_timeout_seconds,
            )
    return str(result.outcome)


async def redispatch_stalled_requests(
    ctx: dict[str, Any], clock: Callable[[], datetime] = utc_now
) -> None:
    """ARQ cron (#478): the sweep of stalled requests (dispatch.stalled), its history in the
    queue's Redis (dispatch.history)."""
    await sweep_stalled(ctx, RedisRedispatchHistory(ctx["redis"]), clock)


async def sweep_stalled(
    ctx: dict[str, Any], history: RedispatchHistory, clock: Callable[[], datetime] = utc_now
) -> None:
    """One sweep run: reads the next batch of stalled requests from where the last run stopped
    (passing over those queued within REDISPATCH_RETRY_MINUTES), records the attempt, then
    queues each one's dispatch. Nothing raises out of it. One `redispatch_swept` summary per
    run that queued, else one class-only error:

    - the database or the history cannot be read (`redispatch_sweep_unavailable`): the run
      ends, and the next one reads the same batch again. There is no fallback scan.
    - the history cannot be written (`redispatch_history_unavailable`): the run ends before
      queueing anything. Queueing without the record would leave the cursor in place, and the
      next run would take the same batch again, every run: the very starvation the history
      prevents.
    """
    settings: Settings = ctx["settings"]
    now = clock()
    scan = StalledScan.at(now, settings)
    config = SweepConfig.from_settings(settings)
    try:
        async with ctx["session_factory"]() as session:
            batch = await sweep_batch(session, history, scan, config, now)
    # By class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        logger.error("redispatch_sweep_unavailable", extra={"error": type(error).__name__})
        return
    try:
        await history.record(
            [str(request_id) for request_id in batch.due],
            clock().timestamp(),
            batch.next_cursor,
            int(config.keep.total_seconds()),
        )
    except Exception as error:  # noqa: BLE001
        logger.error("redispatch_history_unavailable", extra={"error": type(error).__name__})
        return
    counts = await _queue_dispatches(ctx["redis"], batch.due, settings)
    logger.info("redispatch_swept", extra={**counts, "passed_over": batch.passed_over})


async def redispatch_for_pro(
    ctx: dict[str, Any], pro_id: str, clock: Callable[[], datetime] = utc_now
) -> None:
    """ARQ task (#478, dispatch.kicks): queues the dispatch of the stalled requests this pro
    could take now. One try: a run that fails is logged by ARQ, and the sweep takes them."""
    settings: Settings = ctx["settings"]
    scan = StalledScan.at(clock(), settings)
    async with ctx["session_factory"]() as session:
        request_ids = await stalled_requests_for_pro(session, uuid.UUID(pro_id), scan)
    counts = await _queue_dispatches(ctx["redis"], request_ids, settings)
    logger.info("redispatch_for_pro_done", extra={"pro_id": pro_id, **counts})


async def _queue_dispatches(
    queue: JobQueue, request_ids: Sequence[uuid.UUID], settings: Settings
) -> dict[str, int]:
    """Each request's dispatch queued under its job id: `skipped` when one is queued already.
    One queue failure is logged (ids only), counted, and never stops the next."""
    counts = {"swept": len(request_ids), "enqueued": 0, "skipped": 0, "failed": 0}
    for request_id in request_ids:
        try:
            queued = await enqueue_dispatch(queue, request_id, settings.job_enqueue_timeout_seconds)
        except (RedisError, OSError):  # TimeoutError is an OSError
            counts["failed"] += 1
            logger.error("redispatch_enqueue_failed", extra={"service_request_id": str(request_id)})
            continue
        counts["enqueued" if queued else "skipped"] += 1
    return counts
