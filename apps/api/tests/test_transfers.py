"""The transfer to the pro once their job is confirmed (D13.3, #68): TransferService.release, the
worker task and sweep, the transfer.reversed webhook, the pro's payout and the staff read.

Stripe is a fake that answers as Stripe does: the same idempotency key gets the same transfer
back, and a lost answer still makes the transfer. Most tests run in the rolled-back test session
(the fixture rows are committed first: release ends its transactions, and a rollback must not
take them away); the ones about other connections (the commit before the Stripe call, two
workers) use real commits on a world of their own, deleted afterwards.
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from redis.exceptions import RedisError
from sqlalchemy import URL, delete, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import violated_constraint
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_transfers import FoundTransfers, TransferFacts
from app.modules.addresses.models import Address
from app.modules.audit.models import AuditLog
from app.modules.disputes.models import (
    Dispute,
    DisputeReason,
    DisputeResolution,
    DisputeStatus,
)
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.jobs.service import JobPayoutFacts
from app.modules.payments import transfers
from app.modules.payments.models import Payment, PaymentStatus, Transfer, TransferStatus
from app.modules.payments.service import transfer_group
from app.modules.payments.transfer_queue import enqueue_transfer_release
from app.modules.payments.transfer_tasks import (
    check_transfer_reversals,
    release_confirmed_jobs,
    release_transfer,
)
from app.modules.payments.transfer_webhooks import (
    TransferEventMalformedError,
    transfer_reversed,
)
from app.modules.payments.transfers import (
    PAYOUTS_NOT_ENABLED,
    PRO_NOT_APPROVED,
    TRANSFER_NEEDS_REVIEW,
    ReleaseOutcome,
    ReversalCheckOutcome,
    TransferConfig,
    TransferService,
)
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.modules.webhooks.events import AfterCommit, StripeEvent
from app.modules.webhooks.handlers import handler_for
from tests.conftest import make_settings
from tests.helpers import as_status_writer
from tests.job_world import (
    FEE,
    PAYOUT,
    PRICE,
    TAX,
    JobWorld,
    build_world,
    events,
    job_row,
    make_job,
)
from tests.test_quotes_api import set_setting
from tests.test_requests_api import RecordingQueue

CONFIG = TransferConfig(stuck_after=timedelta(minutes=15))
NOW = datetime(2030, 2, 1, 12, 0, tzinfo=UTC)
# Stripe objects the fake makes; none may reach a log.
ACCOUNT = "acct_probe68destination"
CHARGE = "ch_probe68charge"
LEAKS = (ACCOUNT, CHARGE, "tr_probe68", str(PAYOUT), "probe-secret-text-68")


@dataclass
class FakeStripeTransfers:
    """Records every call and answers as Stripe does: a create with a known idempotency key
    returns the transfer it made first. `errors` makes the next call of an operation raise (the
    list is consumed in order); `lost_answers` makes that many creates make the transfer and
    then fail as a timeout would; `on_create`, `on_charge` and `on_list` run inside that
    call, before it answers.
    `list_complete` False: the listing has another page."""

    transfers: dict[str, TransferFacts] = field(default_factory=dict)  # by transfer id
    by_key: dict[str, str] = field(default_factory=dict)
    creates: list[dict[str, Any]] = field(default_factory=list)
    lists: list[str] = field(default_factory=list)
    charges: list[str] = field(default_factory=list)
    retrieves: list[str] = field(default_factory=list)
    errors: dict[str, list[Exception]] = field(default_factory=dict)
    lost_answers: int = 0
    on_create: Callable[[], Awaitable[None]] | None = None
    on_charge: Callable[[], Awaitable[None]] | None = None
    on_list: Callable[[], Awaitable[None]] | None = None
    list_complete: bool = True

    def _fail(self, operation: str) -> None:
        queued = self.errors.get(operation)
        if queued:
            raise queued.pop(0)

    def add(self, facts: TransferFacts, group: str) -> None:
        """A transfer Stripe holds that no create of this run answered with."""
        self.transfers[facts.transfer_id] = facts
        self._groups[facts.transfer_id] = group

    _groups: dict[str, str] = field(default_factory=dict)

    async def charge_of_payment_intent(self, payment_intent_id: str) -> str | None:
        self._fail("charge")
        self.charges.append(payment_intent_id)
        if self.on_charge is not None:
            await self.on_charge()
        return CHARGE

    async def create_transfer(
        self,
        *,
        amount_cents: int,
        currency: str,
        destination: str,
        transfer_group: str,
        source_transaction: str | None,
        metadata: dict[str, str] | Any,
        idempotency_key: str,
    ) -> TransferFacts:
        self._fail("create")
        self.creates.append(
            {
                "amount_cents": amount_cents,
                "currency": currency,
                "destination": destination,
                "transfer_group": transfer_group,
                "source_transaction": source_transaction,
                "metadata": dict(metadata),
                "idempotency_key": idempotency_key,
            }
        )
        if self.on_create is not None:
            await self.on_create()
        transfer_id = self.by_key.get(idempotency_key)
        if transfer_id is None:
            transfer_id = f"tr_probe68{len(self.transfers)}{uuid.uuid4().hex[:6]}"
            self.by_key[idempotency_key] = transfer_id
            self.add(
                TransferFacts(
                    transfer_id=transfer_id,
                    amount_cents=amount_cents,
                    currency=currency,
                    destination=destination,
                    job_id=dict(metadata).get("job_id"),
                    reversed=False,
                    request_id="req_fake_transfer",
                ),
                transfer_group,
            )
        if self.lost_answers:
            self.lost_answers -= 1
            raise StripeUnavailableError(request_id="req_lost")
        return self.transfers[transfer_id]

    async def list_transfers(self, transfer_group: str) -> FoundTransfers:
        self._fail("list")
        self.lists.append(transfer_group)
        if self.on_list is not None:
            await self.on_list()
        found = tuple(
            facts
            for transfer_id, facts in self.transfers.items()
            if self._groups[transfer_id] == transfer_group
        )
        return FoundTransfers(transfers=found, complete=self.list_complete)

    async def retrieve_transfer(self, transfer_id: str) -> TransferFacts:
        self._fail("retrieve")
        self.retrieves.append(transfer_id)
        return self.transfers[transfer_id]


@dataclass
class Clock:
    now: datetime = NOW

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    built = await build_world(db_session)
    # The pro can be paid out: an Express account with payouts enabled.
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == built.pro.profile_id)
        .values(stripe_account_id=ACCOUNT, payouts_enabled=True)
    )
    return built


@pytest.fixture
def stripe() -> FakeStripeTransfers:
    return FakeStripeTransfers()


@pytest.fixture
def clock() -> Clock:
    return Clock()


def service(
    session: AsyncSession, stripe: FakeStripeTransfers | None, clock: Clock
) -> TransferService:
    return TransferService(session, stripe, CONFIG, clock)


@dataclass(frozen=True)
class JobRef:
    """A job's ids, read once: a release's rollback expires the session's rows, and an expired
    attribute cannot be loaded outside an await."""

    id: uuid.UUID
    request_id: uuid.UUID
    quote_id: uuid.UUID


def ref(job: Job) -> JobRef:
    return JobRef(id=job.id, request_id=job.request_id, quote_id=job.quote_id)


async def add_payment(
    session: AsyncSession, world: JobWorld, job: Job | JobRef, **fields: Any
) -> Payment:
    """The job's payment, succeeded, with the amounts the job froze from it."""
    values: dict[str, Any] = {
        "request_id": job.request_id,
        "quote_id": job.quote_id,
        "customer_id": world.customer.id,
        "amount_cents": PRICE,
        "tax_cents": TAX,
        "customer_total_cents": PRICE + TAX,
        "platform_fee_cents": FEE,
        "pro_payout_cents": PAYOUT,
        "take_rate_bps": 1500,
        "currency": "usd",
        "status": PaymentStatus.SUCCEEDED,
        "stripe_payment_intent_id": f"pi_probe68{uuid.uuid4().hex[:10]}",
        **fields,
    }
    payment = Payment(**values)
    session.add(payment)
    await session.flush()
    return payment


async def confirmed_job(session: AsyncSession, world: JobWorld, **payment: Any) -> JobRef:
    """A confirmed job with its succeeded payment, committed (a release's rollback keeps it)."""
    job = await make_job(session, world, JobStatus.CONFIRMED, confirmed_at=NOW - timedelta(hours=1))
    await add_payment(session, world, job, **payment)
    await session.commit()
    return ref(job)


async def transfer_of(session: AsyncSession, job_id: uuid.UUID) -> Transfer | None:
    statement = (
        select(Transfer).where(Transfer.job_id == job_id).execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one_or_none()


def assert_no_leak(caplog: pytest.LogCaptureFixture) -> None:
    rendered = caplog.text + "".join(str(r.__dict__) for r in caplog.records)
    for leak in LEAKS:
        assert leak not in rendered, leak


# The release itself.


async def test_release_creates_one_transfer_and_pays_the_job_out(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    intent = f"pi_probe68{uuid.uuid4().hex[:10]}"
    job = await confirmed_job(db_session, world, stripe_payment_intent_id=intent)
    caplog.set_level(logging.DEBUG)

    outcome = await service(db_session, stripe, clock).release(job.id)

    assert outcome is ReleaseOutcome.CREATED
    # The source charge is the one of the job's own payment.
    assert stripe.charges == [intent]
    [create] = stripe.creates
    assert create == {
        "amount_cents": PAYOUT,
        "currency": "usd",
        "destination": ACCOUNT,
        "transfer_group": transfer_group(job.request_id),
        "source_transaction": CHARGE,
        "metadata": {"job_id": str(job.id)},
        "idempotency_key": f"transfer:{job.id}",
    }
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.stripe_transfer_id, row.amount_cents, row.attempts) == (
        TransferStatus.CREATED,
        stripe.by_key[f"transfer:{job.id}"],
        PAYOUT,
        1,
    )
    assert (row.idempotency_key, row.pro_id, row.last_error_code) == (
        f"transfer:{job.id}",
        world.pro.profile_id,
        None,
    )
    assert row.requested_at == NOW
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT
    [last] = [e for e in await events(db_session, job.id) if e.to_status is JobStatus.PAID_OUT]
    assert (last.type, last.from_status, last.to_status, last.actor_id) == (
        "status_changed",
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        None,
    )
    assert_no_leak(caplog)


async def test_a_second_release_makes_no_stripe_call(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)
    first = await service(db_session, stripe, clock).release(job.id)

    again = await service(db_session, stripe, clock).release(job.id)

    assert (first, again) == (ReleaseOutcome.CREATED, ReleaseOutcome.NOT_CONFIRMED)
    assert len(stripe.creates) == 1
    assert (stripe.lists, stripe.charges[1:]) == ([], [])
    assert (
        len([e for e in await events(db_session, job.id) if e.to_status is JobStatus.PAID_OUT]) == 1
    )


@pytest.mark.parametrize(
    "status", [JobStatus.COMPLETED, JobStatus.DISPUTED, JobStatus.SCHEDULED, JobStatus.PAID_OUT]
)
async def test_only_a_confirmed_job_is_released(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    status: JobStatus,
) -> None:
    job = ref(await make_job(db_session, world, status))
    await add_payment(db_session, world, job)
    await db_session.commit()

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.NOT_CONFIRMED
    assert await service(db_session, stripe, clock).release(uuid.uuid4()) is (
        ReleaseOutcome.NOT_CONFIRMED
    )

    assert stripe.creates == []
    assert await transfer_of(db_session, job.id) is None
    assert (await job_row(db_session, job.id)).status is status


async def test_a_held_job_is_not_released(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The dispute module's hook (#75): a job with an open hold is never released."""
    job = await confirmed_job(db_session, world)
    held: list[uuid.UUID] = []

    async def hold(session: AsyncSession, facts: JobPayoutFacts) -> bool:
        held.append(facts.job_id)
        return True

    monkeypatch.setattr(transfers, "has_open_hold", hold)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.HELD

    assert held == [job.id]
    assert stripe.creates == []
    assert await transfer_of(db_session, job.id) is None
    assert (await job_row(db_session, job.id)).status is JobStatus.CONFIRMED


async def test_an_open_dispute_holds_the_job_until_it_is_resolved(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    """The real hook (#75): a job with an open dispute is held by release and left out of the
    sweep, with no Stripe call; once the dispute is resolved (#76) it is released. Reached only
    through a data state the report never makes (it moves the job to disputed): the hook holds
    whatever the job's status."""
    job = await confirmed_job(db_session, world)
    dispute = Dispute(
        job_id=job.id,
        opened_by=world.customer.id,
        reason_code=DisputeReason.DAMAGE,
        description="Held probe",
    )
    db_session.add(dispute)
    await db_session.commit()
    dispute_id = dispute.id
    facts = JobPayoutFacts(
        job_id=job.id,
        request_id=job.request_id,
        quote_id=job.quote_id,
        pro_id=world.pro.profile_id,
        confirmed=True,
        disputed=False,
        pro_payout_cents=PAYOUT,
    )

    assert await transfers.has_open_hold(db_session, facts) is True
    assert job.id not in await service(db_session, stripe, clock).due(10_000)
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.HELD
    assert (stripe.creates, stripe.charges, stripe.lists) == ([], [], [])

    await db_session.execute(
        update(Dispute)
        .where(Dispute.id == dispute_id)
        .values(
            status=DisputeStatus.RESOLVED,
            resolution=DisputeResolution.RELEASED,
            resolved_by=world.admin.id,
            resolved_at=NOW,
        )
    )
    await db_session.commit()

    assert await transfers.has_open_hold(db_session, facts) is False
    assert job.id in await service(db_session, stripe, clock).due(10_000)
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED


@pytest.mark.parametrize("earlier", ["failed", "held_back"])
async def test_a_held_job_with_an_earlier_attempt_is_not_released(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    earlier: str,
) -> None:
    """A hold that starts after a failed or held-back attempt stops the retry too, whoever
    makes it (the sweep included): the row stays as it was and Stripe is not asked."""
    job = await confirmed_job(db_session, world)
    pro = update(ProProfile).where(ProProfile.id == world.pro.profile_id)
    if earlier == "failed":
        stripe.errors["create"] = [StripeUnavailableError()]
        assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.FAILED
    else:
        await db_session.execute(pro.values(payouts_enabled=False))
        await db_session.commit()
        outcome = await service(db_session, stripe, clock).release(job.id)
        assert outcome is ReleaseOutcome.PAYOUTS_NOT_ENABLED
        await db_session.execute(pro.values(payouts_enabled=True))
        await db_session.commit()
    before = await transfer_of(db_session, job.id)
    assert before is not None
    kept = (before.status, before.last_error_code, before.attempts, before.requested_at)
    calls = (len(stripe.creates), len(stripe.lists), len(stripe.charges))

    async def hold(session: AsyncSession, facts: JobPayoutFacts) -> bool:
        return True

    monkeypatch.setattr(transfers, "has_open_hold", hold)
    clock.now += CONFIG.stuck_after

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.HELD
    await release_confirmed_jobs(worker_ctx(db_session, stripe, transfer_release_batch_size=10_000))

    assert (len(stripe.creates), len(stripe.lists), len(stripe.charges)) == calls
    after = await transfer_of(db_session, job.id)
    assert after is not None
    assert (after.status, after.last_error_code, after.attempts, after.requested_at) == kept
    assert (await job_row(db_session, job.id)).status is JobStatus.CONFIRMED


async def test_the_amount_is_the_frozen_payout_never_the_current_rate(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    # The take rate changed since the payment: 20% now would give the pro 16_000.
    await set_setting(db_session, "platform_take_rate_bps", 2000)
    job = await confirmed_job(db_session, world)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED

    assert [create["amount_cents"] for create in stripe.creates] == [PAYOUT]


async def test_the_amount_is_the_job_payout_not_one_derived_from_the_payment(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    # 16_999 is neither the amount at the payment's own rate (17_000) nor anything else a
    # rate or a rounding rule gives back: only the frozen value itself.
    payout, fee = PAYOUT - 1, FEE + 1
    job = await confirmed_job(db_session, world, pro_payout_cents=payout, platform_fee_cents=fee)
    await db_session.execute(update(Job).where(Job.id == job.id).values(pro_payout_cents=payout))
    await db_session.commit()

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED

    assert [create["amount_cents"] for create in stripe.creates] == [payout]
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert row.amount_cents == payout


async def test_a_payout_that_does_not_match_the_payment_is_never_sent(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await confirmed_job(
        db_session, world, pro_payout_cents=PAYOUT - 100, platform_fee_cents=FEE + 100
    )
    caplog.set_level(logging.DEBUG)

    outcome = await service(db_session, stripe, clock).release(job.id)

    assert outcome is ReleaseOutcome.NEEDS_REVIEW
    assert stripe.creates == []
    assert await transfer_of(db_session, job.id) is None
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR] == [
        "transfer_amount_mismatch"
    ]
    # Ids only: neither amount.
    assert_no_leak(caplog)
    assert str(PAYOUT - 100) not in caplog.text + str([r.__dict__ for r in caplog.records])


async def test_a_job_without_a_succeeded_payment_is_never_sent(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world, status=PaymentStatus.PROCESSING)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.NEEDS_REVIEW
    assert stripe.creates == []


async def test_no_stripe_key_releases_nothing(
    db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)

    assert await service(db_session, None, clock).release(job.id) is ReleaseOutcome.NOT_CONFIGURED
    assert await transfer_of(db_session, job.id) is None


# A pro who cannot be paid out yet.


@pytest.mark.parametrize(
    "profile", [{"payouts_enabled": False}, {"stripe_account_id": None}], ids=["disabled", "none"]
)
async def test_a_pro_without_payouts_waits_and_is_released_once_enabled(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    profile: dict[str, Any],
) -> None:
    job = await confirmed_job(db_session, world)
    pro = update(ProProfile).where(ProProfile.id == world.pro.profile_id)
    await db_session.execute(pro.values(**profile))
    await db_session.commit()

    outcome = await service(db_session, stripe, clock).release(job.id)

    assert outcome is ReleaseOutcome.PAYOUTS_NOT_ENABLED
    assert (stripe.creates, stripe.charges) == ([], [])
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code, row.attempts, row.requested_at) == (
        TransferStatus.PENDING,
        PAYOUTS_NOT_ENABLED,
        0,
        None,
    )
    assert (await job_row(db_session, job.id)).status is JobStatus.CONFIRMED

    await db_session.execute(pro.values(stripe_account_id=ACCOUNT, payouts_enabled=True))
    await db_session.commit()
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    assert len(stripe.creates) == 1
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


UNAPPROVED = pytest.mark.parametrize(
    "verification", [ProVerificationStatus.PENDING, ProVerificationStatus.REJECTED]
)


@UNAPPROVED
async def test_a_pro_staff_do_not_approve_now_is_held_until_approved_again(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    verification: ProVerificationStatus,
) -> None:
    """Staff reject the pro (or set them back to pending) after the job was confirmed: Stripe
    still has their payouts enabled, yet neither the release nor the sweep sends anything or
    burns an attempt. Approved again, the next sweep pays the job (#416 r1)."""
    job = await confirmed_job(db_session, world)
    pro = update(ProProfile).where(ProProfile.id == world.pro.profile_id)
    await db_session.execute(pro.values(verification_status=verification))
    await db_session.commit()
    sweep = worker_ctx(db_session, stripe, transfer_release_batch_size=10_000)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.HELD
    assert job.id not in await service(db_session, stripe, clock).due(10_000)
    await release_confirmed_jobs(sweep)
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.HELD

    assert (stripe.creates, stripe.charges, stripe.lists) == ([], [], [])
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code, row.attempts, row.requested_at) == (
        TransferStatus.PENDING,
        PRO_NOT_APPROVED,
        0,
        None,
    )
    assert (await job_row(db_session, job.id)).status is JobStatus.CONFIRMED

    await db_session.execute(pro.values(verification_status=ProVerificationStatus.APPROVED))
    await db_session.commit()
    assert job.id in await service(db_session, stripe, clock).due(10_000)
    await release_confirmed_jobs(sweep)

    assert str(job.id) in {c["metadata"]["job_id"] for c in stripe.creates}
    await db_session.refresh(row)
    assert (row.status, row.attempts) == (TransferStatus.CREATED, 1)
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


@UNAPPROVED
async def test_the_sweep_never_reads_a_job_of_a_pro_staff_do_not_approve(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    verification: ProVerificationStatus,
) -> None:
    """Before any release ran (no row yet): the sweep alone keeps the job out."""
    job = await confirmed_job(db_session, world)
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == world.pro.profile_id)
        .values(verification_status=verification)
    )
    await db_session.commit()

    assert job.id not in await service(db_session, stripe, clock).due(10_000)
    await release_confirmed_jobs(worker_ctx(db_session, stripe, transfer_release_batch_size=10_000))

    assert str(job.id) not in {c["metadata"]["job_id"] for c in stripe.creates}
    assert await transfer_of(db_session, job.id) is None


# Stripe errors, retries and lost answers.


@pytest.mark.parametrize(
    ("error", "code", "message"),
    [
        (
            StripeRejectedError(request_id="req_x", code="insufficient_funds"),
            "insufficient_funds",
            "transfer_stripe_rejected",
        ),
        (
            StripeUnavailableError(request_id="req_x"),
            "StripeUnavailableError",
            "transfer_stripe_unavailable",
        ),
    ],
)
async def test_a_stripe_error_leaves_the_job_confirmed_and_a_retry_works(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    code: str,
    message: str,
) -> None:
    job = await confirmed_job(db_session, world)
    stripe.errors["create"] = [error]
    caplog.set_level(logging.DEBUG)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.FAILED

    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code, row.attempts, row.stripe_transfer_id) == (
        TransferStatus.FAILED,
        code,
        1,
        None,
    )
    assert (await job_row(db_session, job.id)).status is JobStatus.CONFIRMED
    [record] = [r for r in caplog.records if r.getMessage() == message]
    assert record.__dict__["job_id"] == str(job.id)
    assert_no_leak(caplog)

    clock.now += timedelta(minutes=1)
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code, row.attempts) == (TransferStatus.CREATED, None, 2)
    # The retry looked for the first attempt's transfer before creating, with the same key.
    assert stripe.lists == [transfer_group(job.request_id)]
    assert [c["idempotency_key"] for c in stripe.creates] == [f"transfer:{job.id}"]


async def test_an_error_text_never_reaches_the_row_or_the_logs(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await confirmed_job(db_session, world)
    stripe.errors["create"] = [StripeRejectedError(request_id="req_x", code=f"code_{'x' * 100}")]
    caplog.set_level(logging.DEBUG)

    await service(db_session, stripe, clock).release(job.id)

    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert row.last_error_code is not None
    assert len(row.last_error_code) == 64  # cut to the column
    assert_no_leak(caplog)


async def test_a_lost_answer_is_adopted_without_a_second_create(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)
    stripe.lost_answers = 1

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.FAILED
    # Stripe forgot the key (24 h): only the lookup can find the transfer now.
    made = stripe.by_key.pop(f"transfer:{job.id}")
    clock.now += timedelta(days=2)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED

    assert len(stripe.creates) == 1
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.stripe_transfer_id, row.attempts) == (TransferStatus.CREATED, made, 2)
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


async def test_a_stuck_attempt_is_left_alone_then_reconciled(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    """A worker that died after its create: the row is pending with an attempt stamped and no
    outcome. Within the window it is another worker's (no call); past it, the lookup finds the
    transfer the create made, and nothing is created again."""
    job = await confirmed_job(db_session, world)

    async def die() -> None:
        raise asyncio.CancelledError

    stripe.on_create = die
    with pytest.raises(asyncio.CancelledError):
        await service(db_session, stripe, clock).release(job.id)
    await db_session.rollback()
    stripe.on_create = None
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code, row.attempts) == (TransferStatus.PENDING, None, 1)
    # The fake made nothing (the cancel came first); Stripe would have: add it.
    stripe.add(
        TransferFacts(
            transfer_id="tr_probe68stuck",
            amount_cents=PAYOUT,
            currency="usd",
            destination=ACCOUNT,
            job_id=str(job.id),
            reversed=False,
            request_id=None,
        ),
        transfer_group(job.request_id),
    )

    clock.now += timedelta(minutes=14)
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.IN_FLIGHT
    assert stripe.lists == []

    clock.now += timedelta(minutes=1)
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    assert len(stripe.creates) == 1  # only the dead worker's
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.stripe_transfer_id, row.attempts) == ("tr_probe68stuck", 2)


@pytest.mark.parametrize(
    "case", ["several", "wrong_amount", "wrong_destination", "reversed", "incomplete"]
)
async def test_a_lookup_that_cannot_be_matched_creates_nothing(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    case: str,
) -> None:
    job = await confirmed_job(db_session, world)
    caplog.set_level(logging.DEBUG)
    stripe.errors["create"] = [StripeUnavailableError()]
    await service(db_session, stripe, clock).release(job.id)
    group = transfer_group(job.request_id)
    base = TransferFacts(
        transfer_id="tr_probe68a",
        amount_cents=PAYOUT,
        currency="usd",
        destination=ACCOUNT,
        job_id=str(job.id),
        reversed=False,
        request_id=None,
    )
    match case:
        case "several":
            stripe.add(base, group)
            stripe.add(TransferFacts(**{**base.__dict__, "transfer_id": "tr_probe68b"}), group)
        case "wrong_amount":
            stripe.add(TransferFacts(**{**base.__dict__, "amount_cents": PAYOUT + 1}), group)
        case "wrong_destination":
            stripe.add(TransferFacts(**{**base.__dict__, "destination": "acct_other"}), group)
        case "reversed":
            stripe.add(TransferFacts(**{**base.__dict__, "reversed": True}), group)
        case "incomplete":
            stripe.list_complete = False

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.NEEDS_REVIEW

    assert stripe.creates == []
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code) == (TransferStatus.FAILED, TRANSFER_NEEDS_REVIEW)
    assert (await job_row(db_session, job.id)).status is JobStatus.CONFIRMED
    assert "transfer_needs_review" in [r.getMessage() for r in caplog.records]
    # The reason is a fixed word: no transfer id, account or amount of what Stripe holds.
    assert_no_leak(caplog)


async def test_a_duplicate_staff_reversed_leaves_the_live_transfer_to_adopt(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)
    stripe.errors["create"] = [StripeUnavailableError()]
    await service(db_session, stripe, clock).release(job.id)
    group = transfer_group(job.request_id)
    live = TransferFacts(
        transfer_id="tr_probe68live",
        amount_cents=PAYOUT,
        currency="usd",
        destination=ACCOUNT,
        job_id=str(job.id),
        reversed=False,
        request_id=None,
    )
    stripe.add(
        TransferFacts(**{**live.__dict__, "transfer_id": "tr_probe68rev", "reversed": True}), group
    )
    stripe.add(live, group)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED

    assert stripe.creates == []
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.stripe_transfer_id) == (TransferStatus.CREATED, "tr_probe68live")
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


# The database guards.


async def test_one_transfer_row_per_job(db_session: AsyncSession, world: JobWorld) -> None:
    job = await confirmed_job(db_session, world)
    payment = (
        await db_session.scalars(select(Payment).where(Payment.quote_id == job.quote_id))
    ).one()

    def row(key: str) -> Transfer:
        return Transfer(
            job_id=job.id,
            payment_id=payment.id,
            pro_id=world.pro.profile_id,
            amount_cents=PAYOUT,
            currency="usd",
            idempotency_key=key,
        )

    db_session.add(row(f"transfer:{job.id}"))
    await db_session.flush()
    db_session.add(row("transfer:another"))
    with pytest.raises(IntegrityError) as raised:
        await db_session.flush()
    assert violated_constraint(raised.value) == "uq_transfers_job_id"


async def test_a_made_transfer_holds_its_stripe_id(
    db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)
    payment = (
        await db_session.scalars(select(Payment).where(Payment.quote_id == job.quote_id))
    ).one()
    db_session.add(
        Transfer(
            job_id=job.id,
            payment_id=payment.id,
            pro_id=world.pro.profile_id,
            amount_cents=PAYOUT,
            currency="usd",
            idempotency_key=f"transfer:{job.id}",
            status=TransferStatus.CREATED,
        )
    )
    with pytest.raises(IntegrityError) as raised:
        await db_session.flush()
    assert violated_constraint(raised.value) == "ck_transfers_made_has_stripe_transfer_id"


async def test_a_status_outside_the_four_and_a_shared_stripe_id_are_refused(
    db_session: AsyncSession, world: JobWorld
) -> None:
    rows: list[Transfer] = []
    for _ in range(2):
        job = await confirmed_job(db_session, world)
        payment = (
            await db_session.scalars(select(Payment).where(Payment.quote_id == job.quote_id))
        ).one()
        rows.append(
            Transfer(
                job_id=job.id,
                payment_id=payment.id,
                pro_id=world.pro.profile_id,
                amount_cents=PAYOUT,
                currency="usd",
                idempotency_key=f"transfer:{job.id}",
            )
        )
    db_session.add_all(rows)
    await db_session.flush()
    ids = [row.id for row in rows]

    with pytest.raises(IntegrityError) as raised:
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE transfers SET status = 'paid' WHERE id = :id"), {"id": ids[0]}
            )
    assert violated_constraint(raised.value) == "ck_transfers_transfer_status"

    made = text(
        "UPDATE transfers SET status = 'created', stripe_transfer_id = 'tr_probe68same' "
        "WHERE id = :id"
    )
    await db_session.execute(made, {"id": ids[0]})
    with pytest.raises(IntegrityError) as raised:
        async with db_session.begin_nested():
            await db_session.execute(made, {"id": ids[1]})
    assert violated_constraint(raised.value) == "uq_transfers_stripe_transfer_id"


# The sweep and the task.


@asynccontextmanager
async def _same(session: AsyncSession) -> AsyncIterator[AsyncSession]:
    yield session


def worker_ctx(
    session: AsyncSession, stripe: FakeStripeTransfers | None, **settings: Any
) -> dict[str, Any]:
    return {
        "session_factory": lambda: _same(session),
        "settings": make_settings(**settings),
        "stripe_transfers": stripe,
    }


async def test_due_reads_only_payable_confirmed_jobs_and_respects_the_wait(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    fresh = await confirmed_job(db_session, world)
    failed = await confirmed_job(db_session, world)
    paid = await confirmed_job(db_session, world)
    other_pro = ref(await make_job(db_session, world, JobStatus.CONFIRMED, pro=world.other_pro))
    completed = ref(await make_job(db_session, world, JobStatus.COMPLETED))
    await db_session.commit()
    stripe.errors["create"] = [StripeUnavailableError()]
    assert await service(db_session, stripe, clock).release(failed.id) is ReleaseOutcome.FAILED
    assert await service(db_session, stripe, clock).release(paid.id) is ReleaseOutcome.CREATED

    def due_now() -> Awaitable[list[uuid.UUID]]:
        return service(db_session, stripe, clock).due(10_000)

    now_due = set(await due_now())
    assert fresh.id in now_due
    # Tried a minute ago: waits; paid out, of a pro with no account, or not confirmed: never.
    assert not now_due & {failed.id, paid.id, other_pro.id, completed.id}

    clock.now += CONFIG.stuck_after
    later = await due_now()
    assert {fresh.id, failed.id} <= set(later)
    # Never tried first, the failed one after.
    assert later.index(fresh.id) < later.index(failed.id)


async def test_due_takes_a_dead_workers_attempt_once_the_window_has_passed(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    """A worker that died inside its create leaves the row pending, stamped, with no outcome.
    The sweep is the only caller that comes back to it (a queued run is tried once): it reads
    the job once TRANSFER_STUCK_PENDING_MINUTES have passed, never before."""
    job = await confirmed_job(db_session, world)

    async def die() -> None:
        raise asyncio.CancelledError

    stripe.on_create = die
    with pytest.raises(asyncio.CancelledError):
        await service(db_session, stripe, clock).release(job.id)
    await db_session.rollback()
    stripe.on_create = None
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.last_error_code, row.requested_at) == (
        TransferStatus.PENDING,
        None,
        NOW,
    )

    clock.now = NOW + CONFIG.stuck_after - timedelta(seconds=1)
    assert job.id not in await service(db_session, stripe, clock).due(10_000)
    clock.now = NOW + CONFIG.stuck_after
    assert job.id in await service(db_session, stripe, clock).due(10_000)


def test_the_stuck_window_comes_from_the_settings() -> None:
    config = TransferConfig.from_settings(make_settings(transfer_stuck_pending_minutes=30))
    assert config.stuck_after == timedelta(minutes=30)


async def test_the_sweep_takes_a_held_back_job_once_its_pro_can_be_paid(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)
    pro = update(ProProfile).where(ProProfile.id == world.pro.profile_id)
    await db_session.execute(pro.values(payouts_enabled=False))
    await db_session.commit()
    first = await service(db_session, stripe, clock).release(job.id)
    assert first is ReleaseOutcome.PAYOUTS_NOT_ENABLED
    assert job.id not in await service(db_session, stripe, clock).due(10_000)

    await db_session.execute(pro.values(payouts_enabled=True))
    await db_session.commit()
    # Right away: no attempt was made, so there is nothing to wait for.
    assert job.id in await service(db_session, stripe, clock).due(10_000)

    await release_confirmed_jobs(worker_ctx(db_session, stripe, transfer_release_batch_size=10_000))

    assert str(job.id) in {c["metadata"]["job_id"] for c in stripe.creates}
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


async def test_the_sweep_pays_out_a_job_whose_row_staff_repaired(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """After a review staff store the transfer on the row by hand (created, with its id): the
    sweep moves the job to paid_out without calling Stripe."""
    job = await confirmed_job(db_session, world)
    stripe.errors["create"] = [StripeUnavailableError()]
    await service(db_session, stripe, clock).release(job.id)
    await db_session.execute(
        update(Transfer)
        .where(Transfer.job_id == job.id)
        .values(status=TransferStatus.CREATED, stripe_transfer_id="tr_probe68repaired")
    )
    await db_session.commit()

    assert job.id in await service(db_session, stripe, clock).due(10_000)
    await release_confirmed_jobs(worker_ctx(db_session, stripe, transfer_release_batch_size=10_000))

    assert stripe.creates == []
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT
    assert "transfer_job_paid_out_late" in [r.getMessage() for r in caplog.records]
    assert job.id not in await service(db_session, stripe, clock).due(10_000)


@pytest.mark.parametrize("refused", ["payout_mismatch", "no_succeeded_payment"])
async def test_due_skips_a_job_release_would_refuse_before_writing_a_row(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    refused: str,
) -> None:
    """Such a job has no row, so it would come first in every run (an ERROR each time) and,
    with a batch of them, hold every payable job up."""
    if refused == "payout_mismatch":
        bad = await confirmed_job(
            db_session, world, pro_payout_cents=PAYOUT - 100, platform_fee_cents=FEE + 100
        )
    else:
        bad = await confirmed_job(db_session, world, status=PaymentStatus.PROCESSING)
    good = await confirmed_job(db_session, world)
    assert await service(db_session, stripe, clock).release(bad.id) is (ReleaseOutcome.NEEDS_REVIEW)
    assert await transfer_of(db_session, bad.id) is None

    due = await service(db_session, stripe, clock).due(10_000)

    assert good.id in due
    assert bad.id not in due


async def test_due_reads_at_most_its_limit(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    jobs = {(await confirmed_job(db_session, world)).id for _ in range(3)}

    assert len(await service(db_session, stripe, clock).due(2)) == 2
    assert jobs <= set(await service(db_session, stripe, clock).due(10_000))


async def test_the_sweep_is_bounded_and_one_failure_never_stops_it(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    jobs = [await confirmed_job(db_session, world) for _ in range(3)]
    limits: list[int] = []

    async def due(self: TransferService, limit: int) -> list[uuid.UUID]:
        limits.append(limit)
        return [job.id for job in jobs]

    real_release = TransferService.release

    async def release_or_fail(self: TransferService, job_id: uuid.UUID) -> ReleaseOutcome:
        if job_id == jobs[0].id:
            raise RuntimeError("probe-secret-text-68")
        return await real_release(self, job_id)

    monkeypatch.setattr(TransferService, "due", due)
    monkeypatch.setattr(TransferService, "release", release_or_fail)
    caplog.set_level(logging.INFO)

    await release_confirmed_jobs(worker_ctx(db_session, stripe, transfer_release_batch_size=3))

    assert limits == [3]
    assert [c["metadata"]["job_id"] for c in stripe.creates] == [str(j.id) for j in jobs[1:]]
    [summary] = [r for r in caplog.records if r.getMessage() == "transfers_released"]
    assert summary.__dict__["outcomes"] == {"errored": 1, "created": 2}
    [failure] = [r for r in caplog.records if r.getMessage() == "transfer_release_failed"]
    assert (failure.__dict__["job_id"], failure.__dict__["error"]) == (
        str(jobs[0].id),
        "RuntimeError",
    )
    assert_no_leak(caplog)


async def test_the_sweep_releases_what_it_reads(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers
) -> None:
    job = await confirmed_job(db_session, world)

    await release_confirmed_jobs(worker_ctx(db_session, stripe, transfer_release_batch_size=10_000))

    assert str(job.id) in {c["metadata"]["job_id"] for c in stripe.creates}
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


async def test_a_sweep_that_cannot_read_ends_quietly(
    stripe: FakeStripeTransfers, caplog: pytest.LogCaptureFixture
) -> None:
    @asynccontextmanager
    async def broken() -> AsyncIterator[AsyncSession]:
        raise RuntimeError("probe-secret-text-68")
        yield  # pragma: no cover

    ctx = {"session_factory": broken, "settings": make_settings(), "stripe_transfers": stripe}

    await release_confirmed_jobs(ctx)

    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR] == [
        "transfer_release_unavailable"
    ]
    assert_no_leak(caplog)


async def test_the_task_releases_its_job(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers
) -> None:
    job = await confirmed_job(db_session, world)

    await release_transfer(worker_ctx(db_session, stripe), str(job.id))
    await release_transfer(worker_ctx(db_session, stripe), str(job.id))  # a repeat: nothing

    assert len(stripe.creates) == 1
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT


@pytest.mark.parametrize(
    "queue",
    [RecordingQueue(failure=RedisError("probe-secret-text-68")), RecordingQueue(hang=True)],
    ids=["redis_error", "timeout"],
)
async def test_a_queue_that_fails_or_hangs_never_fails_the_enqueue(
    queue: RecordingQueue, caplog: pytest.LogCaptureFixture
) -> None:
    """The confirm and the auto-confirm run call it after their commit: a Redis error or a
    timeout (the builtin TimeoutError) is logged with the job id, and the sweep takes over."""
    job_id = uuid.uuid4()

    await enqueue_transfer_release(queue, job_id, 0.05)

    [record] = [r for r in caplog.records if r.getMessage() == "transfer_release_enqueue_failed"]
    assert record.__dict__["job_id"] == str(job_id)
    assert_no_leak(caplog)


# transfer.reversed


def reversed_event(transfer_id: object, kind: str = "transfer") -> StripeEvent:
    return StripeEvent(
        stripe_event_id=f"evt_probe68{uuid.uuid4().hex[:8]}",
        event_type="transfer.reversed",
        livemode=False,
        created=NOW,
        payload={"data": {"object": {"object": kind, "id": transfer_id}}},
    )


async def test_transfer_reversed_marks_the_row_once(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await confirmed_job(db_session, world)
    await service(db_session, stripe, clock).release(job.id)
    made = stripe.by_key[f"transfer:{job.id}"]
    handler = handler_for("transfer.reversed")
    assert handler is transfer_reversed

    await handler(db_session, reversed_event(made), AfterCommit())
    await handler(db_session, reversed_event(made), AfterCommit())  # a repeat: nothing
    await handler(db_session, reversed_event("tr_unknown"), AfterCommit())

    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert row.status is TransferStatus.REVERSED
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR] == [
        "transfer_reversed"
    ]
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT
    assert_no_leak(caplog)


async def test_transfer_reversed_of_an_unknown_transfer_changes_nothing(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A reversal of a transfer no row holds leaves every created row as it is."""
    job = await confirmed_job(db_session, world)
    await service(db_session, stripe, clock).release(job.id)
    made = stripe.by_key[f"transfer:{job.id}"]

    await transfer_reversed(db_session, reversed_event("tr_probe68unknown"), AfterCommit())

    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert (row.status, row.stripe_transfer_id) == (TransferStatus.CREATED, made)
    messages = [r.getMessage() for r in caplog.records]
    assert [m for m in messages if m.startswith("transfer_reversed")] == [
        "transfer_reversed_unknown"
    ]


@pytest.mark.parametrize(("transfer_id", "kind"), [(None, "transfer"), ("tr_x", "charge")])
async def test_a_malformed_transfer_event_raises(
    db_session: AsyncSession, transfer_id: object, kind: str
) -> None:
    with pytest.raises(TransferEventMalformedError):
        await transfer_reversed(db_session, reversed_event(transfer_id, kind), AfterCommit())


# The pro's payout, the customer's view and the staff read.


def pro_job_path(job: JobRef) -> str:
    return f"/v1/pros/me/jobs/{job.id}"


async def test_the_pro_sees_the_payout_of_their_confirmed_job(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    job = await confirmed_job(db_session, world)
    scheduled = ref(await make_job(db_session, world, JobStatus.SCHEDULED))
    await db_session.commit()

    pending = (await db_client.get(pro_job_path(job), headers=world.pro.headers)).json()
    assert pending["payout"] == {"status": "pending", "amount_cents": PAYOUT}
    before = (await db_client.get(pro_job_path(scheduled), headers=world.pro.headers)).json()
    assert before["payout"] is None

    # A failed attempt still reads pending to the pro: the error is staff's.
    stripe.errors["create"] = [StripeRejectedError(code="insufficient_funds")]
    await service(db_session, stripe, clock).release(job.id)
    failed = (await db_client.get(pro_job_path(job), headers=world.pro.headers)).json()
    assert failed["payout"] == {"status": "pending", "amount_cents": PAYOUT}
    assert "insufficient_funds" not in str(failed)

    await service(db_session, stripe, clock).release(job.id)
    created = (await db_client.get(pro_job_path(job), headers=world.pro.headers)).json()
    assert created["payout"] == {"status": "created", "amount_cents": PAYOUT}
    listed = (await db_client.get("/v1/pros/me/jobs", headers=world.pro.headers)).json()
    [item] = [i for i in listed["items"] if i["id"] == str(job.id)]
    assert item["payout"] == {"status": "created", "amount_cents": PAYOUT}
    # Another pro never sees it.
    other = await db_client.get(pro_job_path(job), headers=world.other_pro.headers)
    assert other.status_code == 404


async def test_the_pro_reads_a_held_back_row_as_pending_and_a_reversal_as_no_payout(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    job = await confirmed_job(db_session, world)
    pro = update(ProProfile).where(ProProfile.id == world.pro.profile_id)
    await db_session.execute(pro.values(payouts_enabled=False))
    await db_session.commit()
    outcome = await service(db_session, stripe, clock).release(job.id)
    assert outcome is ReleaseOutcome.PAYOUTS_NOT_ENABLED

    held = (await db_client.get(pro_job_path(job), headers=world.pro.headers)).json()
    assert held["payout"] == {"status": "pending", "amount_cents": PAYOUT}
    assert PAYOUTS_NOT_ENABLED not in str(held)

    await db_session.execute(pro.values(payouts_enabled=True))
    await db_session.commit()
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    made = stripe.by_key[f"transfer:{job.id}"]
    await transfer_reversed(db_session, reversed_event(made), AfterCommit())
    await db_session.commit()

    taken_back = (await db_client.get(pro_job_path(job), headers=world.pro.headers)).json()
    assert taken_back["status"] == JobStatus.PAID_OUT.value
    assert taken_back["payout"] is None


async def test_the_customer_view_gains_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    job = await confirmed_job(db_session, world)
    await service(db_session, stripe, clock).release(job.id)

    response = await db_client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
    )

    assert response.status_code == 200
    body = response.text
    for word in ("payout", "transfer", str(PAYOUT), ACCOUNT, "tr_probe68"):
        assert word not in body


def staff_path(job_id: uuid.UUID) -> str:
    return f"/v1/admin/jobs/{job_id}/transfer"


async def test_staff_read_the_transfer_and_each_read_is_audited(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
) -> None:
    job = await confirmed_job(db_session, world)

    empty = await db_client.get(staff_path(job.id), headers=world.agent.headers)
    assert empty.status_code == 200
    assert empty.json() == {"transfer": None}
    assert empty.headers["cache-control"] == "no-store"

    await service(db_session, stripe, clock).release(job.id)
    response = await db_client.get(staff_path(job.id), headers=world.admin.headers)

    assert response.status_code == 200
    transfer = response.json()["transfer"]
    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert transfer["id"] == str(row.id)
    assert (transfer["status"], transfer["amount_cents"], transfer["attempts"]) == (
        "created",
        PAYOUT,
        1,
    )
    assert transfer["stripe_transfer_id"] == row.stripe_transfer_id
    assert "idempotency_key" not in transfer
    audits = (
        await db_session.scalars(
            select(AuditLog).where(
                AuditLog.entity_id == job.id, AuditLog.action == "job.read_transfer"
            )
        )
    ).all()
    # One transaction in this test: both rows share created_at, so they are told apart by reader.
    by_reader = {a.actor_user_id: a for a in audits}
    assert len(audits) == 2
    assert set(by_reader) == {world.agent.id, world.admin.id}
    assert {a.entity_type for a in audits} == {"job"}
    assert by_reader[world.agent.id].after == {"transfer_id": None, "status": None}
    assert by_reader[world.admin.id].after == {"transfer_id": str(row.id), "status": "created"}


async def test_only_staff_read_a_transfer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await confirmed_job(db_session, world)

    for party in (world.customer, world.pro):
        response = await db_client.get(staff_path(job.id), headers=party.headers)
        assert response.status_code == 403
    assert (await db_client.get(staff_path(job.id))).status_code == 401
    unknown = await db_client.get(staff_path(uuid.uuid4()), headers=world.agent.headers)
    assert unknown.status_code == 404
    audits = await db_session.scalars(
        select(AuditLog).where(AuditLog.action == "job.read_transfer", AuditLog.entity_id == job.id)
    )
    assert audits.all() == []


# Real commits on other connections: what the database shows while Stripe is called, and two
# workers on one job.


@dataclass
class CommittedWorld:
    sessions: async_sessionmaker[AsyncSession]
    job_id: uuid.UUID
    request_id: uuid.UUID
    pro_id: uuid.UUID


@pytest.fixture
async def committed_world(test_database_url: URL) -> AsyncIterator[CommittedWorld]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        customer = User(email=f"c68-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p68-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        session.add_all([customer, pro_user])
        await session.flush()
        profile = ProProfile(
            user_id=pro_user.id,
            stripe_account_id=f"{ACCOUNT}{tag}",
            payouts_enabled=True,
            verification_status=ProVerificationStatus.APPROVED,
        )
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([profile, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            description="Fix the faucet",
            origin=RequestOrigin.APP,
            status=RequestStatus.ACCEPTED,
        )
        async with as_status_writer(session):
            session.add(request)
            await session.flush()
        quote = Quote(
            request_id=request.id,
            pro_id=profile.id,
            amount_cents=PRICE,
            scope="Faucet",
            duration_minutes=60,
            proposed_start_at=NOW,
            expires_at=NOW,
            status=QuoteStatus.ACCEPTED,
        )
        session.add(quote)
        await session.flush()
        job = Job(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=customer.id,
            pro_id=profile.id,
            status=JobStatus.CONFIRMED,
            customer_price_cents=PRICE,
            pro_payout_cents=PAYOUT,
            platform_fee_cents=FEE,
            tax_cents=TAX,
            confirmed_at=NOW,
        )
        async with as_status_writer(session):
            session.add(job)
            await session.flush()
        payment = Payment(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=customer.id,
            amount_cents=PRICE,
            tax_cents=TAX,
            customer_total_cents=PRICE + TAX,
            platform_fee_cents=FEE,
            pro_payout_cents=PAYOUT,
            take_rate_bps=1500,
            currency="usd",
            status=PaymentStatus.SUCCEEDED,
            stripe_payment_intent_id=f"pi_probe68{tag}",
        )
        session.add(payment)
        await session.commit()
    try:
        yield CommittedWorld(
            sessions=sessions, job_id=job.id, request_id=request.id, pro_id=profile.id
        )
    finally:
        async with sessions() as session:
            await session.execute(delete(Transfer).where(Transfer.job_id == job.id))
            await session.execute(delete(Payment).where(Payment.id == payment.id))
            await session.execute(delete(JobEvent).where(JobEvent.job_id == job.id))
            await session.execute(delete(Job).where(Job.id == job.id))
            await session.execute(delete(Quote).where(Quote.id == quote.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile.id))
            await session.execute(delete(User).where(User.id.in_([customer.id, pro_user.id])))
            await session.commit()
        await engine.dispose()


async def test_the_row_is_committed_and_no_lock_held_during_the_stripe_call(
    committed_world: CommittedWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    world = committed_world
    seen: list[tuple[TransferStatus, int, datetime | None]] = []

    async def look() -> None:
        # Another connection: committed rows only, and the job's lock must be free.
        async with world.sessions() as other:
            await other.execute(text("SET LOCAL lock_timeout = '1ms'"))
            await other.execute(
                select(Job.id).where(Job.id == world.job_id).with_for_update(nowait=True)
            )
            row = (
                await other.scalars(select(Transfer).where(Transfer.job_id == world.job_id))
            ).one()
            seen.append((row.status, row.attempts, row.requested_at))
            await other.rollback()

    stripe.on_charge = look
    stripe.on_create = look
    async with world.sessions() as session:
        outcome = await service(session, stripe, clock).release(world.job_id)

    assert outcome is ReleaseOutcome.CREATED
    # In the charge lookup, then in the create.
    assert seen == [(TransferStatus.PENDING, 1, NOW)] * 2


async def test_a_retry_looks_stripe_up_with_its_attempt_committed_and_no_lock_held(
    committed_world: CommittedWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    world = committed_world
    stripe.errors["create"] = [StripeUnavailableError()]
    async with world.sessions() as session:
        first = await service(session, stripe, clock).release(world.job_id)
    assert first is ReleaseOutcome.FAILED
    seen: list[tuple[TransferStatus, int, datetime | None]] = []

    async def look() -> None:
        async with world.sessions() as other:
            await other.execute(text("SET LOCAL lock_timeout = '1ms'"))
            await other.execute(
                select(Job.id).where(Job.id == world.job_id).with_for_update(nowait=True)
            )
            row = (
                await other.scalars(select(Transfer).where(Transfer.job_id == world.job_id))
            ).one()
            seen.append((row.status, row.attempts, row.requested_at))
            await other.rollback()

    stripe.on_list = look
    clock.now += timedelta(minutes=1)
    async with world.sessions() as session:
        again = await service(session, stripe, clock).release(world.job_id)

    assert again is ReleaseOutcome.CREATED
    assert seen == [(TransferStatus.PENDING, 2, clock.now)]


@pytest.mark.parametrize("case", ["payouts_not_enabled", "stripe_error", "needs_review"])
async def test_an_outcome_without_a_transfer_is_committed(
    committed_world: CommittedWorld, stripe: FakeStripeTransfers, clock: Clock, case: str
) -> None:
    """What a release stores when no transfer is made outlives its session (a worker's
    session ends without a commit): read back on another connection."""
    world = committed_world

    async def release() -> ReleaseOutcome:
        async with world.sessions() as session:
            return await service(session, stripe, clock).release(world.job_id)

    if case == "payouts_not_enabled":
        async with world.sessions() as session:
            await session.execute(
                update(ProProfile)
                .where(ProProfile.id == world.pro_id)
                .values(payouts_enabled=False)
            )
            await session.commit()
        assert await release() is ReleaseOutcome.PAYOUTS_NOT_ENABLED
        expected = (TransferStatus.PENDING, PAYOUTS_NOT_ENABLED, 0)
    elif case == "stripe_error":
        stripe.errors["create"] = [StripeRejectedError(code="insufficient_funds")]
        assert await release() is ReleaseOutcome.FAILED
        expected = (TransferStatus.FAILED, "insufficient_funds", 1)
    else:
        stripe.errors["create"] = [StripeUnavailableError()]
        assert await release() is ReleaseOutcome.FAILED
        stripe.list_complete = False
        clock.now += timedelta(minutes=1)
        assert await release() is ReleaseOutcome.NEEDS_REVIEW
        expected = (TransferStatus.FAILED, TRANSFER_NEEDS_REVIEW, 2)

    async with world.sessions() as other:
        row = (await other.scalars(select(Transfer).where(Transfer.job_id == world.job_id))).one()
        status = await other.scalar(select(Job.status).where(Job.id == world.job_id))
    assert (row.status, row.last_error_code, row.attempts) == expected
    assert status is JobStatus.CONFIRMED


async def test_two_workers_on_one_job_make_one_transfer(
    committed_world: CommittedWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    world = committed_world
    inside = asyncio.Event()
    go_on = asyncio.Event()

    async def hold() -> None:
        inside.set()
        await go_on.wait()

    stripe.on_create = hold

    async def run() -> ReleaseOutcome:
        async with world.sessions() as session:
            return await service(session, stripe, clock).release(world.job_id)

    first = asyncio.create_task(run())
    try:
        async with asyncio.timeout(5):
            await inside.wait()
            # The cron or the confirm's task, while the first one waits on Stripe. Bounded: a
            # lock held across the Stripe call makes it wait for the first one, which waits
            # for this one; the test then fails instead of hanging.
            second = await run()
    finally:
        go_on.set()
        outcomes = await asyncio.gather(first, return_exceptions=True)

    assert (outcomes[0], second) == (ReleaseOutcome.CREATED, ReleaseOutcome.IN_FLIGHT)
    assert len(stripe.creates) == 1
    async with world.sessions() as session:
        status = await session.scalar(select(Job.status).where(Job.id == world.job_id))
        rows = (
            await session.scalars(select(Transfer).where(Transfer.job_id == world.job_id))
        ).all()
    assert status is JobStatus.PAID_OUT
    assert [(r.status, r.attempts) for r in rows] == [(TransferStatus.CREATED, 1)]


async def test_two_releases_racing_for_the_job_lock_make_one_transfer(
    committed_world: CommittedWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    """Both start at once: the job's row lock lets one through to the attempt; the other reads
    the committed attempt and leaves it alone."""
    world = committed_world

    async def run() -> ReleaseOutcome:
        async with world.sessions() as session:
            return await service(session, stripe, clock).release(world.job_id)

    outcomes = await asyncio.gather(run(), run())

    assert sorted(outcomes) == sorted([ReleaseOutcome.CREATED, ReleaseOutcome.IN_FLIGHT]) or (
        sorted(outcomes) == sorted([ReleaseOutcome.CREATED, ReleaseOutcome.NOT_CONFIRMED])
    )
    assert len(stripe.creates) == 1


@UNAPPROVED
async def test_unapproved_pro_cannot_receive_transfer(
    committed_world: CommittedWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    verification: ProVerificationStatus,
) -> None:
    """The Vault's probe of #416 r1, on committed rows: staff no longer approve the pro, whose
    payouts Stripe still has enabled; neither the sweep nor a release on its own connection
    sends anything."""
    world = committed_world
    async with world.sessions() as session:
        await session.execute(
            update(ProProfile)
            .where(ProProfile.id == world.pro_id)
            .values(verification_status=verification)
        )
        await session.commit()

    async with world.sessions() as session:
        due = await service(session, stripe, clock).due(10_000)
    async with world.sessions() as session:
        outcome = await service(session, stripe, clock).release(world.job_id)

    assert world.job_id not in due
    assert outcome is ReleaseOutcome.HELD
    assert (stripe.creates, stripe.charges, stripe.lists) == ([], [], [])


async def recover(
    session: AsyncSession, stripe: FakeStripeTransfers, clock: Clock
) -> dict[uuid.UUID, ReversalCheckOutcome]:
    """One recovery pass as the cron makes it: the unchecked rows, each read once."""
    unchecked = await service(session, stripe, clock).unchecked_for_reversal(10_000)
    return {row: await service(session, stripe, clock).check_reversal(row) for row in unchecked}


async def test_a_failed_reversal_check_is_kept_and_the_recovery_records_the_reversal(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Step 4 cannot read the stored transfer: it stays created and its check stays due (#416
    r2). Once TRANSFER_STUCK_PENDING_MINUTES have passed, the recovery reads it by its stored id,
    records the reversal Stripe holds, never creates, and leaves the job paid_out. A checked
    row is never read again."""
    caplog.set_level(logging.INFO)
    job = await confirmed_job(db_session, world)
    stripe.errors["retrieve"] = [StripeUnavailableError(request_id="req_x")]

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED

    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert row.stripe_transfer_id is not None
    # Read before any rollback expires the row.
    row_id, stripe_id = row.id, row.stripe_transfer_id
    assert (row.status, row.reversal_check_tried_at, row.reversal_checked_at) == (
        TransferStatus.CREATED,
        NOW,
        None,
    )
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT
    [failed] = [r for r in caplog.records if r.getMessage() == "transfer_reversal_check_failed"]
    assert failed.levelno == logging.WARNING
    assert_no_leak(caplog)
    # Tried just now: the recovery waits.
    assert await recover(db_session, stripe, clock) == {}

    # Stripe reversed it meanwhile (its event was gone before the id was stored).
    stripe.transfers[stripe_id] = replace(stripe.transfers[stripe_id], reversed=True)
    clock.now += CONFIG.stuck_after

    assert await recover(db_session, stripe, clock) == {row_id: ReversalCheckOutcome.REVERSED}

    await db_session.refresh(row)
    assert (row.status, row.reversal_check_tried_at, row.reversal_checked_at) == (
        TransferStatus.REVERSED,
        clock.now,
        clock.now,
    )
    # One read that answered (the failed one raised before it was recorded).
    assert stripe.retrieves == [stripe_id]
    assert (len(stripe.creates), stripe.lists) == (1, [])
    assert (await job_row(db_session, job.id)).status is JobStatus.PAID_OUT

    clock.now += CONFIG.stuck_after
    assert await recover(db_session, stripe, clock) == {}
    assert await service(db_session, stripe, clock).check_reversal(row_id) is (
        ReversalCheckOutcome.SKIPPED
    )
    assert len(stripe.retrieves) == 1


async def test_the_release_reads_the_stored_transfer_again(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)

    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED

    row = await transfer_of(db_session, job.id)
    assert row is not None
    assert stripe.retrieves == [row.stripe_transfer_id]
    assert (row.status, row.reversal_check_tried_at, row.reversal_checked_at) == (
        TransferStatus.CREATED,
        NOW,
        NOW,
    )
    clock.now += CONFIG.stuck_after
    assert await recover(db_session, stripe, clock) == {}


async def test_the_recovery_reads_never_tried_rows_first_and_a_failing_one_goes_back(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    """Rows made before the check existed (never tried) come first, then the least recently
    tried; a read that fails is stamped as tried, so it never holds the batch."""
    jobs = [await confirmed_job(db_session, world) for _ in range(3)]
    for job in jobs:
        assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    never, older, recent = [await transfer_of(db_session, job.id) for job in jobs]
    assert never is not None
    assert older is not None
    assert recent is not None
    never_id, older_id, recent_id = never.id, older.id, recent.id
    for row_id, tried in (
        (never_id, None),
        (older_id, NOW - 2 * CONFIG.stuck_after),
        (recent_id, NOW - CONFIG.stuck_after),
    ):
        await db_session.execute(
            update(Transfer)
            .where(Transfer.id == row_id)
            .values(reversal_check_tried_at=tried, reversal_checked_at=None)
        )
    await db_session.commit()

    unchecked = service(db_session, stripe, clock).unchecked_for_reversal
    assert await unchecked(10_000) == [never_id, older_id, recent_id]
    assert await unchecked(2) == [never_id, older_id]

    stripe.errors["retrieve"] = [StripeUnavailableError(request_id="req_x")]
    check = service(db_session, stripe, clock).check_reversal
    assert await check(never_id) is ReversalCheckOutcome.FAILED
    assert await unchecked(10_000) == [older_id, recent_id]

    clock.now += CONFIG.stuck_after
    assert await unchecked(10_000) == [older_id, recent_id, never_id]
    assert len(stripe.creates) == 3


async def test_the_recovery_without_a_stripe_key_reads_nothing(
    db_session: AsyncSession, world: JobWorld, stripe: FakeStripeTransfers, clock: Clock
) -> None:
    job = await confirmed_job(db_session, world)
    stripe.errors["retrieve"] = [StripeUnavailableError(request_id="req_x")]
    assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    row = await transfer_of(db_session, job.id)
    assert row is not None
    clock.now += CONFIG.stuck_after

    outcome = await service(db_session, None, clock).check_reversal(row.id)

    assert outcome is ReversalCheckOutcome.NOT_CONFIGURED
    await db_session.refresh(row)
    assert (row.reversal_check_tried_at, row.reversal_checked_at) == (NOW, None)


async def test_the_recovery_cron_reads_old_rows_and_one_failure_never_stops_it(
    db_session: AsyncSession,
    world: JobWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Rows from before the check (both stamps NULL) are read by the first run, on the
    worker's own clock; a read that raises is logged by class, the other row is still read,
    and one summary counts the outcomes. The next run leaves the failed row for later."""
    caplog.set_level(logging.INFO)
    jobs = [await confirmed_job(db_session, world) for _ in range(2)]
    for job in jobs:
        assert await service(db_session, stripe, clock).release(job.id) is ReleaseOutcome.CREATED
    row_ids = []
    for job in jobs:
        row = await transfer_of(db_session, job.id)
        assert row is not None
        assert row.stripe_transfer_id is not None
        row_ids.append(row.id)
        stripe.transfers[row.stripe_transfer_id] = replace(
            stripe.transfers[row.stripe_transfer_id], reversed=True
        )
        await db_session.execute(
            update(Transfer)
            .where(Transfer.id == row.id)
            .values(reversal_check_tried_at=None, reversal_checked_at=None)
        )
    await db_session.commit()
    stripe.errors["retrieve"] = [RuntimeError("probe-secret-text-68")]
    ctx = worker_ctx(db_session, stripe, transfer_release_batch_size=10_000)

    await check_transfer_reversals(ctx)

    statuses = {
        await db_session.scalar(select(Transfer.status).where(Transfer.id == row_id))
        for row_id in row_ids
    }
    assert statuses == {TransferStatus.CREATED, TransferStatus.REVERSED}
    [summary] = [r for r in caplog.records if r.getMessage() == "transfer_reversals_checked"]
    assert summary.__dict__["outcomes"] == {"errored": 1, "reversed": 1}
    assert len(stripe.creates) == 2
    assert_no_leak(caplog)

    caplog.clear()
    await check_transfer_reversals(ctx)
    [summary] = [r for r in caplog.records if r.getMessage() == "transfer_reversals_checked"]
    assert summary.__dict__["outcomes"] == {}


@UNAPPROVED
async def test_the_sweep_holds_then_pays_an_unapproved_pro_on_committed_rows(
    committed_world: CommittedWorld,
    stripe: FakeStripeTransfers,
    clock: Clock,
    verification: ProVerificationStatus,
) -> None:
    """The Vault's round 2 probe, through the cron on real commits: the job of a pro staff do
    not approve is held (no Stripe call of any kind, no attempt), then paid once, its frozen
    amount, after staff approve the pro again."""
    world = committed_world
    pro = update(ProProfile).where(ProProfile.id == world.pro_id)
    async with world.sessions() as session:
        await session.execute(pro.values(verification_status=verification))
        await session.commit()
    async with world.sessions() as session:
        assert world.job_id not in await service(session, stripe, clock).due(10_000)
        assert await service(session, stripe, clock).release(world.job_id) is ReleaseOutcome.HELD
    ctx: dict[str, Any] = {
        "session_factory": world.sessions,
        "stripe_transfers": stripe,
        "settings": make_settings(transfer_release_batch_size=10_000),
    }

    await release_confirmed_jobs(ctx)

    async with world.sessions() as session:
        row = await transfer_of(session, world.job_id)
        assert row is not None
        assert (row.status, row.last_error_code, row.attempts, row.requested_at) == (
            TransferStatus.PENDING,
            PRO_NOT_APPROVED,
            0,
            None,
        )
        await session.execute(pro.values(verification_status=ProVerificationStatus.APPROVED))
        await session.commit()
    assert (stripe.creates, stripe.charges, stripe.lists, stripe.retrieves) == ([], [], [], [])

    await release_confirmed_jobs(ctx)

    async with world.sessions() as session:
        row = await transfer_of(session, world.job_id)
    assert row is not None
    assert (row.status, row.attempts) == (TransferStatus.CREATED, 1)
    ours = [c for c in stripe.creates if c["metadata"]["job_id"] == str(world.job_id)]
    assert [c["amount_cents"] for c in ours] == [PAYOUT]
