"""#450 round 4 B2b: the transfer's initiation boundary against a late refund's hold, on real
commits and real PostgreSQL locks.

The case: the dispute's first refund was refused for good and abandoned, then an admin released
the dispute, so its transfer is queued, not made. Stripe then shows a refund carrying the
abandoned attempt's key: its signed event is handled on a connection of its own, as the worker
would, and holds the job's payout (late_refund_seen_at). Whether that hold commits before the
release's last check (the boundary, right before the create) or after it decides the outcome:
before, nothing is created; after, the create cannot be stopped any more, so the transfer is
flagged for staff (needs_reversal_at), never reversed by the code."""

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_refunds import RefundFacts
from app.modules.audit.types import Operator
from app.modules.disputes.refund_repair import DisputeRefundRepair
from app.modules.disputes.refund_webhooks import refund_event_handler
from app.modules.jobs.models import Job, JobStatus
from app.modules.payments.models import Refund, Transfer, TransferStatus
from app.modules.payments.schemas import TransferOut
from app.modules.payments.transfer_tasks import release_confirmed_jobs, release_transfer
from app.modules.payments.transfers import (
    HELD_BEFORE_CREATE,
    ReleaseOutcome,
    TransferConfig,
    TransferService,
    flag_transfer_for_reversal,
)
from app.modules.payouts.errors import PaymentsProviderError
from app.modules.webhooks.events import AfterCommit
from tests.conftest import make_settings
from tests.test_dispute_resolution_api import (
    REFUND,
    RELEASE,
    TOTAL,
    CommittedCase,
    FakeStripeRefunds,
    committed_case,
    queued_release,
    resolver,
)
from tests.test_disputes_api import RecordingQueue
from tests.test_resolve_dispute_refund import late_refund_event
from tests.test_transfers import FakeStripeTransfers

__all__ = ["committed_case"]


async def released_after_abandon(world: CommittedCase, refunds: FakeStripeRefunds) -> None:
    """The first refund refused for good and abandoned; then the dispute released: its
    transfer queued, not made."""
    refunds.errors["create"] = [StripeRejectedError(code="charge_disputed")]
    async with world.sessions() as session:
        with pytest.raises(PaymentsProviderError):
            await resolver(session, refunds).resolve(
                world.admin, world.case.dispute_id, REFUND, RecordingQueue()
            )
    async with world.sessions() as session:
        repair = DisputeRefundRepair(session, refunds, enabled=True)
        await repair.abandon(world.case.dispute_id, Operator(world.other_admin.id), apply=True)
    queue = RecordingQueue()
    async with world.sessions() as session:
        await resolver(session, refunds).resolve(world.admin, world.case.dispute_id, RELEASE, queue)
    assert queued_release(queue, world.case)


async def late_refund(world: CommittedCase, refunds: FakeStripeRefunds) -> None:
    """A refund Stripe made with the abandoned attempt's key, its event handled and committed
    on a connection of its own."""
    case = world.case
    late = RefundFacts(
        f"re_probe450r4{uuid.uuid4().hex[:6]}",
        TOTAL,
        "usd",
        str(case.dispute_id),
        "succeeded",
        None,
        f"dispute:{case.dispute_id}:refund",
    )
    refunds.add(late, case.payment_intent_id)
    async with world.sessions() as session:
        await refund_event_handler(lambda: refunds)(
            session, late_refund_event(case, late.refund_id), AfterCommit()
        )
        await session.commit()


def ctx_for(world: CommittedCase, transfers: FakeStripeTransfers) -> dict[str, Any]:
    return {
        "settings": make_settings(),
        "session_factory": world.sessions,
        "stripe_transfers": transfers,
    }


async def transfer_row(world: CommittedCase) -> Transfer:
    async with world.sessions() as session:
        row = (
            await session.scalars(select(Transfer).where(Transfer.job_id == world.case.job_id))
        ).one()
    return row


async def job_status(world: CommittedCase) -> JobStatus | None:
    async with world.sessions() as session:
        return await session.scalar(select(Job.status).where(Job.id == world.case.job_id))


async def forget_transfers(world: CommittedCase) -> None:
    async with world.sessions() as session:
        await session.execute(delete(Transfer).where(Transfer.job_id == world.case.job_id))
        await session.commit()


async def lock_waiter(sessions: async_sessionmaker[AsyncSession], within: float) -> bool:
    """Whether a connection of this database comes to wait on a lock within `within` seconds."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + within
    query = text(
        "SELECT count(*) FROM pg_stat_activity"
        " WHERE wait_event_type = 'Lock' AND datname = current_database()"
    )
    while loop.time() < deadline:
        async with sessions() as session:
            if await session.scalar(query):
                return True
        await asyncio.sleep(0.02)
    return False


@pytest.mark.parametrize("entry", ["task", "sweep"])
async def test_a_hold_committed_before_the_boundary_stops_the_create(
    committed_case: CommittedCase, entry: str
) -> None:
    """The hold commits after the release's own first check, while it looks the charge up:
    the boundary sees it and creates nothing. The row stays pending, held (no failure), and
    once staff clear the hold the next release looks the transfer up first and creates it
    once, under the job's one key."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    transfers = FakeStripeTransfers()

    async def hold_now() -> None:
        await late_refund(world, refunds)

    transfers.on_charge = hold_now
    ctx = ctx_for(world, transfers)
    try:
        if entry == "task":
            await release_transfer(ctx, str(world.case.job_id))
        else:
            await release_confirmed_jobs(ctx)

        assert len(transfers.charges) == 1  # it got as far as the charge lookup
        assert transfers.creates == []
        row = await transfer_row(world)
        assert (row.status, row.last_error_code, row.create_started_at, row.needs_reversal_at) == (
            TransferStatus.PENDING,
            HELD_BEFORE_CREATE,
            None,
            None,
        )
        assert await job_status(world) is JobStatus.DISPUTED

        # Staff reconcile it in Stripe and clear the hold (docs/stripe-money.md).
        async with world.sessions() as session:
            await session.execute(
                update(Refund)
                .where(Refund.job_id == world.case.job_id)
                .values(late_refund_seen_at=None)
            )
            await session.commit()
        transfers.on_charge = None
        await release_transfer(ctx, str(world.case.job_id))

        assert len(transfers.lists) == 1  # a retry looks the transfer up before creating
        assert [create["idempotency_key"] for create in transfers.creates] == [
            f"transfer:{world.case.job_id}"
        ]
        assert (await transfer_row(world)).status is TransferStatus.CREATED
        assert await job_status(world) is JobStatus.PAID_OUT
    finally:
        await forget_transfers(world)


async def test_a_hold_after_the_boundary_flags_the_issued_transfer_for_staff(
    committed_case: CommittedCase, caplog: pytest.LogCaptureFixture
) -> None:
    """The hold commits while the create is answering: past the boundary, it cannot stop the
    create any more. The transfer is made, and flagged for staff with the ids; nothing reverses
    it, and later releases and sweeps never clear the flag. The staff read shows it."""
    caplog.set_level(logging.INFO)
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    transfers = FakeStripeTransfers()

    async def hold_now() -> None:
        await late_refund(world, refunds)

    transfers.on_create = hold_now
    ctx = ctx_for(world, transfers)
    try:
        await release_transfer(ctx, str(world.case.job_id))

        assert len(transfers.creates) == 1
        row = await transfer_row(world)
        assert row.status is TransferStatus.CREATED
        assert row.create_started_at is not None
        flagged_at = row.needs_reversal_at
        assert isinstance(flagged_at, datetime)
        assert await job_status(world) is JobStatus.PAID_OUT
        alarms = [r for r in caplog.records if r.getMessage() == "transfer_needs_reversal"]
        assert {r.levelno for r in alarms} == {logging.ERROR}
        # The late refund's handler, with the dispute's ids...
        [handler] = [r for r in alarms if "dispute_id" in r.__dict__]
        assert (
            handler.__dict__["dispute_id"],
            handler.__dict__["job_id"],
            handler.__dict__["transfer_id"],
        ) == (str(world.case.dispute_id), str(world.case.job_id), str(row.id))
        # ...and storing the create's answer under the hold (round 5); the first time is kept.
        [stored] = [r for r in alarms if "stored_under_hold" in r.__dict__]
        assert stored.__dict__["stored_under_hold"] == "created"

        transfers.on_create = None
        await release_confirmed_jobs(ctx)
        await release_transfer(ctx, str(world.case.job_id))
        await late_refund(world, refunds)  # another late event keeps the first time

        again = await transfer_row(world)
        assert again.needs_reversal_at == flagged_at
        assert len(transfers.creates) == 1
        assert TransferOut.model_validate(again).needs_reversal_at == flagged_at
    finally:
        await forget_transfers(world)


async def test_the_boundary_waits_for_a_hold_being_written(
    committed_case: CommittedCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The late refund's handler holds the job's lock while it writes the hold. A release that
    reaches its boundary meanwhile waits on that lock, then sees the hold and creates nothing:
    the two are ordered by the lock, never interleaved."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    entered, finish = asyncio.Event(), asyncio.Event()
    flag = flag_transfer_for_reversal

    async def paused(session: AsyncSession, job_id: uuid.UUID, now: datetime) -> uuid.UUID | None:
        entered.set()  # the hold is written under the job's lock, not committed yet
        await finish.wait()
        return await flag(session, job_id, now)

    monkeypatch.setattr("app.modules.disputes.refund_webhooks.flag_transfer_for_reversal", paused)
    handler: list[asyncio.Task[None]] = []
    transfers = FakeStripeTransfers()

    async def hold_meanwhile() -> None:
        handler.append(asyncio.create_task(late_refund(world, refunds)))
        await asyncio.wait_for(entered.wait(), 10)

    transfers.on_charge = hold_meanwhile
    ctx = ctx_for(world, transfers)
    try:
        release = asyncio.create_task(release_transfer(ctx, str(world.case.job_id)))
        waited = await lock_waiter(world.sessions, within=5)
        finish.set()
        await asyncio.wait_for(release, 10)
        await asyncio.wait_for(handler[0], 10)

        assert waited, "the release never waited on the handler's lock"
        assert transfers.creates == []
        row = await transfer_row(world)
        assert (row.status, row.last_error_code, row.needs_reversal_at) == (
            TransferStatus.PENDING,
            HELD_BEFORE_CREATE,
            None,
        )
    finally:
        finish.set()
        await forget_transfers(world)


# --- #450 round 5: the evidence that a create may have been issued outlives a retry ------------

STUCK = timedelta(minutes=15)


@dataclass
class Clock:
    now: datetime

    def __call__(self) -> datetime:
        return self.now


async def release(
    world: CommittedCase, transfers: FakeStripeTransfers, clock: Clock
) -> ReleaseOutcome:
    """One release on a connection of its own, on the test's clock (a stale attempt's retry)."""
    async with world.sessions() as session:
        service = TransferService(session, transfers, TransferConfig(stuck_after=STUCK), clock)
        return await service.release(world.case.job_id)


async def hold_directly(world: CommittedCase) -> None:
    """A hold committed on its own connection without the late refund's handler (so without
    its flag), as a hold from any path would be."""
    async with world.sessions() as session:
        await session.execute(
            update(Refund)
            .where(Refund.job_id == world.case.job_id)
            .values(late_refund_seen_at=func.now())
        )
        await session.commit()


async def lost_answer(
    world: CommittedCase, transfers: FakeStripeTransfers, clock: Clock
) -> datetime:
    """The first attempt's create is made at Stripe but its answer is lost; the evidence it
    leaves."""
    transfers.lost_answers = 1
    assert await release(world, transfers, clock) is ReleaseOutcome.FAILED
    row = await transfer_row(world)
    assert row.create_may_have_been_issued_at is not None
    return row.create_may_have_been_issued_at


async def test_a_lost_answer_then_a_retry_whose_lookup_meets_a_hold_flags_the_transfer(
    committed_case: CommittedCase,
) -> None:
    """The Vault's case 1: the retry's lookup is interrupted by a committed late refund. The
    handler flags the transfer from the evidence (the retry cleared its own stamp), and the
    adoption stored under the hold flags it too."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()
    try:
        await lost_answer(world, transfers, clock)

        async def hold_now() -> None:
            await late_refund(world, refunds)

        transfers.on_list = hold_now
        assert await release(world, transfers, clock) is ReleaseOutcome.CREATED

        row = await transfer_row(world)
        assert (row.status, len(transfers.creates)) == (TransferStatus.CREATED, 1)
        assert row.needs_reversal_at is not None
    finally:
        await forget_transfers(world)


async def test_a_retry_whose_lookup_fails_after_a_hold_still_gets_the_transfer_flagged(
    committed_case: CommittedCase,
) -> None:
    """The Vault's case 2: the hold commits during the retry's lookup, which then fails. Only
    the late refund's handler can flag it, and it does, from the evidence."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()
    try:
        evidence = await lost_answer(world, transfers, clock)

        async def hold_then_fail() -> None:
            await late_refund(world, refunds)
            raise StripeUnavailableError(request_id="req_probe450r5")

        transfers.on_list = hold_then_fail
        assert await release(world, transfers, clock) is ReleaseOutcome.FAILED

        row = await transfer_row(world)
        assert row.status is TransferStatus.FAILED
        assert row.create_may_have_been_issued_at == evidence
        assert row.needs_reversal_at is not None
        assert len(transfers.creates) == 1
    finally:
        await forget_transfers(world)


async def test_a_first_create_answering_after_a_stale_retry_met_a_hold_is_flagged(
    committed_case: CommittedCase,
) -> None:
    """The Vault's case 3: the first create is still in flight; past the stuck window a retry
    starts, a late refund commits during its lookup, and the retry stops at its boundary. Then
    the first create comes back and is stored: the transfer is flagged."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()
    entered, finish = asyncio.Event(), asyncio.Event()

    async def in_flight() -> None:
        entered.set()
        await finish.wait()

    transfers.on_create = in_flight
    try:
        first = asyncio.create_task(release(world, transfers, clock))
        await asyncio.wait_for(entered.wait(), 10)
        transfers.on_create = None
        clock.now += STUCK + timedelta(seconds=1)

        async def hold_now() -> None:
            await late_refund(world, refunds)

        transfers.on_list = hold_now
        assert await release(world, transfers, clock) is ReleaseOutcome.HELD
        finish.set()
        assert await asyncio.wait_for(first, 10) is ReleaseOutcome.CREATED

        row = await transfer_row(world)
        assert (row.status, len(transfers.creates)) == (TransferStatus.CREATED, 1)
        assert row.needs_reversal_at is not None
    finally:
        finish.set()
        await forget_transfers(world)


async def test_the_evidence_survives_a_new_attempts_start(committed_case: CommittedCase) -> None:
    """The control: a retry clears its own boundary stamp, never the evidence; with no hold,
    nothing is flagged."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()
    seen: list[tuple[datetime | None, datetime | None]] = []
    try:
        evidence = await lost_answer(world, transfers, clock)

        async def read_row() -> None:
            row = await transfer_row(world)
            seen.append((row.create_started_at, row.create_may_have_been_issued_at))

        transfers.on_list = read_row
        assert await release(world, transfers, clock) is ReleaseOutcome.CREATED

        assert seen == [(None, evidence)]
        row = await transfer_row(world)
        assert (row.create_may_have_been_issued_at, row.needs_reversal_at) == (evidence, None)
    finally:
        await forget_transfers(world)


async def test_a_retry_after_a_held_attempt_keeps_the_evidence(
    committed_case: CommittedCase,
) -> None:
    """A lost answer, then a hold: the next release is held at its first check. Once the hold
    is cleared, the retry still carries the first attempt's evidence."""
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()
    try:
        evidence = await lost_answer(world, transfers, clock)
        await hold_directly(world)
        assert await release(world, transfers, clock) is ReleaseOutcome.HELD
        assert (await transfer_row(world)).create_may_have_been_issued_at == evidence

        async with world.sessions() as session:
            await session.execute(
                update(Refund)
                .where(Refund.job_id == world.case.job_id)
                .values(late_refund_seen_at=None)
            )
            await session.commit()
        assert await release(world, transfers, clock) is ReleaseOutcome.CREATED
        assert (await transfer_row(world)).create_may_have_been_issued_at == evidence
    finally:
        await forget_transfers(world)


async def test_an_adoption_stored_under_a_hold_is_flagged(
    committed_case: CommittedCase, caplog: pytest.LogCaptureFixture
) -> None:
    """A hold that came without the late refund's flag (any path) is present when a retry's
    lookup finds the transfer and stores it: storing it flags it, in the same transaction."""
    caplog.set_level(logging.INFO)
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()
    try:
        await lost_answer(world, transfers, clock)

        async def hold_now() -> None:
            await hold_directly(world)

        transfers.on_list = hold_now
        assert await release(world, transfers, clock) is ReleaseOutcome.CREATED

        assert (await transfer_row(world)).needs_reversal_at is not None
        [alarm] = [r for r in caplog.records if r.getMessage() == "transfer_needs_reversal"]
        assert alarm.__dict__["stored_under_hold"] == "adopted"
    finally:
        await forget_transfers(world)


async def test_a_returned_create_stored_under_a_hold_is_flagged(
    committed_case: CommittedCase, caplog: pytest.LogCaptureFixture
) -> None:
    """The create is past its boundary and still answering when a hold commits (without the
    late refund's flag): storing its answer flags the transfer."""
    caplog.set_level(logging.INFO)
    world = committed_case
    refunds = FakeStripeRefunds()
    await released_after_abandon(world, refunds)
    clock = Clock(datetime.now(UTC))
    transfers = FakeStripeTransfers()

    async def hold_while_answering() -> None:
        await hold_directly(world)

    transfers.on_create = hold_while_answering
    try:
        assert await release(world, transfers, clock) is ReleaseOutcome.CREATED

        assert (await transfer_row(world)).needs_reversal_at is not None
        [alarm] = [r for r in caplog.records if r.getMessage() == "transfer_needs_reversal"]
        assert alarm.__dict__["stored_under_hold"] == "created"
    finally:
        await forget_transfers(world)
