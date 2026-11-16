"""The transfer.reversed handler (#68), registered in app.modules.webhooks.handlers.

Stripe sends transfer.reversed when a transfer to a connected account is reversed, fully or in
part (from the Dashboard today: nothing in the app reverses one). The row of that transfer goes
created -> reversed, once, and an error is logged with ids for staff: the job stays paid_out
(its state machine has no way back), and the staff read of the job's transfer shows the
reversal. An event for a transfer no row holds changes nothing: not ours, or its create answer
is not stored yet (the release that adopts it later refuses a reversed transfer).

Stripe has no transfer.failed event in this API version (a transfer is made or refused when it
is created), and a connected account's payout.failed is out of scope (#68).

The handler never commits: the worker does (#40). An event whose object is not a Transfer with
an id is malformed: logged (the event id and type) and raised, so it ends failed for staff.
"""

import logging
from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments.repository import TransferRepository
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler

logger = logging.getLogger(__name__)


class TransferEventMalformedError(Exception):
    """The event's object is not a Transfer with an id."""


def _transfer_id(event: StripeEvent) -> str:
    data = event.payload.get("data")
    transfer = data.get("object") if isinstance(data, Mapping) else None
    transfer_id = transfer.get("id") if isinstance(transfer, Mapping) else None
    if (
        not isinstance(transfer, Mapping)
        or transfer.get("object") != "transfer"
        or not isinstance(transfer_id, str)
    ):
        logger.error(
            "transfer_event_malformed",
            extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
        )
        raise TransferEventMalformedError
    return transfer_id


async def transfer_reversed(
    session: AsyncSession, event: StripeEvent, after_commit: AfterCommit
) -> None:
    reversed_row = await TransferRepository(session).mark_reversed(_transfer_id(event))
    ids = {"stripe_event_id": event.stripe_event_id}
    if reversed_row is None:
        logger.warning("transfer_reversed_unknown", extra=ids)
        return
    transfer_id, job_id = reversed_row
    # For staff: the pro's money was taken back after the job was paid out.
    logger.error(
        "transfer_reversed", extra={**ids, "transfer_id": str(transfer_id), "job_id": str(job_id)}
    )


TRANSFER_HANDLERS: Final[Mapping[str, StripeEventHandler]] = MappingProxyType(
    {"transfer.reversed": transfer_reversed}
)
