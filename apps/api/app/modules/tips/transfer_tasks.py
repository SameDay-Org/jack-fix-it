"""Worker side of the tips' transfers to the pros (#273 PR A2), as payments/transfer_tasks.py is
for the jobs'.

release_tip_transfer runs once per tip that succeeded (the tip webhook queues it after its
commit, transfer_queue.py). release_succeeded_tips is the net under it: every
TRANSFER_RELEASE_SWEEP_MINUTES it reads up to TRANSFER_RELEASE_BATCH_SIZE succeeded tips whose
transfer is still to be made (TipTransferRepository.due: a pro who can be paid out, no dispute
or refund of the job, no attempt under way, a failed one only after
TRANSFER_STUCK_PENDING_MINUTES, nothing held for staff), least recently tried first, and
releases each. check_tip_transfer_reversals is the recovery of the read after each create, on
the same cadence: it reads each created tip transfer whose read has not succeeded, by its
stored Stripe id, and never creates anything.

Both go through TipTransferService with a session of their own per tip. One tip's failure,
whatever it is, is logged by error class and never stops the next; a batch that cannot be read
ends the run. Nothing raises out of either. Logs carry ids, counts and outcomes only.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any, Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_payments import StripePayments
from app.integrations.stripe_transfers import StripeTransfers
from app.modules.payments.transfers import TransferConfig
from app.modules.tips.transfers import TipTransferService

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]

# What a run reports for a tip whose release or check raised: not one of their own outcomes.
ERRORED: Final = "errored"


async def release_tip_transfer(ctx: dict[str, Any], tip_id: str) -> None:
    """ARQ task: releases one succeeded tip's transfer (see the module doc)."""
    outcome = await _one(ctx, uuid.UUID(tip_id), check=False)
    logger.info("tip_transfer_release_ran", extra={"tip_id": tip_id, "outcome": outcome})


async def release_succeeded_tips(ctx: dict[str, Any]) -> None:
    """ARQ cron: releases the succeeded tips whose transfer is still to be made."""
    await _sweep(ctx, check=False)


async def check_tip_transfer_reversals(ctx: dict[str, Any]) -> None:
    """ARQ cron: the recovery read of the tip transfers whose read after the create is still
    to succeed."""
    await _sweep(ctx, check=True)


async def _sweep(ctx: dict[str, Any], *, check: bool) -> None:
    sessions: SessionFactory = ctx["session_factory"]
    settings: Settings = ctx["settings"]
    summary = "tip_transfer_reversals_checked" if check else "tip_transfers_released"
    unavailable = (
        "tip_transfer_reversal_check_unavailable" if check else "tip_transfer_release_unavailable"
    )
    counts: dict[str, int] = {}
    try:
        try:
            async with sessions() as session:
                service = _service(ctx, session)
                limit = settings.transfer_release_batch_size
                ids = await (service.unchecked_for_reversal(limit) if check else service.due(limit))
        # A batch that cannot be read, whatever the reason, ends the run; the next run reads
        # it again. By class only: a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error(unavailable, extra={"error": type(error).__name__})
            return
        for tip_id in ids:
            outcome = await _one(ctx, tip_id, check=check)
            counts[outcome] = counts.get(outcome, 0) + 1
    finally:
        logger.info(summary, extra={"outcomes": counts})


async def _one(ctx: dict[str, Any], tip_id: uuid.UUID, *, check: bool) -> str:
    """One tip in a session of its own. Never raises: returns the outcome, or ERRORED for
    anything it raised."""
    sessions: SessionFactory = ctx["session_factory"]
    try:
        async with sessions() as session:
            service = _service(ctx, session)
            outcome = await (service.check_reversal(tip_id) if check else service.release(tip_id))
    # One tip's failure, whatever it is, never stops the others; the sweep tries it again. By
    # class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        logger.error(
            "tip_transfer_check_errored" if check else "tip_transfer_release_failed",
            extra={"tip_id": str(tip_id), "error": type(error).__name__},
        )
        return ERRORED
    return outcome.value


def _service(ctx: dict[str, Any], session: AsyncSession) -> TipTransferService:
    settings: Settings = ctx["settings"]
    payments: StripePayments | None = ctx.get("stripe_payments")
    transfers: StripeTransfers | None = ctx.get("stripe_transfers")
    return TipTransferService(session, payments, transfers, TransferConfig.from_settings(settings))
