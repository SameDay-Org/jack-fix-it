"""Worker side of a cancelled job's refund (#69): the task queued at the cancel, and the cron
that makes whatever is left.

refund_cancellation runs once per cancel, queued after the commit that cancelled the job
(enqueue_cancel_refund). retry_cancel_refunds is the net under it: every
CANCEL_REFUND_SWEEP_MINUTES it reads up to CANCEL_REFUND_BATCH_SIZE refunds left without
Stripe's answer for REFUND_STUCK_PENDING_MINUTES (CancelRefunds.due: a task never queued, a
worker that died, Stripe unavailable, a lost answer), least recently tried first, and makes
each. Both go through CancelRefunds.make with a session of their own per job, so the same row,
lock and Stripe key: a task and a sweep, or two sweeps, on one job make one refund.

One job's failure, whatever it is, is logged by error class and never stops the next; a batch
that cannot be read ends the run. Nothing raises out of either. Logs carry ids, counts and
outcomes only.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import timedelta
from typing import Any, Final

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_refunds import StripeRefunds, worker_stripe_refunds
from app.modules.payments.cancel_refunds import CancelRefundOutcome, CancelRefunds
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]

# The worker function's name (refund_cancellation below, registered in app/worker.py).
REFUND_CANCELLATION_TASK: Final = "refund_cancellation"
# What a run reports for a make that raised: not one of make's own outcomes.
ERRORED: Final = "errored"


async def enqueue_cancel_refund(queue: JobQueue, job_id: uuid.UUID, timeout_seconds: float) -> None:
    """Queues the refund of the cancelled job, after the commit that cancelled it. One queued
    run per job at a time (the job id names it). Never raises for a queue failure: the cancel
    stands, and the sweep makes the refund on a later run. Logged with the job id only."""
    try:
        await enqueue(
            queue,
            REFUND_CANCELLATION_TASK,
            str(job_id),
            job_id=f"refund-cancellation:{job_id}",
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        logger.error("cancel_refund_enqueue_failed", extra={"job_id": str(job_id)})


async def refund_cancellation(ctx: dict[str, Any], job_id: str) -> None:
    """ARQ task: makes one cancelled job's refund (see the module doc)."""
    outcome = await _make_one(ctx, uuid.UUID(job_id))
    logger.info("cancel_refund_ran", extra={"job_id": job_id, "outcome": outcome})


async def retry_cancel_refunds(ctx: dict[str, Any]) -> None:
    """ARQ cron: makes the cancellation refunds left without Stripe's answer (module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    counts: dict[str, int] = {}
    try:
        try:
            async with sessions() as session:
                due = await _service(ctx, session).due(settings.cancel_refund_batch_size)
        # A batch that cannot be read ends the run; the next run reads it again. By class
        # only: a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error("cancel_refunds_unavailable", extra={"error": type(error).__name__})
            return
        for job_id in due:
            outcome = await _make_one(ctx, job_id)
            counts[outcome] = counts.get(outcome, 0) + 1
    finally:
        logger.info("cancel_refunds_retried", extra={"outcomes": counts})


async def _make_one(ctx: dict[str, Any], job_id: uuid.UUID) -> str:
    """One job in a session of its own. Never raises: returns make's outcome, or ERRORED."""
    sessions: SessionFactory = ctx["session_factory"]
    try:
        async with sessions() as session:
            outcome: CancelRefundOutcome = await _service(ctx, session).make(job_id)
    # One job's failure never stops the others; the sweep tries it again. By class only.
    except Exception as error:  # noqa: BLE001
        logger.error(
            "cancel_refund_errored", extra={"job_id": str(job_id), "error": type(error).__name__}
        )
        return ERRORED
    return outcome.value


def _service(ctx: dict[str, Any], session: AsyncSession) -> CancelRefunds:
    settings: Settings = ctx["settings"]
    # Tests pass a fake under "stripe_refunds"; the worker builds its own client.
    stripe: StripeRefunds | None = (
        ctx["stripe_refunds"] if "stripe_refunds" in ctx else worker_stripe_refunds()
    )
    return CancelRefunds(session, stripe, timedelta(minutes=settings.refund_stuck_pending_minutes))
