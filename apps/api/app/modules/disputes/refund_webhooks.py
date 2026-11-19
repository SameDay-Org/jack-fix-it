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
- A refund staff abandoned (#434) settles nothing: the event is logged and acknowledged.
- Late money (#450 rounds 2 and 3): a refund no row holds yet that names a dispute is read
  again from Stripe and, under the job's lock, then the dispute's, then the refund rows', placed
  by its metadata refund_key among the dispute's refunds (_unknown_refund):
  - the key of the dispute's current refund (not abandoned): that refund's own, arriving before
    its create's answer was stored or after the answer was lost. Nothing is marked: the
    create's answer, or the same decision's retry (whose lookup adopts it), stores and settles
    it, and a payout decided with it is not held;
  - the key of a refund staff abandoned, or no key the dispute's refunds hold: money may have
    gone back outside the records, and an admin may have decided the dispute again since. Unless
    Stripe failed or canceled it, the dispute's abandoned and failed refunds are marked
    (late_refund_seen_at) before the event is acknowledged, and the job's payout stays held
    from then on (payments.transfers, at the release's own check and in the sweep), whatever was
    decided or queued, until staff reconcile it (docs/stripe-money.md). Nothing settles through
    that refund, and staff get an ERROR with the ids.
  The same holds for the refund of a row staff abandoned that Stripe shows not failed or
  canceled. A repeated event changes nothing more (the first mark is kept).
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
from app.modules.disputes.resolution import RefundActor, RefundSettlement, utc_now
from app.modules.payments.refunds import RefundLedger, made_for, recheck_refund, refund_fits
from app.modules.payments.transfers import flag_transfer_for_reversal
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


async def _hold_payout(session: AsyncSession, ledger: RefundLedger, dispute_id: uuid.UUID) -> int:
    """Under the job's lock, then the dispute's, then the rows': the dispute's abandoned and
    failed refunds hold its job's payout until staff reconcile it (late_refund_seen_at). Written
    in the worker's transaction, committed with the event. Returns how many rows hold it.

    The job's lock is also the transfer's initiation boundary's (payments.transfers, #450
    round 4), so this hold commits strictly before or after it: before, the boundary sees the
    hold and creates nothing; after, the create may already be issued, so the job's transfer is
    flagged for staff to reverse (needs_reversal_at, an ERROR with the ids), never reversed
    here."""
    locked = await RefundSettlement(session).lock(dispute_id)
    return await _hold_locked(session, ledger, dispute_id, locked.job.job_id)


async def _hold_locked(
    session: AsyncSession, ledger: RefundLedger, dispute_id: uuid.UUID, job_id: uuid.UUID
) -> int:
    """The hold itself, for both late-refund paths; the caller holds the job's lock, then the
    dispute's (RefundSettlement.lock). Holds the payout (late_refund_seen_at on the dispute's
    abandoned and failed refunds) and flags the job's transfer if it may already be issued
    (#450 round 4). Returns how many rows hold the payout."""
    now = utc_now()
    held = await ledger.hold_for_reconciliation(dispute_id, now)
    flagged = await flag_transfer_for_reversal(session, job_id, now)
    if flagged is not None:
        logger.error(
            "transfer_needs_reversal",
            extra={
                "dispute_id": str(dispute_id),
                "job_id": str(job_id),
                "transfer_id": str(flagged),
            },
        )
    return held


async def _unknown_refund(
    session: AsyncSession,
    ledger: RefundLedger,
    stripe: StripeRefundsProvider,
    event: StripeEvent,
    stripe_refund_id: str,
    log: dict[str, str],
) -> None:
    """A refund no row holds yet. One whose metadata names a dispute (and that Stripe, read
    again by its id, says is that dispute's) is placed by its refund_key among the dispute's
    refunds, under the job's lock, then the dispute's, then the refund rows' (round 3):

    1. The current refund's key (the dispute's refund that is not abandoned): its own refund,
       early (its create's answer not stored yet) or after a lost answer. Acknowledged, nothing
       marked: the create's answer or the same decision's retry settles it.
    2. An abandoned refund's key: a late refund of an attempt staff gave up.
    3. No key the dispute's refunds hold, or none at all past the first refund's (a refund made
       by hand, or metadata that cannot be placed): fail closed, as late money.
    In 2 and 3, unless Stripe failed or canceled it, the dispute's abandoned and failed refunds
    are marked and the job's payout held for staff (late_refund_seen_at); in 3 with no such row
    there is nothing to mark, and staff still get the ERROR. Nothing settles through it.
    Anything else is acknowledged as unknown."""
    named = _named_dispute(event)
    if named is None:
        logger.warning("refund_event_unknown_refund", extra=log)
        return
    client = stripe()
    if client is None:
        logger.warning("refunds_stripe_not_configured", extra=log)
        raise RefundsNotConfiguredError
    read = await client.retrieve_refund(stripe_refund_id)
    if read.refund_id != stripe_refund_id or read.dispute_id != str(named):
        logger.warning("refund_event_unknown_refund", extra=log)
        return
    if not await ledger.all_of_dispute(named):
        # 3, with no refund of ours to mark: money on the dispute's payment our records lack.
        logger.error(
            "refund_event_unrecorded_refund",
            extra={**log, "dispute_id": str(named), "stripe_status": read.status},
        )
        return
    locked = await RefundSettlement(session).lock(named)
    rows = await ledger.locked_all_of_dispute(named)
    owner = next((row for row in rows if made_for(read, named, row.idempotency_key)), None)
    ids = {
        **log,
        "dispute_id": str(named),
        "job_id": str(rows[0].job_id),
        "refund_ids": ",".join(str(row.refund_id) for row in rows),
        "stripe_status": read.status,
    }
    if owner is not None and not owner.abandoned:
        # 1: the current refund's own, before its create's answer (or after it was lost).
        logger.info("refund_event_current_refund_early", extra={**ids, **owner.ids})
        return
    held = 0 if read.dead else await _hold_locked(session, ledger, named, locked.job.job_id)
    ids["payout_held"] = str(held > 0).lower()
    if owner is None:
        logger.error("refund_event_unrecorded_refund", extra=ids)
    elif read.dead:
        logger.info("refund_event_abandoned_refund", extra=ids)
    elif read.succeeded:
        logger.error("refund_event_abandoned_refund_succeeded", extra=ids)
    else:
        logger.error("refund_event_abandoned_refund_live", extra=ids)


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
            await _unknown_refund(session, ledger, stripe, event, stripe_refund_id, log)
            return
        client = stripe()
        if client is None:
            logger.warning("refunds_stripe_not_configured", extra=log)
            raise RefundsNotConfiguredError
        # Stripe's state now, never the payload's: read before any lock is taken.
        read = await recheck_refund(client, known)
        if known.abandoned:
            # Staff gave this refund up once Stripe showed it could not move money (#434):
            # nothing settles through it. Should Stripe show it otherwise after all, the payout
            # is held and staff look (round 2).
            if read.dead:
                logger.info("refund_event_abandoned_refund", extra={**log, **known.ids})
                return
            held = await _hold_payout(session, ledger, known.dispute_id)
            logger.error(
                "refund_event_abandoned_refund_succeeded"
                if read.succeeded
                else "refund_event_abandoned_refund_live",
                extra={**log, **known.ids, "payout_held": str(held > 0).lower()},
            )
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
