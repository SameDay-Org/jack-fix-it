"""A transfer.reversed event and the release that stores the transfer, in either order (#68,
#416 round 1).

Stripe makes the transfer, its create answer is slow to come back, staff reverse it, and the
signed event goes through the real ingress and StripeEventProcessor on a connection of its own
before the release stores the transfer's id, or after it. Either way the row ends reversed, the
reversal is recorded once, and a redelivery changes nothing. The other connections commit for
real (committed_world)."""

import asyncio
import json
import logging
from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from app.integrations.stripe_errors import StripeUnavailableError
from app.integrations.stripe_transfers import FoundTransfers, TransferFacts
from app.modules.jobs.models import Job, JobStatus
from app.modules.payments.models import Transfer, TransferStatus
from app.modules.payments.transfers import ReleaseOutcome, ReversalCheckOutcome
from app.modules.webhooks.models import WebhookEventStatus
from app.modules.webhooks.service import ProcessConfig, ProcessOutcome, StripeEventProcessor
from tests.job_world import PAYOUT
from tests.test_stripe_webhooks_api import Webhook, event_body, settings, webhook
from tests.test_transfers import (
    CONFIG,
    Clock,
    CommittedWorld,
    FakeStripeTransfers,
    clock,
    committed_world,
    service,
    stripe,
    transfer_of,
)

__all__ = ["clock", "committed_world", "settings", "stripe", "webhook"]

PROCESS = ProcessConfig(max_attempts=3, retry_backoff_seconds=1)


@pytest.mark.parametrize("order", ["reversed_before_stored", "reversed_after_stored"])
async def test_a_reversal_holds_whether_its_event_comes_before_or_after_the_transfer_is_stored(
    committed_world: CommittedWorld,
    webhook: Webhook,
    stripe: FakeStripeTransfers,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    order: str,
) -> None:
    world = committed_world
    event_id = webhook.new_id()
    processed: list[ProcessOutcome] = []

    async def reverse(made: TransferFacts) -> None:
        """Staff reverse the transfer in Stripe; its signed event is received and processed."""
        stripe.transfers[made.transfer_id] = replace(made, reversed=True)
        body = json.loads(event_body(event_id, "transfer.reversed"))
        body["data"]["object"] = {
            "object": "transfer",
            "id": made.transfer_id,
            "reversed": True,
            "amount_reversed": made.amount_cents,
            "metadata": {"job_id": str(world.job_id)},
        }
        assert (await webhook.post(json.dumps(body).encode())).status_code == 200
        [event] = await webhook.rows(event_id)
        async with world.sessions() as session:
            result = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
        processed.append(result.outcome)

    create = stripe.create_transfer

    async def create_then_reverse(**kwargs: Any) -> TransferFacts:
        made = await create(**kwargs)
        if order == "reversed_before_stored":
            await reverse(made)
        # The create's own answer, from before the reversal: what the release stores.
        return made

    monkeypatch.setattr(stripe, "create_transfer", create_then_reverse)
    caplog.set_level(logging.INFO)

    async with world.sessions() as session:
        outcome = await service(session, stripe, clock).release(world.job_id)
    if order == "reversed_after_stored":
        await reverse(next(iter(stripe.transfers.values())))

    [event] = await webhook.rows(event_id)
    async with world.sessions() as session:
        redelivered = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
        row = (await session.scalars(select(Transfer).where(Transfer.job_id == world.job_id))).one()
        job_status = await session.scalar(select(Job.status).where(Job.id == world.job_id))

    assert outcome is ReleaseOutcome.CREATED
    assert processed == [ProcessOutcome.PROCESSED]
    assert (event.status, redelivered.outcome) == (
        WebhookEventStatus.PROCESSED,
        ProcessOutcome.SKIPPED,
    )
    assert (row.status, job_status, len(stripe.creates)) == (
        TransferStatus.REVERSED,
        JobStatus.PAID_OUT,
        1,
    )
    # Recorded once: by the release's re-read when the event came first, else by the event.
    assert [r.getMessage() for r in caplog.records].count("transfer_reversed") == 1


# Round 2 (#416): the read after the transfer is stored fails, is cancelled, or never comes, and
# the recovery cron's read (check_reversal, here on the test's clock) records the reversal.


async def process_early_reversal(
    world: CommittedWorld,
    webhook: Webhook,
    stripe: FakeStripeTransfers,
    made: TransferFacts,
    event_id: str,
) -> bytes:
    """Staff reverse the transfer in Stripe before its create answer is stored; the signed
    event is received and processed on a connection of its own and finds no row with the id.
    Returns the signed body, for a redelivery."""
    stripe.transfers[made.transfer_id] = replace(made, reversed=True)
    body = json.loads(event_body(event_id, "transfer.reversed"))
    body["data"]["object"] = {
        "object": "transfer",
        "id": made.transfer_id,
        "reversed": True,
        "amount_reversed": made.amount_cents,
        "metadata": {"job_id": str(world.job_id)},
    }
    signed = json.dumps(body).encode()
    assert (await webhook.post(signed)).status_code == 200
    [event] = await webhook.rows(event_id)
    async with world.sessions() as session:
        result = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
        row = await transfer_of(session, world.job_id)
    assert result.outcome is ProcessOutcome.PROCESSED
    assert row is not None
    assert row.stripe_transfer_id is None
    return signed


async def recover(
    world: CommittedWorld, stripe: FakeStripeTransfers, clock: Clock
) -> ReversalCheckOutcome | None:
    """The recovery cron's pass over this world's row, each step on a connection of its own:
    None when the row is not due."""
    async with world.sessions() as session:
        row = await transfer_of(session, world.job_id)
        assert row is not None
        row_id = row.id
        unchecked = await service(session, stripe, clock).unchecked_for_reversal(10_000)
    if row_id not in unchecked:
        return None
    async with world.sessions() as session:
        return await service(session, stripe, clock).check_reversal(row_id)


@pytest.mark.parametrize("read", ["answers", "unavailable", "cancelled"])
async def test_an_early_reversal_survives_a_failed_or_cancelled_check(
    committed_world: CommittedWorld, webhook: Webhook, clock: Clock, read: str
) -> None:
    """The Vault's round 2 probe. The event came before the id was stored and is gone; the
    release's own read fails or its task is cancelled after the settlement's commit. Neither
    a redelivered task, the release sweep nor the redelivered event can help (the job is
    paid_out, the event processed); the recovery reads the stored id and records it."""
    world = committed_world
    event_id = webhook.new_id()
    signed: list[bytes] = []
    reads: list[str] = []

    class Stripe(FakeStripeTransfers):
        async def create_transfer(self, **kwargs: Any) -> TransferFacts:
            made = await super().create_transfer(**kwargs)
            signed.append(await process_early_reversal(world, webhook, self, made, event_id))
            return made

        async def retrieve_transfer(self, transfer_id: str) -> TransferFacts:
            reads.append(transfer_id)
            # The settlement is committed and seen on another connection, and a duplicate task
            # now sends nothing.
            async with world.sessions() as session:
                row = await transfer_of(session, world.job_id)
                assert row is not None
                assert row.stripe_transfer_id == transfer_id
                status = await session.scalar(select(Job.status).where(Job.id == world.job_id))
                assert status is JobStatus.PAID_OUT
                again = await service(session, self, clock).release(world.job_id)
                assert again is ReleaseOutcome.NOT_CONFIRMED
            if len(reads) == 1 and read == "unavailable":
                raise StripeUnavailableError(request_id="req_r2")
            if len(reads) == 1 and read == "cancelled":
                raise asyncio.CancelledError
            return await super().retrieve_transfer(transfer_id)

    stripe = Stripe()
    async with world.sessions() as session:
        if read == "cancelled":
            with pytest.raises(asyncio.CancelledError):
                await service(session, stripe, clock).release(world.job_id)
        else:
            outcome = await service(session, stripe, clock).release(world.job_id)
            assert outcome is ReleaseOutcome.CREATED

    clock.now += timedelta(days=2)
    async with world.sessions() as session:
        again = await service(session, stripe, clock).release(world.job_id)
        assert again is ReleaseOutcome.NOT_CONFIRMED
        assert world.job_id not in await service(session, stripe, clock).due(10_000)
    assert (await webhook.post(signed[0])).status_code == 200
    [event] = await webhook.rows(event_id)
    async with world.sessions() as session:
        replay = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
    assert replay.outcome is ProcessOutcome.SKIPPED

    recovered = await recover(world, stripe, clock)

    async with world.sessions() as session:
        row = await transfer_of(session, world.job_id)
    assert row is not None
    assert recovered is (None if read == "answers" else ReversalCheckOutcome.REVERSED)
    assert row.status is TransferStatus.REVERSED
    assert row.reversal_checked_at is not None
    assert row.stripe_transfer_id == next(iter(stripe.transfers))
    assert len(stripe.creates) == len(stripe.transfers) == 1
    assert stripe.creates[0]["amount_cents"] == PAYOUT
    assert len(reads) == (1 if read == "answers" else 2)


@pytest.mark.parametrize("winning_read_fails", [False, True], ids=["read_answers", "read_fails"])
async def test_overlapping_settlers_keep_the_reversal(
    committed_world: CommittedWorld, webhook: Webhook, clock: Clock, winning_read_fails: bool
) -> None:
    """The Vault's round 2 probe. The first release's create answer is slow; past the stuck
    window a second release finds the transfer in the listing (its event processed before,
    with no row to find) and stores it; the first then stores nothing (ALREADY_CREATED) and
    reads nothing. When the winner's read fails, the recovery records the reversal."""
    world = committed_world
    event_id = webhook.new_id()
    entered, finish = asyncio.Event(), asyncio.Event()

    class Stripe(FakeStripeTransfers):
        async def create_transfer(self, **kwargs: Any) -> TransferFacts:
            made = await super().create_transfer(**kwargs)
            entered.set()
            await finish.wait()
            return made

        async def list_transfers(self, transfer_group: str) -> FoundTransfers:
            found = await super().list_transfers(transfer_group)
            await process_early_reversal(world, webhook, self, found.transfers[0], event_id)
            return found

    stripe = Stripe()
    if winning_read_fails:
        stripe.errors["retrieve"] = [StripeUnavailableError(request_id="req_r2")]

    async def release() -> ReleaseOutcome:
        async with world.sessions() as session:
            return await service(session, stripe, clock).release(world.job_id)

    first = asyncio.create_task(release())
    try:
        async with asyncio.timeout(10):
            await entered.wait()
            clock.now += CONFIG.stuck_after + timedelta(seconds=1)
            assert await release() is ReleaseOutcome.CREATED
    finally:
        finish.set()
        first_outcome = await first
    assert first_outcome is ReleaseOutcome.ALREADY_CREATED
    assert await release() is ReleaseOutcome.NOT_CONFIRMED
    [event] = await webhook.rows(event_id)
    async with world.sessions() as session:
        replay = await StripeEventProcessor(session, PROCESS).process(event.id, last_try=False)
    assert replay.outcome is ProcessOutcome.SKIPPED

    clock.now += CONFIG.stuck_after
    recovered = await recover(world, stripe, clock)

    async with world.sessions() as session:
        row = await transfer_of(session, world.job_id)
    assert row is not None
    assert recovered is (ReversalCheckOutcome.REVERSED if winning_read_fails else None)
    assert row.status is TransferStatus.REVERSED
    assert len(stripe.creates) == len(stripe.transfers) == 1


async def test_two_recoveries_at_once_read_a_transfer_once(
    committed_world: CommittedWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A row from before the check (both stamps NULL). The first recovery's claim is
    committed before its read, so a second one, on its own connection while the first reads,
    leaves the row alone."""
    world = committed_world
    async with world.sessions() as session:
        assert await service(session, stripe, clock).release(world.job_id) is ReleaseOutcome.CREATED
        await session.execute(
            update(Transfer)
            .where(Transfer.job_id == world.job_id)
            .values(reversal_check_tried_at=None, reversal_checked_at=None)
        )
        await session.commit()
        row = await transfer_of(session, world.job_id)
        assert row is not None
        row_id = row.id
    entered, finish = asyncio.Event(), asyncio.Event()
    retrieve = stripe.retrieve_transfer

    async def slow_retrieve(transfer_id: str) -> TransferFacts:
        entered.set()
        await finish.wait()
        return await retrieve(transfer_id)

    monkeypatch.setattr(stripe, "retrieve_transfer", slow_retrieve)

    async def check() -> ReversalCheckOutcome:
        async with world.sessions() as session:
            return await service(session, stripe, clock).check_reversal(row_id)

    first = asyncio.create_task(check())
    try:
        async with asyncio.timeout(10):
            await entered.wait()
            second = await check()
    finally:
        finish.set()
        first_outcome = await first

    assert (first_outcome, second) == (ReversalCheckOutcome.CHECKED, ReversalCheckOutcome.SKIPPED)
    # The release's own read, then the first recovery's: the second read nothing.
    assert len(stripe.retrieves) == 2
    assert len(stripe.creates) == 1
