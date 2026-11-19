"""An admin resolves a dispute (#76): release, partial or full refund, with Stripe faked.

Most tests run through the API on the rolled-back test session; Stripe's refund events run
their handler on it too. The committed tests use real commits on separate connections (what
another connection sees during the Stripe call, two admins at once, the worker running an
event again); their audit writes are recorded instead of written (audit_log is append-only, so
a committed row could never be cleaned up: the rows themselves are proven on the rolled-back
session), and they clean up after themselves.
"""

import asyncio
import dataclasses
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from arq import Retry
from fastapi import FastAPI
from sqlalchemy import URL, delete, select, text, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.db import violated_constraint
from app.errors import AppError
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_refunds import FoundRefunds, RefundFacts, get_stripe_refunds
from app.modules.addresses.models import Address
from app.modules.audit.models import AuditLog
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction
from app.modules.disputes.models import (
    Dispute,
    DisputePhoto,
    DisputeReason,
    DisputeResolution,
    DisputeStatus,
)
from app.modules.disputes.refund_webhooks import (
    REFUND_EVENT_TYPES,
    RefundEventMalformedError,
    refund_event_handler,
)
from app.modules.disputes.resolution import DisputeResolver, ResolutionConfig
from app.modules.disputes.router import get_dispute_clock
from app.modules.disputes.staff_schemas import DisputeResolveIn, ResolutionDecision
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.payments.models import Payment, PaymentStatus, Refund, RefundStatus, Transfer
from app.modules.payments.repository import RefundRepository
from app.modules.payments.transfers import ReleaseOutcome, TransferConfig, TransferService
from app.modules.payouts.errors import PaymentsProviderError
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole, UserStatus
from app.modules.webhooks import handlers
from app.modules.webhooks.events import AfterCommit, StripeEvent
from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus
from app.modules.webhooks.tasks import process_stripe_event
from app.money import partial_refund_cents
from app.queue import get_job_queue
from tests.conftest import make_settings
from tests.helpers import as_status_writer
from tests.job_world import (
    CUSTOMER_FIRST,
    FEE,
    PAYOUT,
    PRICE,
    TAX,
    JobWorld,
    Party,
    build_world,
    events,
    headers_for,
    job_row,
)
from tests.job_world import make_job as make_world_job
from tests.test_disputes_api import FakeStorage, RecordingQueue
from tests.test_stripe_webhooks_api import _serving, sign
from tests.test_transfers import ACCOUNT, FakeStripeTransfers, add_payment

NOW: Final = datetime(2030, 3, 1, 12, 0, tzinfo=UTC)
TOTAL: Final = PRICE + TAX
STUCK: Final = timedelta(minutes=15)
NOTE: Final = "zq76-note-sentinel: photos show the leak came back"
DESCRIPTION: Final = "zq76 the sink leaks again"
REPLY: Final = "zq76 I will come back"
# A release of an odd amount: the customer's share is 21,400 * 8,499 / 17,000 = 10,698.74...
ODD_RELEASE: Final = 8_501
ODD_REFUND: Final = 10_699
# Stripe objects the fake makes; none may reach a log.
LEAKS: Final = ("re_probe76", "pi_probe68", NOTE)
WEBHOOK_SECRET: Final = "whsec_test_fixture_value_not_real_433"


class SimulatedCrash(BaseException):
    """The API process dying right after Stripe made the refund: nothing of ours runs after."""


@dataclass
class FakeStripeRefunds:
    """Records every call and answers as Stripe does: a create with a known idempotency key
    returns the refund it made first, with `status` as Stripe's status of a new refund. `errors`
    makes the next call of an operation raise (in order); `lost_answers` makes that many creates
    make the refund and then fail as a timeout would; `crashes` makes that many creates make
    the refund and then end the process (SimulatedCrash); `on_create` runs inside the create,
    before it answers."""

    refunds: dict[str, RefundFacts] = field(default_factory=dict)
    intents: dict[str, str] = field(default_factory=dict)  # refund id -> PaymentIntent
    by_key: dict[str, str] = field(default_factory=dict)
    creates: list[dict[str, Any]] = field(default_factory=list)
    lists: list[str] = field(default_factory=list)
    retrieves: list[str] = field(default_factory=list)
    errors: dict[str, list[Exception]] = field(default_factory=dict)
    lost_answers: int = 0
    crashes: int = 0
    status: str = "succeeded"
    on_create: Callable[[], Awaitable[None]] | None = None
    # Runs inside a retrieve, after Stripe's state was read and before it is answered.
    on_retrieve: Callable[[], Awaitable[None]] | None = None
    list_complete: bool = True

    def _fail(self, operation: str) -> None:
        queued = self.errors.get(operation)
        if queued:
            raise queued.pop(0)

    def add(self, facts: RefundFacts, payment_intent_id: str) -> None:
        """A refund Stripe holds that no create of this run answered with."""
        self.refunds[facts.refund_id] = facts
        self.intents[facts.refund_id] = payment_intent_id

    async def create_refund(
        self,
        *,
        payment_intent_id: str,
        amount_cents: int,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> RefundFacts:
        self._fail("create")
        self.creates.append(
            {
                "payment_intent_id": payment_intent_id,
                "amount_cents": amount_cents,
                "metadata": dict(metadata),
                "idempotency_key": idempotency_key,
            }
        )
        if self.on_create is not None:
            await self.on_create()
        refund_id = self.by_key.get(idempotency_key)
        if refund_id is None:
            refund_id = f"re_probe76{len(self.refunds)}{uuid.uuid4().hex[:6]}"
            self.by_key[idempotency_key] = refund_id
            self.add(
                RefundFacts(
                    refund_id=refund_id,
                    amount_cents=amount_cents,
                    currency="usd",
                    dispute_id=dict(metadata).get("dispute_id"),
                    refund_key=dict(metadata).get("refund_key"),
                    status=self.status,
                    request_id="req_fake_refund",
                ),
                payment_intent_id,
            )
        if self.crashes:
            self.crashes -= 1
            raise SimulatedCrash
        if self.lost_answers:
            self.lost_answers -= 1
            raise StripeUnavailableError(request_id="req_lost")
        return self.refunds[refund_id]

    async def retrieve_refund(self, refund_id: str) -> RefundFacts:
        self._fail("retrieve")
        self.retrieves.append(refund_id)
        read = self.refunds[refund_id]
        if self.on_retrieve is not None:
            await self.on_retrieve()
        return read

    def set_status(self, refund_id: str, status: str) -> None:
        """Stripe moves the refund on."""
        self.refunds[refund_id] = dataclasses.replace(self.refunds[refund_id], status=status)

    async def list_refunds(self, payment_intent_id: str) -> FoundRefunds:
        self._fail("list")
        self.lists.append(payment_intent_id)
        found = tuple(
            facts
            for refund_id, facts in self.refunds.items()
            if self.intents[refund_id] == payment_intent_id
        )
        return FoundRefunds(refunds=found, complete=self.list_complete)


@dataclass
class Clock:
    now: datetime = NOW

    def __call__(self) -> datetime:
        return self.now


@dataclass(frozen=True)
class Case:
    """A disputed job's ids, read once (a resolve's rollback expires the session's rows)."""

    job_id: uuid.UUID
    dispute_id: uuid.UUID
    request_id: uuid.UUID
    payment_intent_id: str


@pytest.fixture
def clock(app: FastAPI) -> Clock:
    fixed = Clock()
    app.dependency_overrides[get_dispute_clock] = lambda: fixed
    return fixed


@pytest.fixture
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
def refunds(app: FastAPI) -> FakeStripeRefunds:
    fake = FakeStripeRefunds()
    app.dependency_overrides[get_stripe_refunds] = lambda: fake
    return fake


@pytest.fixture
async def world(
    app: FastAPI, db_session: AsyncSession, clock: Clock, queue: RecordingQueue
) -> JobWorld:
    app.state.storage = FakeStorage()
    built = await build_world(db_session)
    # The pro can be paid out: an Express account with payouts enabled.
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == built.pro.profile_id)
        .values(stripe_account_id=ACCOUNT, payouts_enabled=True)
    )
    return built


async def disputed(session: AsyncSession, world: JobWorld, *, paid: bool = True) -> Case:
    """A disputed job (completed, then reported), its succeeded payment and its open dispute,
    committed."""
    job = await make_world_job(
        session, world, JobStatus.DISPUTED, completed_at=NOW - timedelta(hours=2)
    )
    intent = ""
    if paid:
        payment = await add_payment(session, world, job)
        intent = payment.stripe_payment_intent_id or ""
    dispute = Dispute(
        job_id=job.id,
        opened_by=world.customer.id,
        reason_code=DisputeReason.POOR_QUALITY,
        description=DESCRIPTION,
        pro_reply=REPLY,
        pro_replied_at=NOW - timedelta(hours=1),
    )
    session.add(dispute)
    await session.commit()
    return Case(job.id, dispute.id, job.request_id, intent)


def resolve_path(case: Case) -> str:
    return f"/v1/admin/disputes/{case.dispute_id}/resolve"


async def resolve(
    client: httpx.AsyncClient,
    world: JobWorld,
    case: Case,
    decision: str,
    release: int | None = None,
    **extra: Any,
) -> httpx.Response:
    body: dict[str, Any] = {"decision": decision, "note": NOTE, **extra}
    if release is not None:
        body["pro_release_cents"] = release
    return await client.post(resolve_path(case), json=body, headers=world.admin.headers)


async def dispute_row(session: AsyncSession, case: Case) -> Dispute:
    statement = (
        select(Dispute)
        .where(Dispute.id == case.dispute_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def refund_rows(session: AsyncSession, case: Case) -> list[Refund]:
    statement = (
        select(Refund).where(Refund.job_id == case.job_id).execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def audits(session: AsyncSession, case: Case, action: str) -> list[AuditLog]:
    statement = select(AuditLog).where(
        AuditLog.action == action, AuditLog.entity_id == case.dispute_id
    )
    return list((await session.scalars(statement)).all())


def pushed(queue: RecordingQueue) -> list[tuple[object, object]]:
    """(recipient, message id) of each queued push."""
    return [(push[0], push[1]) for push in queue.pushes()]


def queued_release(queue: RecordingQueue, case: Case) -> bool:
    return queue.jobs.get(f"release-transfer:{case.job_id}") == (
        "release_transfer",
        (str(case.job_id),),
    )


async def run_transfer(session: AsyncSession, clock: Clock, case: Case) -> FakeStripeTransfers:
    """What the queued release task does, with Stripe faked."""
    stripe = FakeStripeTransfers()
    service = TransferService(session, stripe, TransferConfig(stuck_after=STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.CREATED
    return stripe


def assert_no_leak(caplog: pytest.LogCaptureFixture) -> None:
    rendered = caplog.text + "".join(str(record.__dict__) for record in caplog.records)
    for leak in LEAKS:
        assert leak not in rendered, leak


# --- The three decisions -----------------------------------------------------------------------


async def test_a_release_resolves_now_and_the_transfer_pays_the_pro_in_full(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    case = await disputed(db_session, world)

    response = await resolve(db_client, world, case, "release")

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["resolution"], body["job_status"]) == (
        "resolved",
        "released",
        "disputed",  # until the transfer is made
    )
    assert (body["pro_release_cents"], body["customer_refund_cents"], body["refund"]) == (
        PAYOUT,
        0,
        None,
    )
    row = await dispute_row(db_session, case)
    assert (row.resolved_by, row.resolution_note, row.resolved_at) == (world.admin.id, NOTE, NOW)
    assert refunds.creates == []
    assert await refund_rows(db_session, case) == []
    assert queued_release(queue, case)
    assert pushed(queue) == [
        (str(world.customer.id), f"dispute_closed:{case.job_id}"),
        (str(world.pro.id), f"dispute_payout_released:{case.job_id}"),
    ]
    [audit] = await audits(db_session, case, "dispute.resolve")
    assert (audit.actor_user_id, audit.reason) == (world.admin.id, NOTE)
    assert audit.after == {
        "status": "resolved",
        "resolution": "released",
        "job_id": str(case.job_id),
        "pro_release_cents": PAYOUT,
        "customer_refund_cents": 0,
    }

    # The queued task: the pro's payout in full, and the job paid out as the admin.
    stripe = await run_transfer(db_session, clock, case)

    assert [create["amount_cents"] for create in stripe.creates] == [PAYOUT]
    assert (await job_row(db_session, case.job_id)).status is JobStatus.PAID_OUT
    [last] = [e for e in await events(db_session, case.job_id) if e.to_status is JobStatus.PAID_OUT]
    assert (last.from_status, last.to_status, last.actor_id) == (
        JobStatus.DISPUTED,
        JobStatus.PAID_OUT,
        world.admin.id,
    )
    assert_no_leak(caplog)


async def test_a_full_refund_gives_the_customer_total_back_and_no_transfer(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    case = await disputed(db_session, world)

    response = await resolve(db_client, world, case, "refund")

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["resolution"], body["job_status"]) == ("refunded", "refunded")
    assert (body["pro_release_cents"], body["customer_refund_cents"]) == (0, TOTAL)
    [create] = refunds.creates
    assert create == {
        "payment_intent_id": case.payment_intent_id,
        "amount_cents": TOTAL,  # tax included
        "metadata": {
            "dispute_id": str(case.dispute_id),
            "job_id": str(case.job_id),
            "refund_key": f"dispute:{case.dispute_id}:refund",
        },
        "idempotency_key": f"dispute:{case.dispute_id}:refund",
    }
    [refund] = await refund_rows(db_session, case)
    assert (refund.status, refund.amount_cents, refund.attempts, refund.dispute_id) == (
        RefundStatus.CREATED,
        TOTAL,
        1,
        case.dispute_id,
    )
    stripe_refund_id, refund_id = refund.stripe_refund_id, refund.id
    assert refund.stripe_status == "succeeded"
    assert (refund.initiated_by, refund.pro_release_cents, refund.resolution_note) == (
        world.admin.id,
        0,
        NOTE,
    )
    assert body["refund"]["stripe_refund_id"] == stripe_refund_id
    assert body["refund"]["stripe_status"] == "succeeded"
    [last] = [e for e in await events(db_session, case.job_id) if e.to_status is JobStatus.REFUNDED]
    assert (last.from_status, last.to_status, last.actor_id) == (
        JobStatus.DISPUTED,
        JobStatus.REFUNDED,
        world.admin.id,
    )
    # No transfer, now or ever: the sweep never reads a refunded job.
    assert not queued_release(queue, case)
    service = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), Clock())
    assert case.job_id not in await service.due(10_000)
    assert await service.release(case.job_id) is ReleaseOutcome.NOT_CONFIRMED
    assert pushed(queue) == [
        (str(world.customer.id), f"dispute_refunded:{case.job_id}"),
        (str(world.pro.id), f"dispute_payout_refunded:{case.job_id}"),
    ]
    [request] = await audits(db_session, case, "dispute.refund_request")
    assert (request.actor_user_id, request.reason) == (world.admin.id, NOTE)
    assert request.after == {
        "step": "create",
        "resolution": "refunded",
        "job_id": str(case.job_id),
        "pro_release_cents": 0,
        "customer_refund_cents": TOTAL,
        "refund_id": str(refund_id),
        "idempotency_key": f"dispute:{case.dispute_id}:refund",
        "attempt": 1,
        "stripe_refund_id": None,
        "initiated_by": str(world.admin.id),
        "recovery": False,
    }
    [audit] = await audits(db_session, case, "dispute.resolve")
    assert (audit.actor_user_id, audit.reason) == (world.admin.id, NOTE)
    assert audit.after["stripe_refund_id"] == stripe_refund_id
    assert audit.after["customer_refund_cents"] == TOTAL
    assert (audit.after["stripe_status"], audit.after["recovery"]) == ("succeeded", False)
    assert audit.after["initiated_by"] == str(world.admin.id)
    # Settled at once: no outcome to record.
    assert await audits(db_session, case, "dispute.refund_outcome") == []
    assert_no_leak(caplog)


async def test_a_partial_resolution_splits_the_money_exactly(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    case = await disputed(db_session, world)

    response = await resolve(db_client, world, case, "partial", ODD_RELEASE)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["resolution"], body["job_status"]) == ("partial_release", "disputed")
    assert (body["pro_release_cents"], body["customer_refund_cents"]) == (ODD_RELEASE, ODD_REFUND)
    # Every cent is accounted for: the platform keeps its fee and the tax in proportion.
    assert TOTAL - ODD_RELEASE - ODD_REFUND == 2_200 == (FEE + TAX) // 2
    assert [create["amount_cents"] for create in refunds.creates] == [ODD_REFUND]
    assert queued_release(queue, case)
    assert pushed(queue) == [
        (str(world.customer.id), f"dispute_partly_refunded:{case.job_id}"),
        (str(world.pro.id), f"dispute_payout_partly_released:{case.job_id}"),
    ]

    stripe = await run_transfer(db_session, clock, case)
    # Twice: one transfer only (unique job_id), for the released part.
    again = TransferService(db_session, stripe, TransferConfig(STUCK), clock)
    assert await again.release(case.job_id) is ReleaseOutcome.NOT_CONFIRMED

    assert [create["amount_cents"] for create in stripe.creates] == [ODD_RELEASE]
    assert (await job_row(db_session, case.job_id)).status is JobStatus.PAID_OUT
    transfer = (
        await db_session.scalars(select(Transfer).where(Transfer.job_id == case.job_id))
    ).one()
    assert transfer.amount_cents == ODD_RELEASE


@pytest.mark.parametrize(
    ("total", "payout", "release", "refund"),
    [
        (21_400, 17_000, 8_500, 10_700),  # half: exact
        (21_400, 17_000, ODD_RELEASE, ODD_REFUND),  # 10,698.74 rounds up
        (21_400, 17_000, 1, 21_399),  # 21,398.74 rounds up: the platform keeps nothing
        (21_400, 17_000, 16_999, 1),  # 1.26 rounds down: the least refund is a cent
        (100, 85, 42, 51),  # 50.59
        (3, 2, 1, 2),  # 1.5: half rounds up
        (10_000, 10_000, 3_333, 6_667),  # no fee, no tax: the platform keeps 0
    ],
)
def test_the_partial_refund_is_the_unreleased_share_rounded_half_up(
    total: int, payout: int, release: int, refund: int
) -> None:
    assert partial_refund_cents(total, payout, release) == refund


def test_the_three_parts_always_add_up_and_stay_in_bounds() -> None:
    for total, payout in ((21_400, 17_000), (101, 85), (7, 5), (1_000, 1_000)):
        for release in range(1, payout):
            refund = partial_refund_cents(total, payout, release)
            kept = total - release - refund
            assert refund >= 1
            assert 0 <= kept <= total - payout


@pytest.mark.parametrize("release", [0, PAYOUT, PAYOUT + 1, -5])
def test_the_partial_refund_takes_a_true_split_only(release: int) -> None:
    with pytest.raises(ValueError, match="pro_release_cents"):
        partial_refund_cents(TOTAL, PAYOUT, release)


# --- What the server never trusts --------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"decision": "partial", "pro_release_cents": PAYOUT, "note": NOTE}, "invalid_split"),
        ({"decision": "partial", "pro_release_cents": PAYOUT + 1, "note": NOTE}, "invalid_split"),
        ({"decision": "partial", "pro_release_cents": 0, "note": NOTE}, "validation_error"),
        ({"decision": "partial", "note": NOTE}, "validation_error"),
        ({"decision": "release", "pro_release_cents": 100, "note": NOTE}, "validation_error"),
        ({"decision": "refund", "pro_release_cents": 100, "note": NOTE}, "validation_error"),
        (
            {"decision": "refund", "note": NOTE, "customer_refund_cents": 50},
            "validation_error",
        ),
        ({"decision": "refund", "note": "   "}, "validation_error"),
        ({"decision": "refund", "note": "x" * 1001}, "validation_error"),
        ({"decision": "refund", "note": "a\x00b"}, "validation_error"),
        ({"decision": "split", "note": NOTE}, "validation_error"),
    ],
    ids=[
        "release_all",
        "more_than_payout",
        "zero",
        "partial_without_amount",
        "amount_on_release",
        "amount_on_refund",
        "client_refund_amount",
        "blank_note",
        "long_note",
        "nul_note",
        "unknown_decision",
    ],
)
async def test_amounts_and_notes_the_server_cannot_trust_are_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    body: dict[str, Any],
    code: str,
) -> None:
    case = await disputed(db_session, world)

    response = await db_client.post(resolve_path(case), json=body, headers=world.admin.headers)

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == code
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert await refund_rows(db_session, case) == []
    assert (refunds.creates, refunds.lists, queue.jobs) == ([], [], {})


# --- Once ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("decision", "release"), [("release", None), ("refund", None), ("partial", ODD_RELEASE)]
)
async def test_the_same_decision_again_makes_no_stripe_call_and_changes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    decision: str,
    release: int | None,
) -> None:
    case = await disputed(db_session, world)
    first = await resolve(db_client, world, case, decision, release)
    queue.jobs.clear()

    second = await resolve(db_client, world, case, decision, release)

    assert (first.status_code, second.status_code) == (200, 200)
    assert second.json() == first.json()
    assert len(refunds.creates) == (0 if decision == "release" else 1)
    assert refunds.lists == []
    assert len(await audits(db_session, case, "dispute.resolve")) == 1
    # Nothing pushed again; the transfer is queued again when the decision pays the pro.
    assert queue.pushes() == []
    assert queued_release(queue, case) is (decision != "refund")


@pytest.mark.parametrize(
    ("first", "then"),
    [
        (("release", None), ("refund", None)),  # no refund after a release
        (("release", None), ("partial", ODD_RELEASE)),
        (("refund", None), ("release", None)),
        (("partial", ODD_RELEASE), ("partial", ODD_RELEASE + 1)),
        (("partial", ODD_RELEASE), ("refund", None)),
    ],
    ids=str,
)
async def test_another_decision_after_the_resolution_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    first: tuple[str, int | None],
    then: tuple[str, int | None],
) -> None:
    case = await disputed(db_session, world)
    assert (await resolve(db_client, world, case, *first)).status_code == 200
    creates = len(refunds.creates)

    response = await resolve(db_client, world, case, *then)

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "dispute_already_resolved"
    assert len(refunds.creates) == creates
    assert (await dispute_row(db_session, case)).resolution is {
        "release": DisputeResolution.RELEASED,
        "refund": DisputeResolution.REFUNDED,
        "partial": DisputeResolution.PARTIAL_RELEASE,
    }[first[0]]


# --- When Stripe fails --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "status", "code", "stored"),
    [
        (
            StripeRejectedError(request_id="req_x", code="charge_disputed"),
            502,
            "payments_error",
            "charge_disputed",
        ),
        (
            StripeUnavailableError(request_id="req_y"),
            503,
            "payments_unavailable",
            "StripeUnavailableError",
        ),
    ],
    ids=["rejected", "unavailable"],
)
async def test_a_failed_refund_leaves_the_dispute_open_and_the_same_decision_retries(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    error: Exception,
    status: int,
    code: str,
    stored: str,
) -> None:
    case = await disputed(db_session, world)
    refunds.errors["create"] = [error]

    failed = await resolve(db_client, world, case, "refund")

    assert failed.status_code == status, failed.text
    assert failed.json()["error"]["code"] == code
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert (await job_row(db_session, case.job_id)).status is JobStatus.DISPUTED
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.last_error_code, row.attempts) == (RefundStatus.FAILED, stored, 1)
    assert await audits(db_session, case, "dispute.resolve") == []
    [outcome] = await audits(db_session, case, "dispute.refund_outcome")
    assert (outcome.actor_user_id, outcome.reason) == (world.admin.id, NOTE)
    assert outcome.after == {
        "outcome": "rejected" if status == 502 else "unavailable",
        "code": stored,
        "refund_id": str(row.id),
        "attempt": 1,
        "stripe_event_id": None,
    }
    assert queue.jobs == {}

    clock.now += timedelta(minutes=1)  # a failed attempt is not under way: no wait
    retried = await resolve(db_client, world, case, "refund")

    assert retried.status_code == 200, retried.text
    assert retried.json()["job_status"] == "refunded"
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.attempts, row.last_error_code) == (RefundStatus.CREATED, 2, None)
    # The retry looked Stripe up first, then created with the same key.
    assert refunds.lists == [case.payment_intent_id]
    assert {create["idempotency_key"] for create in refunds.creates} == {
        f"dispute:{case.dispute_id}:refund"
    }


async def test_a_lost_refund_answer_is_adopted_without_a_second_refund(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    refunds: FakeStripeRefunds,
) -> None:
    case = await disputed(db_session, world)
    refunds.lost_answers = 1

    lost = await resolve(db_client, world, case, "partial", ODD_RELEASE)

    assert lost.status_code == 503
    [request] = await audits(db_session, case, "dispute.refund_request")
    [outcome] = await audits(db_session, case, "dispute.refund_outcome")
    assert (request.actor_user_id, request.after["attempt"]) == (world.admin.id, 1)
    assert (outcome.actor_user_id, outcome.after["outcome"]) == (world.admin.id, "unavailable")

    clock.now += timedelta(minutes=1)
    adopted = await resolve(db_client, world, case, "partial", ODD_RELEASE)

    assert adopted.status_code == 200
    assert len(refunds.creates) == 1  # found in the listing, never made again
    [made] = refunds.refunds.values()
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.stripe_refund_id) == (RefundStatus.CREATED, made.refund_id)


async def test_a_refund_under_way_holds_off_another_resolve_until_it_is_stale(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    refunds: FakeStripeRefunds,
) -> None:
    """An attempt stamped with no outcome (another admin's call in flight, or one cut off)."""
    case = await disputed(db_session, world)
    payment = (
        await db_session.scalars(select(Payment).where(Payment.request_id == case.request_id))
    ).one()
    db_session.add(
        Refund(
            job_id=case.job_id,
            payment_id=payment.id,
            dispute_id=case.dispute_id,
            amount_cents=TOTAL,
            currency="usd",
            idempotency_key=f"dispute:{case.dispute_id}:refund",
            attempts=1,
            requested_at=NOW,
            initiated_by=world.admin.id,
            pro_release_cents=0,
            resolution_note=NOTE,
        )
    )
    await db_session.commit()

    clock.now = NOW + STUCK - timedelta(seconds=1)
    busy = await resolve(db_client, world, case, "refund")
    clock.now = NOW + STUCK
    done = await resolve(db_client, world, case, "refund")

    assert busy.status_code == 409
    assert busy.json()["error"]["code"] == "resolution_in_progress"
    assert done.status_code == 200, done.text
    # The stale attempt may have reached Stripe: looked up first.
    assert refunds.lists == [case.payment_intent_id]
    assert len(refunds.creates) == 1


@pytest.mark.parametrize(("decision", "release"), [("release", None), ("partial", ODD_RELEASE)])
async def test_once_a_refund_was_tried_only_that_decision_may_be_retried(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    decision: str,
    release: int | None,
) -> None:
    case = await disputed(db_session, world)
    refunds.errors["create"] = [StripeUnavailableError()]
    assert (await resolve(db_client, world, case, "refund")).status_code == 503

    response = await resolve(db_client, world, case, decision, release)

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "refund_already_attempted"
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    [row] = await refund_rows(db_session, case)
    assert (row.attempts, row.amount_cents) == (1, TOTAL)
    assert queue.jobs == {}


@pytest.mark.parametrize("case_name", ["several", "other_amount", "more_pages"])
async def test_stripe_refunds_that_cannot_be_matched_create_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    refunds: FakeStripeRefunds,
    case_name: str,
) -> None:
    case = await disputed(db_session, world)
    refunds.errors["create"] = [StripeUnavailableError()]
    assert (await resolve(db_client, world, case, "refund")).status_code == 503
    facts = RefundFacts(
        refund_id="re_probe76x",
        amount_cents=TOTAL,
        currency="usd",
        dispute_id=str(case.dispute_id),
        status="succeeded",
        request_id=None,
    )
    if case_name == "several":
        refunds.add(facts, case.payment_intent_id)
        refunds.add(
            RefundFacts("re_probe76y", TOTAL, "usd", str(case.dispute_id), "failed", None),
            case.payment_intent_id,
        )
    elif case_name == "other_amount":
        refunds.add(
            RefundFacts("re_probe76w", TOTAL - 1, "usd", str(case.dispute_id), "succeeded", None),
            case.payment_intent_id,
        )
    else:
        refunds.list_complete = False
    creates = len(refunds.creates)
    clock.now += timedelta(minutes=1)

    response = await resolve(db_client, world, case, "refund")

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "dispute_needs_review"
    assert len(refunds.creates) == creates
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.last_error_code) == (RefundStatus.FAILED, "refund_needs_review")
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN


async def test_without_stripe_a_refund_is_503_and_a_release_still_resolves(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    app.dependency_overrides[get_stripe_refunds] = lambda: None
    refund_case = await disputed(db_session, world)
    release_case = await disputed(db_session, world)

    refused = await resolve(db_client, world, refund_case, "refund")
    released = await resolve(db_client, world, release_case, "release")

    assert refused.status_code == 503
    assert refused.json()["error"]["code"] == "not_configured"
    assert await refund_rows(db_session, refund_case) == []
    assert released.status_code == 200, released.text


@pytest.mark.parametrize(("decision", "release"), [("refund", None), ("partial", ODD_RELEASE)])
async def test_a_job_that_already_has_a_transfer_is_never_refunded(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    decision: str,
    release: int | None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A transfer row on a job whose dispute is open (staff repaired one by hand): the pro may
    be paid already, so nothing is refunded and staff look."""
    case = await disputed(db_session, world)
    payment = (
        await db_session.scalars(select(Payment).where(Payment.request_id == case.request_id))
    ).one()
    db_session.add(
        Transfer(
            job_id=case.job_id,
            payment_id=payment.id,
            pro_id=world.pro.profile_id,
            amount_cents=PAYOUT,
            currency="usd",
            idempotency_key=f"transfer:{case.job_id}",
        )
    )
    await db_session.commit()

    response = await resolve(db_client, world, case, decision, release)

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "dispute_needs_review"
    assert (refunds.creates, refunds.lists) == ([], [])
    assert await refund_rows(db_session, case) == []
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert "dispute_refund_job_has_transfer" in caplog.text


@pytest.mark.parametrize("problem", ["no_payment", "payout_mismatch"])
async def test_a_payment_that_does_not_match_the_job_needs_review(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    problem: str,
) -> None:
    case = await disputed(db_session, world, paid=problem != "no_payment")
    if problem == "payout_mismatch":
        await db_session.execute(
            update(Payment)
            .where(Payment.request_id == case.request_id)
            .values(pro_payout_cents=PAYOUT - 1, platform_fee_cents=FEE + 1)
        )
        await db_session.commit()

    response = await resolve(db_client, world, case, "release")

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "dispute_needs_review"
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert refunds.creates == []


# --- The refunds table ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("values", "constraint"),
    [
        ({"idempotency_key": "taken"}, "uq_refunds_idempotency_key"),
        (
            {"status": RefundStatus.CREATED, "stripe_status": "succeeded"},
            "ck_refunds_created_has_stripe_refund_id",
        ),
        (
            {"status": RefundStatus.CREATED, "stripe_refund_id": "re_probe76c"},
            "ck_refunds_created_has_stripe_status",
        ),
        ({"stripe_status": "pending"}, "ck_refunds_created_has_stripe_status"),
        ({"initiated_by": None}, "ck_refunds_dispute_refund_has_decision"),
        ({"pro_release_cents": None}, "ck_refunds_dispute_refund_has_decision"),
        ({"resolution_note": None}, "ck_refunds_dispute_refund_has_decision"),
        ({"pro_release_cents": -1}, "ck_refunds_pro_release_non_negative"),
        ({"amount_cents": 0}, "ck_refunds_amount_cents_positive"),
        ({"attempts": -1}, "ck_refunds_attempts_non_negative"),
    ],
    ids=[
        "one_per_key",
        "created_without_stripe_id",
        "created_without_stripe_status",
        "stripe_status_before_created",
        "no_initiating_admin",
        "no_release",
        "no_note",
        "negative_release",
        "zero_amount",
        "negative_attempts",
    ],
)
async def test_the_refunds_table_refuses_what_the_rules_forbid(
    db_session: AsyncSession, world: JobWorld, values: dict[str, Any], constraint: str
) -> None:
    case = await disputed(db_session, world)
    payment = (
        await db_session.scalars(select(Payment).where(Payment.request_id == case.request_id))
    ).one()

    def row(**fields: Any) -> Refund:
        return Refund(
            **{
                "job_id": case.job_id,
                "payment_id": payment.id,
                "dispute_id": case.dispute_id,
                "amount_cents": TOTAL,
                "currency": "usd",
                "idempotency_key": f"k-{uuid.uuid4()}",
                "initiated_by": world.admin.id,
                "pro_release_cents": 0,
                "resolution_note": NOTE,
                **fields,
            }
        )

    # Abandoned (#434): the dispute's refund rule below does not count it.
    db_session.add(row(idempotency_key="taken", status=RefundStatus.ABANDONED))
    await db_session.flush()
    db_session.add(row(**values))
    with pytest.raises(IntegrityError) as raised:
        await db_session.flush()
    assert violated_constraint(raised.value) == constraint


async def test_a_dispute_holds_one_refund_that_is_not_abandoned(
    db_session: AsyncSession, world: JobWorld
) -> None:
    """#434: any number of abandoned refunds, one other at most."""
    case = await disputed(db_session, world)
    payment_id = (
        await db_session.scalars(select(Payment.id).where(Payment.request_id == case.request_id))
    ).one()

    def row(status: RefundStatus) -> Refund:
        return Refund(
            job_id=case.job_id,
            payment_id=payment_id,
            dispute_id=case.dispute_id,
            amount_cents=TOTAL,
            currency="usd",
            idempotency_key=f"k-{uuid.uuid4()}",
            initiated_by=world.admin.id,
            pro_release_cents=0,
            resolution_note=NOTE,
            status=status,
        )

    db_session.add_all([row(RefundStatus.ABANDONED), row(RefundStatus.ABANDONED)])
    db_session.add(row(RefundStatus.FAILED))
    await db_session.flush()
    db_session.add(row(RefundStatus.PENDING))
    with pytest.raises(IntegrityError) as raised:
        await db_session.flush()
    assert violated_constraint(raised.value) == "uq_refunds_current_dispute_refund"


# --- Who -----------------------------------------------------------------------------------------


async def test_only_admins_resolve_and_only_staff_read(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
) -> None:
    case = await disputed(db_session, world)
    body = {"decision": "refund", "note": NOTE}
    for party in (world.agent, world.customer, world.pro):
        response = await db_client.post(resolve_path(case), json=body, headers=party.headers)
        assert response.status_code == 403, response.text
    for party in (world.customer, world.pro):
        listed = await db_client.get("/v1/admin/disputes", headers=party.headers)
        read = await db_client.get(f"/v1/admin/disputes/{case.dispute_id}", headers=party.headers)
        assert (listed.status_code, read.status_code) == (403, 403)
    unknown = await db_client.post(
        f"/v1/admin/disputes/{uuid.uuid4()}/resolve", json=body, headers=world.admin.headers
    )
    assert unknown.status_code == 404
    assert refunds.creates == []
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    for party in (world.agent, world.admin):
        listed = await db_client.get("/v1/admin/disputes", headers=party.headers)
        assert listed.status_code == 200


async def test_staff_read_the_list_and_an_audited_dispute_in_full(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
) -> None:
    case = await disputed(db_session, world)
    resolved = await disputed(db_session, world)
    db_session.add_all(
        [
            DisputePhoto(
                dispute_id=case.dispute_id,
                file_key=f"u/{world.customer.id}/dispute_photo/a.jpg",
                uploaded_by=world.customer.id,
                safe_key="m/zq76-ready.jpg",
                safe_status=MediaSafeStatus.READY,
                safe_content_type="image/jpeg",
            ),
            DisputePhoto(
                dispute_id=case.dispute_id,
                file_key=f"u/{world.customer.id}/dispute_photo/b.jpg",
                uploaded_by=world.customer.id,
            ),
        ]
    )
    await db_session.commit()
    assert (await resolve(db_client, world, resolved, "refund")).status_code == 200

    open_list = await db_client.get(
        "/v1/admin/disputes", params={"status": "open"}, headers=world.agent.headers
    )
    every = await db_client.get("/v1/admin/disputes", headers=world.agent.headers)
    detail = await db_client.get(
        f"/v1/admin/disputes/{case.dispute_id}", headers=world.agent.headers
    )

    assert open_list.status_code == 200, open_list.text
    [item] = [d for d in open_list.json()["disputes"] if d["id"] == str(case.dispute_id)]
    assert str(resolved.dispute_id) not in {d["id"] for d in open_list.json()["disputes"]}
    assert str(resolved.dispute_id) in {d["id"] for d in every.json()["disputes"]}
    code = (
        await db_session.scalars(
            select(ServiceRequest.public_code).where(ServiceRequest.id == case.request_id)
        )
    ).one()
    assert item["public_code"] == code
    assert item["customer_first_name"] == CUSTOMER_FIRST
    assert item["refund_failed"] is False
    assert (item["customer_total_cents"], item["pro_payout_cents"]) == (TOTAL, PAYOUT)
    assert (item["status"], item["job_status"], item["reason_code"]) == (
        "open",
        "disputed",
        "poor_quality",
    )
    # No text in the list: that is the audited detail's.
    assert DESCRIPTION not in open_list.text
    assert REPLY not in open_list.text

    assert detail.status_code == 200, detail.text
    full = detail.json()
    assert (full["description"], full["pro_reply"]) == (DESCRIPTION, REPLY)
    # The safe copy only: the original is never signed for staff.
    [photo] = full["photos"]
    assert "m/zq76-ready.jpg" in photo["url"]
    assert full["photos_pending"] == 1
    assert full["payment"]["customer_total_cents"] == TOTAL
    assert (full["refund"], full["transfer"]) == (None, None)
    assert [event["to_status"] for event in full["events"]] == ["scheduled"]
    [read] = await audits(db_session, case, "dispute.read")
    assert (read.actor_user_id, read.after) == (
        world.agent.id,
        {"job_id": str(case.job_id), "photos": 1},
    )
    unknown = await db_client.get(f"/v1/admin/disputes/{uuid.uuid4()}", headers=world.agent.headers)
    assert unknown.status_code == 404


# --- The transfer sweep ---------------------------------------------------------------------


async def test_the_sweep_takes_a_released_dispute_never_an_open_or_refunded_one(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    refunds: FakeStripeRefunds,
) -> None:
    open_case = await disputed(db_session, world)
    released = await disputed(db_session, world)
    partial = await disputed(db_session, world)
    refunded = await disputed(db_session, world)
    for case, decision, release in (
        (released, "release", None),
        (partial, "partial", ODD_RELEASE),
        (refunded, "refund", None),
    ):
        assert (await resolve(db_client, world, case, decision, release)).status_code == 200
    service = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), clock)

    due = await service.due(10_000)

    assert released.job_id in due
    assert partial.job_id in due
    assert open_case.job_id not in due
    assert refunded.job_id not in due
    assert await service.release(open_case.job_id) is ReleaseOutcome.HELD


# --- Real commits: what other connections see -------------------------------------------------


@dataclass
class CommittedCase:
    sessions: async_sessionmaker[AsyncSession]
    case: Case
    admin: UserAccount
    other_admin: UserAccount
    # (actor, action) of each audit row asked for, in order.
    audited: list[tuple[uuid.UUID, str]]
    event_rows: list[uuid.UUID]


def _account(user: User) -> UserAccount:
    return UserAccount(
        id=user.id,
        email=user.email,
        role=user.role,
        locale="en",
        status=UserStatus.ACTIVE,
        public_code="ZQ76ZQ76",
        created_at=NOW,
    )


@pytest.fixture
async def committed_case(
    test_database_url: URL, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[CommittedCase]:
    """A disputed job with its payment and open dispute, and two admins, on real commits. The
    audit writes are recorded, not written (append-only rows could never be deleted); all is
    deleted after."""
    audited: list[tuple[uuid.UUID, str]] = []

    async def record(self: AuditService, operator: Any, action: Any, *args: Any) -> None:
        audited.append((operator.user_id, action.value))

    async def record_outcome(
        self: AuditService, actor_id: uuid.UUID, action: Any, *args: Any, **kwargs: Any
    ) -> None:
        audited.append((actor_id, action.value))

    monkeypatch.setattr(AuditService, "record", record)
    monkeypatch.setattr(AuditService, "record_outcome", record_outcome)
    event_rows: list[uuid.UUID] = []
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        customer = User(email=f"c76-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p76-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        admins = [
            User(email=f"a76{n}-{tag}@x.com", password_hash="x", role=UserRole.ADMIN)
            for n in (1, 2)
        ]
        session.add_all([customer, pro_user, *admins])
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
            status=JobStatus.DISPUTED,
            customer_price_cents=PRICE,
            pro_payout_cents=PAYOUT,
            platform_fee_cents=FEE,
            tax_cents=TAX,
            completed_at=NOW,
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
            customer_total_cents=TOTAL,
            platform_fee_cents=FEE,
            pro_payout_cents=PAYOUT,
            take_rate_bps=1500,
            currency="usd",
            status=PaymentStatus.SUCCEEDED,
            stripe_payment_intent_id=f"pi_probe68{tag}",
        )
        dispute = Dispute(
            job_id=job.id,
            opened_by=customer.id,
            reason_code=DisputeReason.DAMAGE,
            description=DESCRIPTION,
        )
        session.add_all([payment, dispute])
        await session.commit()
    try:
        yield CommittedCase(
            sessions=sessions,
            case=Case(job.id, dispute.id, request.id, f"pi_probe68{tag}"),
            admin=_account(admins[0]),
            other_admin=_account(admins[1]),
            audited=audited,
            event_rows=event_rows,
        )
    finally:
        async with sessions() as session:
            await session.execute(delete(WebhookEvent).where(WebhookEvent.id.in_(event_rows)))
            await session.execute(delete(Refund).where(Refund.job_id == job.id))
            await session.execute(delete(Dispute).where(Dispute.id == dispute.id))
            await session.execute(delete(Payment).where(Payment.id == payment.id))
            await session.execute(delete(JobEvent).where(JobEvent.job_id == job.id))
            await session.execute(delete(Job).where(Job.id == job.id))
            await session.execute(delete(Quote).where(Quote.id == quote.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile.id))
            await session.execute(
                delete(User).where(
                    User.id.in_([customer.id, pro_user.id, *(admin.id for admin in admins)])
                )
            )
            await session.commit()
        await engine.dispose()


def resolver(session: AsyncSession, stripe: FakeStripeRefunds) -> DisputeResolver:
    return DisputeResolver(session, stripe, ResolutionConfig(STUCK, 1.0), Clock())


REFUND: Final = DisputeResolveIn(decision=ResolutionDecision.REFUND, note=NOTE)
RELEASE: Final = DisputeResolveIn(decision=ResolutionDecision.RELEASE, note=NOTE)


async def test_the_refund_row_is_committed_before_stripe_and_no_lock_is_held(
    committed_case: CommittedCase,
) -> None:
    """Committed intent first: during the Stripe call another connection sees the pending row
    with its attempt, and takes the job's and the dispute's locks at once; the request's audit
    row was asked for in that transaction, before the call (B2)."""
    world = committed_case
    stripe = FakeStripeRefunds()
    seen: list[tuple[RefundStatus, int, int]] = []
    audited_before_call: list[list[tuple[uuid.UUID, str]]] = []

    async def look() -> None:
        async with world.sessions() as other:
            await other.execute(text("SET LOCAL lock_timeout = '1ms'"))
            await other.execute(
                select(Job.id).where(Job.id == world.case.job_id).with_for_update(nowait=True)
            )
            await other.execute(
                select(Dispute.id)
                .where(Dispute.id == world.case.dispute_id)
                .with_for_update(nowait=True)
            )
            row = (
                await other.scalars(select(Refund).where(Refund.job_id == world.case.job_id))
            ).one()
            seen.append((row.status, row.attempts, row.amount_cents))
            await other.rollback()
        audited_before_call.append(list(world.audited))
        # Stripe refuses it, so nothing is resolved.
        raise StripeRejectedError(code="probe_refused")

    stripe.on_create = look
    async with world.sessions() as session:
        with pytest.raises(PaymentsProviderError):
            await resolver(session, stripe).resolve(
                world.admin, world.case.dispute_id, REFUND, RecordingQueue()
            )

    assert seen == [(RefundStatus.PENDING, 1, TOTAL)]
    assert audited_before_call == [[(world.admin.id, "dispute.refund_request")]]
    # The refusal is recorded before the answer, under the same admin.
    assert world.audited == [
        (world.admin.id, "dispute.refund_request"),
        (world.admin.id, "dispute.refund_outcome"),
    ]


async def test_a_second_admin_waits_for_the_first_ones_lock_and_one_decision_wins(
    committed_case: CommittedCase,
) -> None:
    """Two admins at once, a refund and a release: the refund's resolve holds the job's lock
    while it reads; the release waits on it, then finds the refund attempted and is refused.
    Bounded: without the lock the release never waits, and the test fails."""
    world = committed_case
    stripe = FakeStripeRefunds()
    stripe.errors["create"] = [StripeUnavailableError()]
    inside = asyncio.Event()
    go_on = asyncio.Event()
    holder: list[int] = []
    original = RefundRepository.current_of_dispute_for_update

    async def paused(self: RefundRepository, key: uuid.UUID) -> Refund | None:
        if not holder:
            holder.append(int(await self._session.scalar(text("SELECT pg_backend_pid()")) or 0))
            inside.set()
            await go_on.wait()
        return await original(self, key)

    async def run(admin: UserAccount, data: DisputeResolveIn) -> str:
        async with world.sessions() as session:
            try:
                await resolver(session, stripe).resolve(
                    admin, world.case.dispute_id, data, RecordingQueue()
                )
            except AppError as error:
                return error.code
            return "ok"

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(RefundRepository, "current_of_dispute_for_update", paused)
        first = asyncio.create_task(run(world.admin, REFUND))
        second: asyncio.Task[str] | None = None
        try:
            async with asyncio.timeout(5):
                await inside.wait()
                second = asyncio.create_task(run(world.other_admin, RELEASE))
                async with world.sessions() as monitor:
                    query = text(
                        "SELECT count(*) FROM pg_stat_activity"
                        " WHERE CAST(:holder AS integer) = ANY(pg_blocking_pids(pid))"
                    )
                    while not await monitor.scalar(query, {"holder": holder[0]}):
                        assert not second.done(), "the second resolve never waited"
                        await monitor.rollback()
        finally:
            go_on.set()
            outcomes = await asyncio.gather(
                first, *([second] if second else []), return_exceptions=True
            )

    assert outcomes == ["payments_unavailable", "refund_already_attempted"]
    async with world.sessions() as session:
        status = await session.scalar(
            select(Dispute.status).where(Dispute.id == world.case.dispute_id)
        )
        rows = (
            await session.scalars(select(Refund).where(Refund.job_id == world.case.job_id))
        ).all()
    assert status is DisputeStatus.OPEN
    # One attempt, the refund's: the release never reached Stripe.
    assert [(row.status, row.attempts) for row in rows] == [(RefundStatus.FAILED, 1)]


# --- Stripe's status of the refund: settled only at succeeded (#433 round 1 B1) ----------------


@pytest.fixture
def settings() -> Settings:
    # The platform endpoint's signing secret, for the signed refund events below.
    return make_settings(stripe_webhook_secret=WEBHOOK_SECRET)


def refund_event(event_type: str, refund_id: str, payload_status: str) -> StripeEvent:
    """A refund event as the route stores it. The payload's status is what the event says,
    which the handler never reads."""
    event_id = f"evt_test76{uuid.uuid4().hex[:12]}"
    return StripeEvent(
        stripe_event_id=event_id,
        event_type=event_type,
        livemode=False,
        created=NOW,
        payload={
            "id": event_id,
            "object": "event",
            "type": event_type,
            "data": {"object": {"id": refund_id, "object": "refund", "status": payload_status}},
        },
    )


async def deliver(
    session: AsyncSession, stripe: FakeStripeRefunds, queue: RecordingQueue, event: StripeEvent
) -> AfterCommit:
    """The event run as the worker runs it, on the rolled-back session: the handler of its
    (registered) type bound to the fake, the commit, then what it announced."""
    assert event.event_type in handlers.HANDLERS
    after = AfterCommit()
    await refund_event_handler(lambda: stripe)(session, event, after)
    await session.commit()
    for action in after.actions:
        await action(queue, 1.0)
    return after


async def add_admin(session: AsyncSession) -> Party:
    user = User(email=f"a76-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.ADMIN)
    session.add(user)
    await session.flush()
    admin = Party(user.id, headers_for(user.id, UserRole.ADMIN))
    await session.commit()
    return admin


def admin_account(world: JobWorld) -> UserAccount:
    return UserAccount(
        id=world.admin.id,
        email="admin@x.com",
        role=UserRole.ADMIN,
        locale="en",
        status=UserStatus.ACTIVE,
        public_code="ZQ76ZQ77",
        created_at=NOW,
    )


async def staff_flag(client: httpx.AsyncClient, world: JobWorld, case: Case) -> tuple[bool, bool]:
    """refund_failed as the staff list and the detail show it."""
    listed = await client.get("/v1/admin/disputes", headers=world.agent.headers)
    detail = await client.get(f"/v1/admin/disputes/{case.dispute_id}", headers=world.agent.headers)
    [item] = [d for d in listed.json()["disputes"] if d["id"] == str(case.dispute_id)]
    return item["refund_failed"], detail.json()["refund_failed"]


@pytest.mark.parametrize("unfinished", ["pending", "requires_action"])
@pytest.mark.parametrize(("decision", "release"), [("refund", None), ("partial", ODD_RELEASE)])
async def test_a_refund_stripe_has_not_finished_settles_nothing_until_a_retry_finds_it_done(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    decision: str,
    release: int | None,
    unfinished: str,
) -> None:
    case = await disputed(db_session, world)
    refunds.status = unfinished

    sent = await resolve(db_client, world, case, decision, release)

    assert sent.status_code == 409, sent.text
    assert sent.json()["error"]["code"] == "refund_pending"
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert (await job_row(db_session, case.job_id)).status is JobStatus.DISPUTED
    assert queue.jobs == {}  # no transfer, no message
    [made] = refunds.refunds.values()
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.stripe_refund_id, row.stripe_status) == (
        RefundStatus.CREATED,
        made.refund_id,
        unfinished,
    )
    assert await audits(db_session, case, "dispute.resolve") == []
    [outcome] = await audits(db_session, case, "dispute.refund_outcome")
    assert (outcome.actor_user_id, outcome.after["outcome"], outcome.after["stripe_status"]) == (
        world.admin.id,
        "refund_pending",
        unfinished,
    )
    held = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), clock)
    assert await held.release(case.job_id) is ReleaseOutcome.HELD

    # Still not finished: read again by its id; nothing created, nothing new to record.
    clock.now += timedelta(minutes=1)
    again = await resolve(db_client, world, case, decision, release)

    assert (again.status_code, again.json()["error"]["code"]) == (409, "refund_pending")
    assert (len(refunds.creates), refunds.lists, refunds.retrieves) == (1, [], [made.refund_id])
    assert len(await audits(db_session, case, "dispute.refund_outcome")) == 1
    assert queue.jobs == {}

    refunds.set_status(made.refund_id, "succeeded")
    done = await resolve(db_client, world, case, decision, release)

    assert done.status_code == 200, done.text
    assert done.json()["job_status"] == ("refunded" if decision == "refund" else "disputed")
    assert done.json()["refund"]["stripe_status"] == "succeeded"
    assert len(refunds.creates) == 1
    assert queued_release(queue, case) is (decision == "partial")
    assert len(pushed(queue)) == 2
    [settled] = await audits(db_session, case, "dispute.resolve")
    assert (settled.actor_user_id, settled.after["recovery"]) == (world.admin.id, False)
    requests = await audits(db_session, case, "dispute.refund_request")
    assert sorted(str(request.after["step"]) for request in requests) == [
        "create",
        "recheck",
        "recheck",
    ]


@pytest.mark.parametrize(("decision", "release"), [("refund", None), ("partial", ODD_RELEASE)])
async def test_stripe_s_refund_event_settles_the_decision_once_stripe_finished_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
    decision: str,
    release: int | None,
) -> None:
    caplog.set_level(logging.INFO)
    case = await disputed(db_session, world)
    refunds.status = "pending"
    assert (await resolve(db_client, world, case, decision, release)).status_code == 409
    [made] = refunds.refunds.values()
    refunds.set_status(made.refund_id, "succeeded")
    # Sent before Stripe finished, it arrives late and says pending: Stripe is read instead.
    event = refund_event("charge.refund.updated", made.refund_id, "pending")

    await deliver(db_session, refunds, queue, event)

    dispute = await dispute_row(db_session, case)
    assert (dispute.status, dispute.resolved_by, dispute.resolution_note) == (
        DisputeStatus.RESOLVED,
        world.admin.id,
        NOTE,
    )
    assert (dispute.pro_release_cents, dispute.customer_refund_cents) == (
        (0, TOTAL) if decision == "refund" else (ODD_RELEASE, ODD_REFUND)
    )
    assert refunds.retrieves == [made.refund_id]
    assert queued_release(queue, case) is (decision == "partial")
    assert len(pushed(queue)) == 2
    [settled] = await audits(db_session, case, "dispute.resolve")
    # Under the admin whose decision it is, naming the event that settled it.
    assert (settled.actor_user_id, settled.reason) == (world.admin.id, None)
    assert (settled.after["stripe_event_id"], settled.after["recovery"]) == (
        event.stripe_event_id,
        False,
    )
    if decision == "refund":
        assert (await job_row(db_session, case.job_id)).status is JobStatus.REFUNDED
        [last] = [
            e for e in await events(db_session, case.job_id) if e.to_status is JobStatus.REFUNDED
        ]
        assert last.actor_id == world.admin.id
    else:
        # The customer's part is back: the pro's part may go now.
        await run_transfer(db_session, clock, case)

    # The same event again, then an older one (out of order): the same state, nothing twice.
    queue.jobs.clear()
    again = await deliver(db_session, refunds, queue, event)
    older = await deliver(
        db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "pending")
    )

    assert (again.actions, older.actions, queue.jobs) == ((), (), {})
    assert len(await audits(db_session, case, "dispute.resolve")) == 1
    assert (await dispute_row(db_session, case)).status is DisputeStatus.RESOLVED
    assert_no_leak(caplog)


@pytest.mark.parametrize(
    ("event_type", "dead"), [("refund.failed", "failed"), ("refund.updated", "canceled")]
)
async def test_a_refund_stripe_fails_keeps_the_dispute_open_for_staff_and_the_payout_held(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
    event_type: str,
    dead: str,
) -> None:
    case = await disputed(db_session, world)
    refunds.status = "pending"
    assert (await resolve(db_client, world, case, "partial", ODD_RELEASE)).status_code == 409
    [made] = refunds.refunds.values()
    refunds.set_status(made.refund_id, dead)

    await deliver(db_session, refunds, queue, refund_event(event_type, made.refund_id, dead))

    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert (await job_row(db_session, case.job_id)).status is JobStatus.DISPUTED
    assert queue.jobs == {}  # no transfer, no message
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.stripe_status) == (RefundStatus.CREATED, dead)
    outcomes = await audits(db_session, case, "dispute.refund_outcome")
    assert sorted(str(outcome.after["outcome"]) for outcome in outcomes) == [
        "refund_failed",
        "refund_pending",
    ]
    [failed] = [outcome for outcome in outcomes if outcome.after["outcome"] == "refund_failed"]
    assert (failed.actor_user_id, failed.after["stripe_status"]) == (world.admin.id, dead)
    [logged] = [r for r in caplog.records if r.getMessage() == "dispute_refund_failed"]
    assert logged.levelno == logging.ERROR
    assert await staff_flag(db_client, world, case) == (True, True)

    # The decision stays as it is (staff repair it, #434), and Stripe is asked nothing more.
    creates, retrieves = len(refunds.creates), list(refunds.retrieves)
    clock.now += timedelta(minutes=1)
    same = await resolve(db_client, world, case, "partial", ODD_RELEASE)
    other = await resolve(db_client, world, case, "release")

    assert (same.status_code, same.json()["error"]["code"]) == (409, "refund_failed")
    assert (other.status_code, other.json()["error"]["code"]) == (409, "refund_already_attempted")
    assert (len(refunds.creates), refunds.retrieves) == (creates, retrieves)
    assert await audits(db_session, case, "dispute.resolve") == []
    service = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.HELD
    assert case.job_id not in await service.due(10_000)


async def test_a_refund_stripe_fails_after_it_settled_holds_the_partial_payout(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Stripe can fail a refund after it succeeded: the decision stays (the dispute is
    resolved), but the pro's part is not paid while the customer's did not come back."""
    case = await disputed(db_session, world)
    assert (await resolve(db_client, world, case, "partial", ODD_RELEASE)).status_code == 200
    [made] = refunds.refunds.values()
    refunds.set_status(made.refund_id, "failed")

    await deliver(
        db_session, refunds, queue, refund_event("charge.refund.updated", made.refund_id, "failed")
    )

    assert (await dispute_row(db_session, case)).status is DisputeStatus.RESOLVED
    [row] = await refund_rows(db_session, case)
    assert row.stripe_status == "failed"
    assert "dispute_refund_failed" in caplog.text
    assert await staff_flag(db_client, world, case) == (True, True)
    service = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.HELD
    assert case.job_id not in await service.due(10_000)


async def test_an_admin_s_read_overtaken_by_the_settling_event_leaves_it_settled(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    """Every reader reads Stripe before it takes the locks. An admin's read says pending; Stripe
    then finishes the refund and its event is applied first. The admin's older read never
    replaces it: the dispute stays settled, and the pro's part is not held."""
    case = await disputed(db_session, world)
    refunds.status = "pending"
    assert (await resolve(db_client, world, case, "partial", ODD_RELEASE)).status_code == 409
    [made] = refunds.refunds.values()

    async def event_overtakes() -> None:
        refunds.on_retrieve = None
        refunds.set_status(made.refund_id, "succeeded")
        await deliver(
            db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "pending")
        )

    refunds.on_retrieve = event_overtakes
    clock.now += timedelta(minutes=1)

    response = await resolve(db_client, world, case, "partial", ODD_RELEASE)

    assert response.status_code == 200, response.text
    assert (response.json()["status"], response.json()["refund"]["stripe_status"]) == (
        "resolved",
        "succeeded",
    )
    [row] = await refund_rows(db_session, case)
    assert row.stripe_status == "succeeded"
    assert len(await audits(db_session, case, "dispute.resolve")) == 1
    assert queued_release(queue, case)
    await run_transfer(db_session, clock, case)


async def test_a_late_read_of_succeeded_never_clears_a_failure_stored_before_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    """Stripe failed the refund after it succeeded, and the failure is stored; an event read
    before the failure (succeeded) is processed after it. The failure stands: staff still see
    it, and the pro's part stays held."""
    case = await disputed(db_session, world)
    assert (await resolve(db_client, world, case, "partial", ODD_RELEASE)).status_code == 200
    [made] = refunds.refunds.values()
    succeeded = refunds.refunds[made.refund_id]
    refunds.set_status(made.refund_id, "failed")
    await deliver(
        db_session, refunds, queue, refund_event("refund.failed", made.refund_id, "failed")
    )

    refunds.refunds[made.refund_id] = succeeded  # what the late reader saw
    await deliver(
        db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "succeeded")
    )

    [row] = await refund_rows(db_session, case)
    assert row.stripe_status == "failed"
    assert await staff_flag(db_client, world, case) == (True, True)
    service = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.HELD


async def test_a_refund_a_lost_answer_left_failed_is_stored_and_never_made_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    case = await disputed(db_session, world)
    refunds.status = "failed"
    refunds.lost_answers = 1
    assert (await resolve(db_client, world, case, "refund")).status_code == 503
    clock.now += timedelta(minutes=1)

    response = await resolve(db_client, world, case, "refund")

    assert (response.status_code, response.json()["error"]["code"]) == (409, "refund_failed")
    assert len(refunds.creates) == 1  # found in the listing, never made again
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.stripe_status) == (RefundStatus.CREATED, "failed")
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert queue.jobs == {}


async def test_an_event_for_a_refund_no_dispute_holds_is_acknowledged(
    db_session: AsyncSession,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
) -> None:
    event = refund_event("refund.updated", "re_probe76unknown", "succeeded")

    after = await deliver(db_session, refunds, queue, event)

    assert (after.actions, refunds.retrieves) == ((), [])
    [record] = [r for r in caplog.records if r.getMessage() == "refund_event_unknown_refund"]
    assert (record.__dict__["stripe_event_id"], record.__dict__["event_type"]) == (
        event.stripe_event_id,
        "refund.updated",
    )
    assert_no_leak(caplog)


@pytest.mark.parametrize(
    "data",
    [
        {"object": {"id": "re_probe76m", "object": "charge"}},
        {"object": {"object": "refund"}},
        {},
    ],
    ids=["not_a_refund", "no_id", "no_object"],
)
async def test_a_refund_event_without_a_refund_is_malformed(
    db_session: AsyncSession, refunds: FakeStripeRefunds, data: dict[str, Any]
) -> None:
    event = StripeEvent("evt_test76m", "refund.updated", False, NOW, {"data": data})

    with pytest.raises(RefundEventMalformedError):
        await refund_event_handler(lambda: refunds)(db_session, event, AfterCommit())

    assert refunds.retrieves == []


@pytest.mark.parametrize("event_type", REFUND_EVENT_TYPES)
async def test_refund_events_are_taken_only_signed_and_queued_for_their_handler(
    app: FastAPI, test_database_url: URL, event_type: str
) -> None:
    async with _serving(app, test_database_url) as webhook:
        event_id = webhook.new_id()
        body = json.dumps(
            {
                "id": event_id,
                "object": "event",
                "type": event_type,
                "livemode": False,
                "created": 1_761_000_000,
                "api_version": "2026-10-28",
                "data": {"object": {"id": "re_probe76sig", "object": "refund"}},
            }
        ).encode()

        forged = await webhook.post(body, signature=sign(body, "whsec_test_someone_else"))
        assert (forged.status_code, forged.json()["error"]["code"]) == (400, "invalid_signature")
        assert await webhook.rows(event_id) == []

        signed = await webhook.post(body, signature=sign(body, WEBHOOK_SECRET))
        assert signed.status_code == 200, signed.text
        [row] = await webhook.rows(event_id)
        # Handled, not ignored: queued for the worker.
        assert row.status is WebhookEventStatus.PENDING


# --- Who asked: audited before Stripe (#433 round 1 B2) -----------------------------------------


async def test_a_crash_after_stripe_leaves_the_request_audited_and_a_recovery_is_its_own(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    case = await disputed(db_session, world)
    refunds.crashes = 1

    with pytest.raises(SimulatedCrash):
        await resolver(db_session, refunds).resolve(
            admin_account(world), case.dispute_id, REFUND, queue
        )

    # Stripe made the refund and nothing of ours ran after: the request is on record.
    assert len(refunds.refunds) == 1
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.attempts, row.initiated_by) == (
        RefundStatus.PENDING,
        1,
        world.admin.id,
    )
    [request] = await audits(db_session, case, "dispute.refund_request")
    assert (request.actor_user_id, request.reason) == (world.admin.id, NOTE)
    assert request.after == {
        "step": "create",
        "resolution": "refunded",
        "job_id": str(case.job_id),
        "pro_release_cents": 0,
        "customer_refund_cents": TOTAL,
        "refund_id": str(row.id),
        "idempotency_key": f"dispute:{case.dispute_id}:refund",
        "attempt": 1,
        "stripe_refund_id": None,
        "initiated_by": str(world.admin.id),
        "recovery": False,
    }

    # Another admin, once that attempt is stale: the refund is found, and settled as the
    # first admin's decision, the second admin's part audited as their recovery.
    other = await add_admin(db_session)
    clock.now = NOW + STUCK
    recovered = await db_client.post(
        resolve_path(case),
        json={"decision": "refund", "note": "zq76 recovery"},
        headers=other.headers,
    )

    assert recovered.status_code == 200, recovered.text
    assert len(refunds.creates) == 1
    dispute = await dispute_row(db_session, case)
    assert (dispute.resolved_by, dispute.resolution_note) == (world.admin.id, NOTE)
    requests = await audits(db_session, case, "dispute.refund_request")
    assert sorted(
        (str(r.actor_user_id), r.after["recovery"], r.after["initiated_by"]) for r in requests
    ) == sorted(
        [
            (str(world.admin.id), False, str(world.admin.id)),
            (str(other.id), True, str(world.admin.id)),
        ]
    )
    [settled] = await audits(db_session, case, "dispute.resolve")
    assert (settled.actor_user_id, settled.reason) == (other.id, "zq76 recovery")
    assert (settled.after["recovery"], settled.after["initiated_by"]) == (True, str(world.admin.id))
    [last] = [e for e in await events(db_session, case.job_id) if e.to_status is JobStatus.REFUNDED]
    assert last.actor_id == world.admin.id


async def test_a_demotion_waits_for_the_settlement_its_admin_was_checked_for(
    committed_case: CommittedCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real commits: once the settling transaction checked the admin, their account is
    share-locked until it commits, so a demotion from another connection cannot land between
    the check and the settlement: it waits (here: gives up after its lock timeout)."""
    world = committed_case
    attempts: list[str] = []

    async def record_outcome(
        self: AuditService, actor_id: uuid.UUID, action: AuditAction, *args: Any, **kwargs: Any
    ) -> None:
        world.audited.append((actor_id, action.value))
        if action is not AuditAction.DISPUTE_RESOLVE:
            return
        # Inside the settling transaction, after the check: another connection demotes.
        async with world.sessions() as other:
            await other.execute(text("SET LOCAL lock_timeout = '100ms'"))
            try:
                await other.execute(
                    text("UPDATE users SET role = 'agent' WHERE id = :id"),
                    {"id": world.admin.id},
                )
                attempts.append("demoted")
            except DBAPIError:
                attempts.append("waited")
            await other.rollback()

    monkeypatch.setattr(AuditService, "record_outcome", record_outcome)
    async with world.sessions() as session:
        out = await resolver(session, FakeStripeRefunds()).resolve(
            world.admin, world.case.dispute_id, REFUND, RecordingQueue()
        )

    assert out.status is DisputeStatus.RESOLVED
    assert attempts == ["waited"]
    assert world.audited[-1] == (world.admin.id, "dispute.resolve")


async def test_a_stripe_failure_reading_the_refund_runs_the_event_again_then_it_settles(
    committed_case: CommittedCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The worker on real commits: Stripe failing to answer the read writes nothing and asks
    for a later run, which settles the dispute and pushes only after its commit."""
    world = committed_case
    stripe = FakeStripeRefunds()
    stripe_refund_id = f"re_probe76{uuid.uuid4().hex[:10]}"
    stripe.add(
        RefundFacts(stripe_refund_id, TOTAL, "usd", str(world.case.dispute_id), "succeeded", None),
        world.case.payment_intent_id,
    )
    stripe.errors["retrieve"] = [StripeUnavailableError(request_id="req_read")]
    monkeypatch.setitem(handlers.HANDLERS, "refund.updated", refund_event_handler(lambda: stripe))
    event = refund_event("refund.updated", stripe_refund_id, "succeeded")
    async with world.sessions() as session:
        payment_id = await session.scalar(
            select(Payment.id).where(Payment.request_id == world.case.request_id)
        )
        assert payment_id is not None
        session.add(
            Refund(
                job_id=world.case.job_id,
                payment_id=payment_id,
                dispute_id=world.case.dispute_id,
                amount_cents=TOTAL,
                currency="usd",
                idempotency_key=f"dispute:{world.case.dispute_id}:refund",
                status=RefundStatus.CREATED,
                stripe_refund_id=stripe_refund_id,
                stripe_status="pending",
                attempts=1,
                requested_at=NOW,
                initiated_by=world.admin.id,
                pro_release_cents=0,
                resolution_note=NOTE,
            )
        )
        row = WebhookEvent(
            stripe_event_id=event.stripe_event_id,
            event_type=event.event_type,
            livemode=False,
            stripe_created_at=NOW,
            status=WebhookEventStatus.PENDING,
            attempts=0,
            payload=dict(event.payload),
        )
        session.add(row)
        await session.commit()
    world.event_rows.append(row.id)
    queue = RecordingQueue()
    ctx: dict[str, Any] = {
        "settings": make_settings(),
        "session_factory": world.sessions,
        "job_try": 1,
        "redis": queue,
    }

    with pytest.raises(Retry):
        await process_stripe_event(ctx, str(row.id))

    async with world.sessions() as session:
        stored = await session.get(WebhookEvent, row.id)
        status = await session.scalar(
            select(Dispute.status).where(Dispute.id == world.case.dispute_id)
        )
    assert stored is not None
    assert (stored.status, stored.attempts) == (WebhookEventStatus.PENDING, 1)
    assert status is DisputeStatus.OPEN
    assert (world.audited, queue.jobs) == ([], {})

    ctx["job_try"] = 2
    assert await process_stripe_event(ctx, str(row.id)) == "processed"

    async with world.sessions() as session:
        dispute = (
            await session.scalars(select(Dispute).where(Dispute.id == world.case.dispute_id))
        ).one()
        job_status = await session.scalar(select(Job.status).where(Job.id == world.case.job_id))
    assert (dispute.status, dispute.resolved_by) == (DisputeStatus.RESOLVED, world.admin.id)
    assert job_status is JobStatus.REFUNDED
    assert stripe.retrieves == [stripe_refund_id]
    assert world.audited == [(world.admin.id, "dispute.resolve")]
    assert len(queue.pushes()) == 2


# --- Who settles: the active admin re-checked at settling time (#433 round 2) -----------------


async def set_account(
    session: AsyncSession, user_id: uuid.UUID, *, role: str | None = None, status: str | None = None
) -> None:
    """Another connection's change to the account, committed. Raw SQL: a copy of the user
    the session may hold is left as it was, as another connection's change would leave it."""
    await session.execute(
        text(
            "UPDATE users SET role = COALESCE(:role, role), status = COALESCE(:status, status)"
            " WHERE id = :id"
        ),
        {"role": role, "status": status, "id": user_id},
    )
    await session.commit()


async def assert_nothing_settled(
    session: AsyncSession, case: Case, queue: RecordingQueue, made_id: str, by: uuid.UUID
) -> None:
    """403's state: the dispute open, the job disputed, nothing queued or pushed, no
    dispute.resolve row; Stripe's word kept on the row; the refusal audited under `by`."""
    assert (await dispute_row(session, case)).status is DisputeStatus.OPEN
    assert (await job_row(session, case.job_id)).status is JobStatus.DISPUTED
    assert queue.jobs == {}
    assert await audits(session, case, "dispute.resolve") == []
    [row] = await refund_rows(session, case)
    assert (row.status, row.stripe_refund_id, row.stripe_status) == (
        RefundStatus.CREATED,
        made_id,
        "succeeded",
    )
    refused = [
        outcome
        for outcome in await audits(session, case, "dispute.refund_outcome")
        if outcome.after["outcome"] == "admin_not_active"
    ]
    assert [(outcome.actor_user_id, outcome.after["stripe_status"]) for outcome in refused] == [
        (by, "succeeded")
    ]


@pytest.mark.parametrize(
    "change", [{"role": "agent"}, {"status": "suspended"}], ids=["demoted", "suspended"]
)
@pytest.mark.parametrize(("decision", "release"), [("refund", None), ("partial", ODD_RELEASE)])
async def test_an_admin_demoted_during_the_stripe_call_settles_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    decision: str,
    release: int | None,
    change: dict[str, str],
) -> None:
    case = await disputed(db_session, world)

    async def demote() -> None:
        await set_account(
            db_session, world.admin.id, role=change.get("role"), status=change.get("status")
        )

    refunds.on_create = demote

    response = await resolve(db_client, world, case, decision, release)

    assert (response.status_code, response.json()["error"]["code"]) == (403, "forbidden")
    [made] = refunds.refunds.values()
    await assert_nothing_settled(db_session, case, queue, made.refund_id, world.admin.id)
    # The request was authorized and audited before Stripe: that row stays.
    [request] = await audits(db_session, case, "dispute.refund_request")
    assert request.actor_user_id == world.admin.id

    # Recoverable: another admin's same decision reads the refund and settles it.
    other = await add_admin(db_session)
    clock.now += timedelta(minutes=1)
    recovered = await db_client.post(
        resolve_path(case),
        json={"decision": decision, "note": NOTE, "pro_release_cents": release}
        if release
        else {"decision": decision, "note": NOTE},
        headers=other.headers,
    )
    assert recovered.status_code == 200, recovered.text
    assert len(refunds.creates) == 1
    dispute = await dispute_row(db_session, case)
    assert (dispute.status, dispute.resolved_by) == (DisputeStatus.RESOLVED, world.admin.id)
    [settled] = await audits(db_session, case, "dispute.resolve")
    assert (settled.actor_user_id, settled.after["recovery"], settled.after["system"]) == (
        other.id,
        True,
        False,
    )
    assert queued_release(queue, case) is (decision == "partial")


async def test_an_admin_demoted_during_a_retry_s_read_settles_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
) -> None:
    """The retry path: Stripe has finished the refund, and the admin asking to settle it is
    demoted while Stripe is read."""
    case = await disputed(db_session, world)
    refunds.status = "pending"
    assert (await resolve(db_client, world, case, "partial", ODD_RELEASE)).status_code == 409
    [made] = refunds.refunds.values()
    refunds.set_status(made.refund_id, "succeeded")
    other = await add_admin(db_session)

    async def demote() -> None:
        refunds.on_retrieve = None
        await set_account(db_session, other.id, role="agent")

    refunds.on_retrieve = demote
    clock.now += timedelta(minutes=1)

    response = await db_client.post(
        resolve_path(case),
        json={"decision": "partial", "pro_release_cents": ODD_RELEASE, "note": NOTE},
        headers=other.headers,
    )

    assert (response.status_code, response.json()["error"]["code"]) == (403, "forbidden")
    assert refunds.retrieves == [made.refund_id]
    await assert_nothing_settled(db_session, case, queue, made.refund_id, other.id)


@pytest.mark.parametrize(("decision", "release"), [("refund", None), ("partial", ODD_RELEASE)])
async def test_stripe_s_event_settles_the_request_of_an_admin_demoted_since(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    decision: str,
    release: int | None,
) -> None:
    """The money moved after the admin was authorized, and audited, before Stripe: the event
    completes it under that admin, with no check again."""
    case = await disputed(db_session, world)
    refunds.status = "pending"
    assert (await resolve(db_client, world, case, decision, release)).status_code == 409
    [made] = refunds.refunds.values()
    await set_account(db_session, world.admin.id, role="agent")
    refunds.set_status(made.refund_id, "succeeded")
    event = refund_event("refund.updated", made.refund_id, "succeeded")

    await deliver(db_session, refunds, queue, event)

    dispute = await dispute_row(db_session, case)
    assert (dispute.status, dispute.resolved_by) == (DisputeStatus.RESOLVED, world.admin.id)
    [settled] = await audits(db_session, case, "dispute.resolve")
    assert (settled.actor_user_id, settled.after["system"], settled.after["stripe_event_id"]) == (
        world.admin.id,
        True,
        event.stripe_event_id,
    )
    assert settled.after["initiated_by"] == str(world.admin.id)
    assert queued_release(queue, case) is (decision == "partial")
    assert len(pushed(queue)) == 2


@pytest.mark.parametrize(
    ("restored", "status"), [(False, 403), (True, 200)], ids=["demoted", "demoted_and_restored"]
)
async def test_the_role_at_settling_time_decides_when_two_admins_change_places(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    restored: bool,
    status: int,
) -> None:
    """During the admin's Stripe call, they are demoted and an agent is promoted (and, in the
    second case, the admin is restored before settling): the role as committed when the
    decision settles is what counts, not the one at the request's start."""
    case = await disputed(db_session, world)

    async def swap() -> None:
        await set_account(db_session, world.admin.id, role="agent")
        await set_account(db_session, world.agent.id, role="admin")
        if restored:
            await set_account(db_session, world.admin.id, role="admin")

    refunds.on_create = swap

    first = await resolve(db_client, world, case, "refund")

    assert first.status_code == status, first.text
    if restored:
        assert (await dispute_row(db_session, case)).status is DisputeStatus.RESOLVED
        return
    [made] = refunds.refunds.values()
    await assert_nothing_settled(db_session, case, queue, made.refund_id, world.admin.id)
    # The promoted one may settle it now.
    clock.now += timedelta(minutes=1)
    promoted = await db_client.post(
        resolve_path(case),
        json={"decision": "refund", "note": NOTE},
        headers=headers_for(world.agent.id, UserRole.ADMIN),
    )
    assert promoted.status_code == 200, promoted.text
    [settled] = await audits(db_session, case, "dispute.resolve")
    assert (settled.actor_user_id, settled.after["recovery"]) == (world.agent.id, True)
