"""Worker side of the transfers to the pros (D13.3, #68): the task queued when a job is
confirmed, and the cron that releases whatever is still waiting.

release_transfer runs once per confirmation: the customer's confirm (#66) and the 48 h
auto-confirm (#67) queue it after their commit (transfer_queue.py). release_confirmed_jobs is the
net under both: every TRANSFER_RELEASE_SWEEP_MINUTES it reads up to TRANSFER_RELEASE_BATCH_SIZE
confirmed jobs whose transfer is still to be made, least recently tried first
(TransferRepository.due: a pro who can be paid out, no attempt under way, a failed one only after
TRANSFER_STUCK_PENDING_MINUTES), and releases each. So a job whose task was never queued (Redis
down), whose attempt failed, whose answer was lost, or whose pro could not be paid out at the
time is released by a later run, and a job that keeps failing goes to the back of the line and
never holds the others up.

check_transfer_reversals is the recovery of a transfer's reversal check (#416 r2): on the same
cadence, timeout and batch size as the release sweep, it reads again, by its stored Stripe id,
each created transfer whose check after its create did not succeed (a failed read, a cancelled
task, a dead worker, or a row older than the check), once TRANSFER_STUCK_PENDING_MINUTES have
passed since the latest try, least recently tried first. Whatever the job's state (it is
paid_out by then), and it never creates anything: one read, a reversal recorded if Stripe holds
one, the check stamped. One `transfer_reversals_checked` summary per run.

Both go through TransferService.release with a session of their own per job, so the same checks,
the same row and the same Stripe key: a task and a sweep, or two sweeps, on one job make one
transfer. One job's failure, whatever it is, is logged by error class and never stops the next;
a batch that cannot be read ends the run. Nothing raises out of either. Logs carry ids, counts
and outcomes only. One `transfers_released` summary per run of the sweep, even when it is cut
short.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_transfers import StripeTransfers
from app.modules.payments.transfers import (
    ReleaseOutcome,
    ReversalCheckOutcome,
    TransferConfig,
    TransferService,
)

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def release_transfer(ctx: dict[str, Any], job_id: str) -> None:
    """ARQ task: releases one confirmed job's transfer (see the module doc)."""
    outcome = await _release_one(ctx, uuid.UUID(job_id))
    logger.info("transfer_release_ran", extra={"job_id": job_id, "outcome": outcome})


async def release_confirmed_jobs(ctx: dict[str, Any]) -> None:
    """ARQ cron: releases the confirmed jobs whose transfer is still to be made (see the
    module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    counts: dict[str, int] = {}
    try:
        try:
            async with sessions() as session:
                due = await _service(ctx, session).due(settings.transfer_release_batch_size)
        # A batch that cannot be read, whatever the reason, ends the run; the next run reads
        # it again. By class only: a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error("transfer_release_unavailable", extra={"error": type(error).__name__})
            return
        for job_id in due:
            outcome = await _release_one(ctx, job_id)
            counts[outcome] = counts.get(outcome, 0) + 1
    finally:
        logger.info("transfers_released", extra={"outcomes": counts})


async def check_transfer_reversals(ctx: dict[str, Any]) -> None:
    """ARQ cron: the recovery read of the transfers whose reversal check is still to succeed
    (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    counts: dict[str, int] = {}
    try:
        try:
            async with sessions() as session:
                unchecked = await _service(ctx, session).unchecked_for_reversal(
                    settings.transfer_release_batch_size
                )
        # A batch that cannot be read ends the run; the next run reads it again. By class
        # only: a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error(
                "transfer_reversal_check_unavailable", extra={"error": type(error).__name__}
            )
            return
        for transfer_id in unchecked:
            outcome = await _check_one(ctx, transfer_id)
            counts[outcome] = counts.get(outcome, 0) + 1
    finally:
        logger.info("transfer_reversals_checked", extra={"outcomes": counts})


async def _check_one(ctx: dict[str, Any], transfer_id: uuid.UUID) -> str:
    """One transfer in a session of its own. Never raises: returns the check's outcome, or
    ERRORED for anything it raised."""
    sessions: SessionFactory = ctx["session_factory"]
    try:
        async with sessions() as session:
            outcome: ReversalCheckOutcome = await _service(ctx, session).check_reversal(transfer_id)
    # One row's failure never stops the others; its stamp sends it to the back of the line.
    except Exception as error:  # noqa: BLE001
        logger.error(
            "transfer_reversal_check_errored",
            extra={"transfer_id": str(transfer_id), "error": type(error).__name__},
        )
        return ERRORED
    return outcome.value


# What _release_one reports for a release that raised: not one of release's own outcomes.
ERRORED = "errored"


async def _release_one(ctx: dict[str, Any], job_id: uuid.UUID) -> str:
    """One job in a session of its own. Never raises: returns the release's outcome, or
    ERRORED for anything it raised."""
    sessions: SessionFactory = ctx["session_factory"]
    try:
        async with sessions() as session:
            outcome: ReleaseOutcome = await _service(ctx, session).release(job_id)
    # One job's failure, whatever it is, never stops the others; the sweep tries it again. By
    # class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        logger.error(
            "transfer_release_failed",
            extra={"job_id": str(job_id), "error": type(error).__name__},
        )
        return ERRORED
    return outcome.value


def _service(ctx: dict[str, Any], session: AsyncSession) -> TransferService:
    settings: Settings = ctx["settings"]
    stripe: StripeTransfers | None = ctx.get("stripe_transfers")
    return TransferService(session, stripe, TransferConfig.from_settings(settings))
