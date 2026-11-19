"""Stripe's refund events (#433 round 1 B1), registered in app.modules.webhooks.handlers.

A dispute's refund settles the dispute only once Stripe says the money is back (`succeeded`),
which Stripe may say later than its answer to the create. It sends refund.updated,
refund.failed and charge.refund.updated as a refund moves on (all three are event types of
the pinned API version, 2026-10-28, in stripe-python 16.1's event list), to the platform
endpoint: a refund is the platform's own object. Each is handled the same way:

- The refund is the event's `data.object` (a Refund), selected by its exact Stripe id as the
  refund row stores it; the event's metadata never selects a row. An id no dispute refund holds
  (not ours, or its create answer not stored yet) is logged with the event's id and type and
  acknowledged: the admin's same decision finds that refund again (payments.refunds).
- The refund is read from Stripe again by that id: the event's own status, and the order events
  arrive in, are never trusted, so a late, repeated or out-of-order event ends at the state
  Stripe has now.
- What Stripe says is applied as an admin's same decision applies it
  (resolution.RefundSettlement.apply), under the job's lock, then the dispute's: succeeded
  settles the dispute as the admin who decided (the job refunded, or the partial's transfer
  queued, and both sides pushed after the worker's commit); failed or canceled leaves it open,
  flagged for staff (refund_failed) with any payout held (#434 repairs it); anything else is
  stored and waits. Twice the same state changes nothing.
- A refund staff abandoned (#434) settles nothing: the event is logged and acknowledged (an
  error for staff should Stripe ever say it succeeded).
- Stripe failing, or no Stripe key: raised, so the worker rolls the handler back and runs the
  event again after its backoff, until the event is failed for staff. Nothing is written.

The handler never commits: the worker does (#40). An event whose object is not a refund with
an id is malformed: logged (the event id and type) and raised, so it ends failed for staff.
Logs carry ids only.
"""

import logging
import uuid
from collections.abc import Callable, Mapping
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_refunds import StripeRefunds, worker_stripe_refunds
from app.modules.disputes.resolution import RefundActor, RefundSettlement
from app.modules.payments.refunds import RefundLedger, recheck_refund, refund_fits
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler

logger = logging.getLogger(__name__)

REFUND_EVENT_TYPES: Final = ("refund.updated", "refund.failed", "charge.refund.updated")

StripeRefundsProvider = Callable[[], StripeRefunds | None]


class RefundEventMalformedError(Exception):
    """The event's object is not a Stripe refund with an id."""


class RefundsNotConfiguredError(Exception):
    """No Stripe key: the refund cannot be read, so the event is run again later."""


def refund_id_of(event: StripeEvent) -> str:
    """The Stripe refund the event is about."""
    data = event.payload.get("data")
    refund = data.get("object") if isinstance(data, Mapping) else None
    refund_id = refund.get("id") if isinstance(refund, Mapping) else None
    if (
        not isinstance(refund, Mapping)
        or refund.get("object") != "refund"
        or not isinstance(refund_id, str)
    ):
        logger.error(
            "refund_event_malformed",
            extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
        )
        raise RefundEventMalformedError
    return refund_id


def _named_dispute(event: StripeEvent) -> uuid.UUID | None:
    """The dispute the event's refund says it was made for (its metadata), or None. Only
    decides whether Stripe is asked about it: never a fact the handler acts on."""
    data = event.payload.get("data")
    refund = data.get("object") if isinstance(data, Mapping) else None
    metadata = refund.get("metadata") if isinstance(refund, Mapping) else None
    named = metadata.get("dispute_id") if isinstance(metadata, Mapping) else None
    try:
        return uuid.UUID(named) if isinstance(named, str) else None
    except ValueError:
        return None


async def _unknown_refund(
    ledger: RefundLedger,
    stripe: StripeRefundsProvider,
    event: StripeEvent,
    stripe_refund_id: str,
    log: dict[str, str],
) -> None:
    """A refund no row holds. One that names a dispute whose refund failed or was abandoned
    is a refund our rows do not know (a create whose answer was never stored): staff hear of
    it (an ERROR with the ids). Nothing settles through it, and the dispute stays as it is:
    open, its payouts held. Anything else is acknowledged, as before."""
    named = _named_dispute(event)
    if named is None:
        logger.warning("refund_event_unknown_refund", extra=log)
        return
    client = stripe()
    if client is None:
        logger.warning("refunds_stripe_not_configured", extra=log)
        raise RefundsNotConfiguredError
    read = await client.retrieve_refund(stripe_refund_id)
    dispute_id = read.dispute_id if read.refund_id == stripe_refund_id else None
    rows = [] if dispute_id != str(named) else await ledger.all_of_dispute(named)
    if not any(row.abandoned or row.last_attempt_failed for row in rows):
        logger.warning("refund_event_unknown_refund", extra=log)
        return
    ids = {
        **log,
        "dispute_id": str(named),
        "job_id": str(rows[0].job_id),
        "refund_ids": ",".join(str(row.refund_id) for row in rows),
        "stripe_status": read.status,
    }
    if read.succeeded and any(row.abandoned for row in rows):
        logger.error("refund_event_abandoned_refund_succeeded", extra=ids)
    else:
        logger.error("refund_event_unrecorded_refund", extra=ids)


def refund_event_handler(stripe: StripeRefundsProvider) -> StripeEventHandler:
    """The handler, reading refunds with the client `stripe` gives (the worker's own in
    production, a fake in tests)."""

    async def refund_event(
        session: AsyncSession, event: StripeEvent, after_commit: AfterCommit
    ) -> None:
        stripe_refund_id = refund_id_of(event)
        log = {"stripe_event_id": event.stripe_event_id, "event_type": event.event_type}
        ledger = RefundLedger(session)
        known = await ledger.by_stripe_id(stripe_refund_id)
        if known is None:
            await _unknown_refund(ledger, stripe, event, stripe_refund_id, log)
            return
        client = stripe()
        if client is None:
            logger.warning("refunds_stripe_not_configured", extra=log)
            raise RefundsNotConfiguredError
        # Stripe's state now, never the payload's: read before any lock is taken.
        read = await recheck_refund(client, known)
        if known.abandoned:
            # Staff gave this refund up once Stripe showed it could not move money (#434):
            # nothing settles through it. Should Stripe say it succeeded after all, staff look.
            if read.succeeded:
                logger.error("refund_event_abandoned_refund_succeeded", extra={**log, **known.ids})
            else:
                logger.info("refund_event_abandoned_refund", extra={**log, **known.ids})
            return
        settlement = RefundSettlement(session)
        locked = await settlement.lock(known.dispute_id)
        refund = await ledger.locked_of_dispute(known.dispute_id)
        if refund is None:  # pragma: no cover - refund rows are never deleted
            raise RefundEventMalformedError
        applied = await settlement.apply(
            locked,
            refund,
            refund_fits(read, refund),
            # The decision is the deciding admin's; the event names what settled it.
            RefundActor(refund.initiated_by, stripe_event_id=event.stripe_event_id),
        )
        logger.info(
            "refund_event_applied", extra={**log, **refund.ids, "applied": applied.applied.value}
        )
        if applied.announce is not None:
            after_commit.add(applied.announce)

    return refund_event


REFUND_HANDLERS: Final[Mapping[str, StripeEventHandler]] = MappingProxyType(
    dict.fromkeys(REFUND_EVENT_TYPES, refund_event_handler(worker_stripe_refunds))
)
