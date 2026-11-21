"""transfer.reversed for a tip's transfer (#273 PR A2), routed here by the webhook registry when
the transfer's metadata kind is "tip" (app.modules.webhooks.handlers).

The tip holding that exact Stripe transfer id goes created -> reversed, once, and an error is
logged with ids for staff (nothing in the app reverses a tip transfer: staff do it in Stripe,
docs/stripe-money.md). The metadata routes the event; only the exact Stripe id selects a row.
An event for a transfer no tip holds as created changes nothing: its create answer is not
stored yet, and the release that stores it reads the transfer again right after its commit
(tips/transfers.py, step 4), or the recovery cron does, through record_tip_transfer_reversal,
the same path. Whichever comes second changes nothing.

The handler never commits: the worker does (#40). A malformed object is the job transfer
handler's error (transfer_webhooks._transfer_id): logged and raised.
"""

import logging
import uuid
from collections.abc import Mapping
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.transfer_webhooks import transfer_id_of
from app.modules.tips.repository import TipTransferRepository
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler

logger = logging.getLogger(__name__)


async def record_tip_transfer_reversal(
    session: AsyncSession, stripe_transfer_id: str, ids: Mapping[str, str | int]
) -> bool:
    """created -> reversed for the tip holding this Stripe transfer, with the error log for
    staff (`ids` added to it). False when no tip holds it as created. The caller commits."""
    reversed_row: tuple[uuid.UUID, uuid.UUID] | None = await TipTransferRepository(
        session
    ).mark_reversed(stripe_transfer_id)
    if reversed_row is None:
        return False
    tip_id, job_id = reversed_row
    # For staff: the pro's tip was taken back after it was sent.
    logger.error(
        "tip_transfer_reversed", extra={**ids, "tip_id": str(tip_id), "job_id": str(job_id)}
    )
    return True


async def tip_transfer_reversed(
    session: AsyncSession, event: StripeEvent, after_commit: AfterCommit
) -> None:
    stripe_transfer_id = transfer_id_of(event)
    ids = {"stripe_event_id": event.stripe_event_id}
    if not await record_tip_transfer_reversal(session, stripe_transfer_id, ids):
        logger.warning("tip_transfer_reversed_unknown", extra=ids)


TIP_TRANSFER_REVERSED: Final[StripeEventHandler] = tip_transfer_reversed
