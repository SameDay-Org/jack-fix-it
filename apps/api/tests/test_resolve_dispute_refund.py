"""scripts/resolve_dispute_refund.py (#434): staff abandon a dispute's refund Stripe refused for
good, failed or canceled, once Stripe shows none for the dispute that could still move money;
an admin then decides the dispute again. Stripe is faked (the resolution tests' fake); the
script runs on the rolled-back test session, its audit row checked there."""

import dataclasses
import io
import logging
import uuid
from collections.abc import Awaitable, Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_refunds import FoundRefunds, RefundFacts, get_stripe_refunds
from app.modules.audit.models import AuditLog
from app.modules.disputes.models import DisputeStatus
from app.modules.payments.models import Payment, Refund, RefundStatus
from app.modules.payments.refunds import REFUND_REFUSED_CODES
from app.modules.payments.transfer_tasks import release_confirmed_jobs
from app.modules.payments.transfers import ReleaseOutcome, TransferConfig, TransferService
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus
from scripts.resolve_dispute_refund import Io, run
from scripts.staff_operator import NOT_AN_ADMIN
from tests.audit_helpers import OPERATOR_DOMAIN, OPERATOR_EMAIL, make_staff
from tests.conftest import make_settings
from tests.job_world import JobWorld
from tests.test_create_staff_user import sessions_of
from tests.test_dispute_resolution_api import (
    ODD_RELEASE,
    STUCK,
    TOTAL,
    Case,
    Clock,
    FakeStripeRefunds,
    deliver,
    dispute_row,
    disputed,
    queued_release,
    refund_event,
    refund_rows,
    resolve,
    staff_flag,
)

# The resolution tests' fixtures, used here by name.
from tests.test_dispute_resolution_api import clock as clock
from tests.test_dispute_resolution_api import queue as queue
from tests.test_dispute_resolution_api import refunds as refunds
from tests.test_dispute_resolution_api import world as world
from tests.test_disputes_api import RecordingQueue
from tests.test_transfers import FakeStripeTransfers, worker_ctx

REASON: Final = "zq434 ticket 77"


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        refund_stuck_pending_minutes=int(STUCK.total_seconds() // 60), refund_abandon_enabled=True
    )


@pytest.fixture(autouse=True)
async def operator(db_session: AsyncSession) -> uuid.UUID:
    """The active admin every run names with --operator."""
    return await make_staff(db_session)


class Terminal:
    """Scripted answers for input(), and the captured output. `while_asked` runs while the
    prompt waits (the script asks from a worker thread)."""

    def __init__(
        self, answers: list[str] | None = None, while_asked: Callable[[], None] | None = None
    ) -> None:
        self.answers: Iterator[str] = iter(answers or ["y"])
        self.while_asked = while_asked
        self.out = io.StringIO()
        self.io = Io(prompt=self._prompt, out=self.out)

    def _prompt(self, text: str) -> str:
        if self.while_asked is not None:
            self.while_asked()
        return next(self.answers)

    @property
    def text(self) -> str:
        return self.out.getvalue()


class ListingFake(FakeStripeRefunds):
    """The resolution tests' fake, with a hook inside each listing and a page flag."""

    on_list: Callable[[], Any] | None = None

    async def list_refunds(self, payment_intent_id: str) -> FoundRefunds:
        found = await super().list_refunds(payment_intent_id)
        if self.on_list is not None:
            await self.on_list()
        return found


async def abandon(
    session: AsyncSession,
    settings: Settings,
    stripe: FakeStripeRefunds | None,
    case: Case,
    caplog: pytest.LogCaptureFixture,
    terminal: Terminal | None = None,
    *extra: str,
) -> tuple[int, Terminal]:
    """Runs the script on the case's dispute; asserts no Stripe id, email or reason is shown."""
    terminal = terminal or Terminal()
    argv = ["--dispute", str(case.dispute_id), "--abandon", "--operator", OPERATOR_EMAIL]
    argv += ["--reason", REASON, *extra]
    with caplog.at_level(logging.INFO):
        code = await run(argv, sessions_of(session), settings, stripe, terminal.io)
    rendered = caplog.text + "".join(str(record.__dict__) for record in caplog.records)
    for text in (terminal.text, rendered):
        assert "re_probe76" not in text
        assert "pi_probe68" not in text
        assert OPERATOR_DOMAIN not in text
        assert REASON not in text
    return code, terminal


async def refused_rows(session: AsyncSession, case: Case) -> list[AuditLog]:
    statement = select(AuditLog).where(
        AuditLog.action == "dispute.refund_abandon_refused", AuditLog.entity_id == case.dispute_id
    )
    return list((await session.scalars(statement)).all())


async def abandon_rows(session: AsyncSession, case: Case) -> list[AuditLog]:
    statement = select(AuditLog).where(
        AuditLog.action == "dispute.refund_abandon", AuditLog.entity_id == case.dispute_id
    )
    return list((await session.scalars(statement)).all())


async def refused_by_stripe(
    client: httpx.AsyncClient, session: AsyncSession, world: JobWorld, refunds: FakeStripeRefunds
) -> Case:
    """A dispute whose refund Stripe refused for good: the decision is now fixed."""
    case = await disputed(session, world)
    refunds.errors["create"] = [StripeRejectedError(code="charge_already_refunded")]
    assert (await resolve(client, world, case, "refund")).status_code == 502
    fixed = await resolve(client, world, case, "release")
    assert fixed.json()["error"]["code"] == "refund_already_attempted"
    return case


# --- Abandoned, then decided again -------------------------------------------------------------


@pytest.mark.parametrize("then", ["release", "refund"])
async def test_a_refund_stripe_refused_for_good_is_abandoned_and_the_dispute_decided_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    settings: Settings,
    operator: uuid.UUID,
    caplog: pytest.LogCaptureFixture,
    then: str,
) -> None:
    case = await refused_by_stripe(db_client, db_session, world, refunds)
    clock.now += timedelta(minutes=1)

    code, terminal = await abandon(db_session, settings, refunds, case, caplog)

    assert code == 0, terminal.text
    assert f"The refund of dispute {case.dispute_id} is abandoned." in terminal.text
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.last_error_code) == (RefundStatus.ABANDONED, "charge_already_refunded")
    [audit] = await abandon_rows(db_session, case)
    assert (audit.actor_user_id, audit.reason) == (operator, REASON)
    assert (audit.before["status"], audit.after["status"]) == ("failed", "abandoned")
    assert audit.before["refund_id"] == str(row.id)
    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    [logged] = [r for r in caplog.records if r.getMessage() == "dispute_refund_abandoned"]
    assert logged.__dict__["operator_id"] == str(operator)

    decided = await resolve(db_client, world, case, then)

    assert decided.status_code == 200, decided.text
    assert decided.json()["status"] == "resolved"
    if then == "release":
        # The abandoned refund holds no payout.
        service = TransferService(db_session, FakeStripeTransfers(), TransferConfig(STUCK), clock)
        assert await service.release(case.job_id) is ReleaseOutcome.CREATED
    else:
        # A new row and a new key: Stripe never answers it with the abandoned one's refusal.
        rows = await refund_rows(db_session, case)
        assert sorted((r.status, r.idempotency_key) for r in rows) == sorted(
            [
                (RefundStatus.ABANDONED, f"dispute:{case.dispute_id}:refund"),
                (RefundStatus.CREATED, f"dispute:{case.dispute_id}:refund:2"),
            ]
        )
        assert refunds.creates[-1]["idempotency_key"] == f"dispute:{case.dispute_id}:refund:2"
        assert refunds.creates[-1]["metadata"]["refund_key"] == (
            f"dispute:{case.dispute_id}:refund:2"
        )


async def test_a_refund_stripe_failed_is_abandoned_and_its_old_refund_never_adopted_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Stripe failed the refund it holds (refund_failed). Abandoned, the staff flag clears;
    the next refund's retry after a lost answer finds two refunds of the dispute in Stripe's
    list and adopts the one made for its own row only."""
    case = await disputed(db_session, world)
    refunds.status = "failed"
    assert (await resolve(db_client, world, case, "refund")).json()["error"]["code"] == (
        "refund_failed"
    )
    assert await staff_flag(db_client, world, case) == (True, True)

    code, terminal = await abandon(db_session, settings, refunds, case, caplog)

    assert code == 0, terminal.text
    assert await staff_flag(db_client, world, case) == (False, False)
    refunds.status = "succeeded"
    refunds.lost_answers = 1
    clock.now += timedelta(minutes=1)
    assert (await resolve(db_client, world, case, "refund")).status_code == 503
    clock.now += timedelta(minutes=1)
    retried = await resolve(db_client, world, case, "refund")

    assert retried.status_code == 200, retried.text
    assert len(refunds.creates) == 2  # the old one, the new one: never a third
    new = refunds.by_key[f"dispute:{case.dispute_id}:refund:2"]
    assert retried.json()["refund"]["stripe_refund_id"] == new
    assert retried.json()["refund"]["stripe_status"] == "succeeded"


# --- Refused: nothing changes ------------------------------------------------------------------


async def _pending_refund(
    session: AsyncSession, case: Case, world: JobWorld, **fields: Any
) -> None:
    payment_id = (
        await session.scalars(select(Payment.id).where(Payment.request_id == case.request_id))
    ).one()
    session.add(
        Refund(
            job_id=case.job_id,
            payment_id=payment_id,
            dispute_id=case.dispute_id,
            amount_cents=TOTAL,
            currency="usd",
            idempotency_key=f"dispute:{case.dispute_id}:refund",
            initiated_by=world.admin.id,
            pro_release_cents=0,
            resolution_note="zq434",
            **fields,
        )
    )
    await session.commit()


DASHBOARD: Final = "re_probe76dash"


@pytest.mark.parametrize(
    ("situation", "expected"),
    [
        ("resolved", "is resolved"),
        ("no_refund", "has no refund to abandon"),
        # An attempt with no outcome is never abandoned, however old: age proves nothing.
        ("in_flight", "is not final"),
        ("aged_in_flight", "is not final"),
        ("timeout_failed", "is not final"),
        ("live_at_stripe", "is not final"),
        ("stripe_lists_a_live_one", "for this dispute that is not failed or canceled"),
        ("dashboard_pending", "this dispute did not create"),
        ("dashboard_requires_action", "this dispute did not create"),
        ("dashboard_succeeded", "this dispute did not create"),
        ("another_dispute_s_refund", "this dispute did not create"),
        ("listing_incomplete", "more refunds for this payment than one page"),
        ("listing_error", "not reachable"),
        ("not_confirmed", "Not confirmed"),
    ],
)
async def test_abandoning_is_refused_unless_stripe_s_answer_is_final_and_nothing_can_move_money(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    situation: str,
    expected: str,
) -> None:
    case = await disputed(db_session, world)
    terminal = Terminal(["n"] if situation == "not_confirmed" else ["y"])
    if situation == "resolved":
        assert (await resolve(db_client, world, case, "release")).status_code == 200
    elif situation in ("in_flight", "aged_in_flight"):
        started = datetime.now(UTC) - (
            timedelta(days=3) if situation == "aged_in_flight" else timedelta(0)
        )
        await _pending_refund(db_session, case, world, attempts=1, requested_at=started)
    elif situation == "timeout_failed":
        refunds.errors["create"] = [StripeUnavailableError(request_id="req_timeout")]
        assert (await resolve(db_client, world, case, "refund")).status_code == 503
    elif situation == "live_at_stripe":
        refunds.status = "pending"
        assert (await resolve(db_client, world, case, "refund")).status_code == 409
    elif situation != "no_refund":
        refunds.errors["create"] = [StripeRejectedError(code="charge_disputed")]
        assert (await resolve(db_client, world, case, "refund")).status_code == 502
        if situation == "stripe_lists_a_live_one":
            # A refund of this dispute Stripe holds that the row never stored (made by hand).
            refunds.add(
                RefundFacts("re_probe76live", TOTAL, "usd", str(case.dispute_id), "pending", None),
                case.payment_intent_id,
            )
        elif situation.startswith("dashboard_"):
            status = situation.removeprefix("dashboard_")
            refunds.add(
                RefundFacts(DASHBOARD, 500, "usd", None, status, None), case.payment_intent_id
            )
        elif situation == "another_dispute_s_refund":
            refunds.add(
                RefundFacts(DASHBOARD, 500, "usd", str(uuid.uuid4()), "succeeded", None),
                case.payment_intent_id,
            )
        elif situation == "listing_incomplete":
            refunds.list_complete = False
        elif situation == "listing_error":
            refunds.errors["list"] = [StripeUnavailableError(request_id="req_list")]
    rows_before = [(r.id, r.status, r.attempts) for r in await refund_rows(db_session, case)]

    code, terminal = await abandon(db_session, settings, refunds, case, caplog, terminal)

    assert code == 1
    assert expected in terminal.text, terminal.text
    assert [(r.id, r.status, r.attempts) for r in await refund_rows(db_session, case)] == (
        rows_before
    )
    assert await abandon_rows(db_session, case) == []
    # Refused on the first look, before the operator confirmed: nothing written at all.
    assert await refused_rows(db_session, case) == []


@pytest.mark.parametrize("now", ["pending", "succeeded"])
async def test_a_refund_stored_failed_is_read_again_and_refused_unless_stripe_says_so_now(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    now: str,
) -> None:
    """The stored status is never trusted: the apply reads the refund by its id."""
    case = await disputed(db_session, world)
    refunds.status = "failed"
    assert (await resolve(db_client, world, case, "refund")).status_code == 409
    [made] = refunds.refunds.values()
    refunds.set_status(made.refund_id, now)

    code, terminal = await abandon(db_session, settings, refunds, case, caplog)

    assert code == 1
    assert "does not show this refund failed or canceled now" in terminal.text
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.stripe_status) == (RefundStatus.CREATED, "failed")


async def test_the_repair_is_off_until_the_setting_turns_it_on(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    caplog: pytest.LogCaptureFixture,
) -> None:
    case = await refused_by_stripe(db_client, db_session, world, refunds)

    off, terminal = await abandon(
        db_session, make_settings(refund_abandon_enabled=False), refunds, case, caplog
    )

    assert off == 1
    assert "REFUND_ABANDON_ENABLED" in terminal.text
    assert refunds.lists == []  # Stripe not even read
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.FAILED
    assert (await abandon_rows(db_session, case), await refused_rows(db_session, case)) == ([], [])


@pytest.mark.parametrize("meanwhile", ["live_refund", "stripe_unavailable"])
async def test_a_confirmed_attempt_that_is_refused_is_audited_before_the_answer(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
    operator: uuid.UUID,
    caplog: pytest.LogCaptureFixture,
    meanwhile: str,
) -> None:
    """After the operator confirmed, the apply's own Stripe read finds a refund that can move
    money (a dashboard refund made meanwhile), or Stripe is unreachable: the outcome is on
    record (a code, no provider text) before the script answers 1."""
    stripe = ListingFake()
    app.dependency_overrides[get_stripe_refunds] = lambda: stripe
    case = await refused_by_stripe(db_client, db_session, world, stripe)
    lists = 0

    async def meanwhile_at_apply() -> None:
        # Runs after a listing's snapshot: the first look's, so the apply's own read sees it.
        nonlocal lists
        lists += 1
        if lists == 1:
            if meanwhile == "live_refund":
                stripe.add(
                    RefundFacts(DASHBOARD, 500, "usd", None, "pending", None),
                    case.payment_intent_id,
                )
            else:
                stripe.errors["list"] = [StripeUnavailableError(request_id="req_gone")]

    stripe.on_list = meanwhile_at_apply

    code, _ = await abandon(db_session, settings, stripe, case, caplog)

    assert code == 1
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.FAILED
    assert await abandon_rows(db_session, case) == []
    [refused] = await refused_rows(db_session, case)
    expected = "refused_unattributed_refund" if meanwhile == "live_refund" else "stripe_unavailable"
    assert (refused.actor_user_id, refused.after) == (
        operator,
        {"outcome": expected, "refund_id": str(row.id)},
    )


async def test_an_unknown_refund_of_an_abandoned_dispute_that_succeeds_alarms_staff(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A refund no row holds whose metadata names a dispute with an abandoned refund: Stripe is
    read, staff get an ERROR with the ids, and nothing settles."""
    case = await refused_by_stripe(db_client, db_session, world, refunds)
    assert (await abandon(db_session, settings, refunds, case, caplog))[0] == 0
    late = RefundFacts("re_probe76late", TOTAL, "usd", str(case.dispute_id), "succeeded", None)
    refunds.add(late, case.payment_intent_id)
    base = refund_event("refund.updated", late.refund_id, "succeeded")
    named = {
        "id": late.refund_id,
        "object": "refund",
        "metadata": {"dispute_id": str(case.dispute_id)},
    }
    event = dataclasses.replace(base, payload={**base.payload, "data": {"object": named}})

    await deliver(db_session, refunds, queue, event)

    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    assert queue.jobs == {}
    [error] = [
        r for r in caplog.records if r.getMessage() == "refund_event_abandoned_refund_succeeded"
    ]
    assert (error.levelno, error.__dict__["dispute_id"], error.__dict__["job_id"]) == (
        logging.ERROR,
        str(case.dispute_id),
        str(case.job_id),
    )


async def test_a_refund_that_changes_while_stripe_is_read_is_not_abandoned(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The check before the prompt is not trusted: during the apply's own Stripe read, an
    admin's retry stamps a new attempt; under the locks the row is no longer the one read, and
    nothing changes."""
    stripe = ListingFake()
    app.dependency_overrides[get_stripe_refunds] = lambda: stripe
    case = await refused_by_stripe(db_client, db_session, world, stripe)
    lists = 0

    async def retry_meanwhile() -> None:
        nonlocal lists
        lists += 1
        if lists == 2:  # the apply's read
            await db_session.execute(
                update(Refund)
                .where(Refund.dispute_id == case.dispute_id)
                .values(attempts=Refund.attempts + 1)
            )
            await db_session.commit()

    stripe.on_list = retry_meanwhile

    code, terminal = await abandon(db_session, settings, stripe, case, caplog)

    assert code == 1
    assert "changed while Stripe was read" in terminal.text
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.FAILED
    assert await abandon_rows(db_session, case) == []


async def test_only_an_active_admin_abandons_and_stripe_must_be_configured(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    case = await refused_by_stripe(db_client, db_session, world, refunds)
    await make_staff(db_session, email=f"agent{OPERATOR_DOMAIN}", role=UserRole.AGENT)
    terminal = Terminal()
    argv = ["--dispute", str(case.dispute_id), "--abandon", "--operator", f"agent{OPERATOR_DOMAIN}"]

    agent = await run(argv, sessions_of(db_session), settings, refunds, terminal.io)
    unconfigured, unconfigured_terminal = await abandon(db_session, settings, None, case, caplog)

    assert (agent, unconfigured) == (1, 1)
    assert NOT_AN_ADMIN in terminal.text
    assert "Stripe is not configured" in unconfigured_terminal.text
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.FAILED
    assert await abandon_rows(db_session, case) == []


# --- Stripe's events for an abandoned refund ---------------------------------------------------


async def test_an_event_for_an_abandoned_refund_settles_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    case = await disputed(db_session, world)
    refunds.status = "canceled"
    assert (await resolve(db_client, world, case, "refund")).status_code == 409
    [made] = refunds.refunds.values()
    assert (await abandon(db_session, settings, refunds, case, caplog))[0] == 0
    queue.jobs.clear()

    await deliver(db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "x"))
    # Should Stripe ever say it succeeded after all, staff hear of it; nothing settles.
    refunds.set_status(made.refund_id, "succeeded")
    await deliver(db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "x"))

    assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
    [row] = await refund_rows(db_session, case)
    assert (row.status, row.stripe_status) == (RefundStatus.ABANDONED, "canceled")
    assert queue.jobs == {}
    [error] = [
        r for r in caplog.records if r.getMessage() == "refund_event_abandoned_refund_succeeded"
    ]
    assert error.levelno == logging.ERROR


# --- Round 2: a failed lookup is no answer to the create (B2a) ----------------------------------


@pytest.mark.parametrize("retry", ["api_key_expired", "parameter_invalid", "create_refused"])
async def test_only_the_create_s_own_refusal_makes_a_refund_abandonable(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    retry: str,
) -> None:
    """The first create's answer is lost (a timeout). The retry first lists the payment's
    refunds: a 4xx to that lookup says nothing about the first create, which may still have
    made a refund, so the row stays uncertain and the repair refuses. Only Stripe's refusal of
    the create itself is definitive."""
    case = await disputed(db_session, world)
    refunds.errors["create"] = [StripeUnavailableError(request_id="req_timeout")]
    assert (await resolve(db_client, world, case, "refund")).status_code == 503
    if retry == "create_refused":
        refunds.errors["create"] = [StripeRejectedError(code="charge_disputed")]
    else:
        refunds.errors["list"] = [StripeRejectedError(code=retry)]
    assert (await resolve(db_client, world, case, "refund")).status_code == 502

    [row] = await refund_rows(db_session, case)
    expected_code = "charge_disputed" if retry == "create_refused" else retry
    assert (row.status, row.attempts, row.last_error_code) == (
        RefundStatus.FAILED,
        2,
        expected_code,
    )
    assert row.last_error_definitive is (retry == "create_refused")

    code, terminal = await abandon(db_session, settings, refunds, case, caplog)

    if retry == "create_refused":
        assert code == 0, terminal.text
        [row] = await refund_rows(db_session, case)
        assert row.status is RefundStatus.ABANDONED
    else:
        assert code == 1
        assert "is not final" in terminal.text
        [row] = await refund_rows(db_session, case)
        assert row.status is RefundStatus.FAILED
        assert await abandon_rows(db_session, case) == []


# --- Round 2: a late refund holds the payout (B2b) ----------------------------------------------


async def reconcile_flag(
    client: httpx.AsyncClient, world: JobWorld, case: Case
) -> tuple[bool, bool]:
    """refund_needs_reconciliation as the staff list and the detail show it."""
    listed = await client.get("/v1/admin/disputes", headers=world.agent.headers)
    detail = await client.get(f"/v1/admin/disputes/{case.dispute_id}", headers=world.agent.headers)
    [item] = [d for d in listed.json()["disputes"] if d["id"] == str(case.dispute_id)]
    return item["refund_needs_reconciliation"], detail.json()["refund_needs_reconciliation"]


def late_refund_event(case: Case, refund_id: str) -> Any:
    """A signed refund.updated for a refund no row holds that names the dispute."""
    base = refund_event("refund.updated", refund_id, "succeeded")
    named = {"id": refund_id, "object": "refund", "metadata": {"dispute_id": str(case.dispute_id)}}
    return dataclasses.replace(base, payload={**base.payload, "data": {"object": named}})


@pytest.mark.parametrize(
    ("when", "late_status"),
    [
        ("release_queued_before", "succeeded"),
        ("release_queued_before", "pending"),
        ("open_then_released", "succeeded"),
        ("release_queued_before", "failed"),
    ],
)
async def test_a_refund_stripe_made_after_the_abandon_holds_the_payout_for_staff(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    when: str,
    late_status: str,
) -> None:
    """Staff abandoned the refund, then Stripe shows a refund for the dispute that no row
    holds (made or still under way). Whether an admin released the dispute before the event
    (its transfer queued, not made yet) or after it, the payout stays held: at the queued task's
    own check and in the sweep. Staff see it; a repeated event changes nothing. A late refund
    Stripe failed moved no money and holds nothing."""
    case = await refused_by_stripe(db_client, db_session, world, refunds)
    clock.now += timedelta(minutes=1)
    assert (await abandon(db_session, settings, refunds, case, caplog))[0] == 0
    if when == "release_queued_before":
        assert (await resolve(db_client, world, case, "release")).status_code == 200
        assert queued_release(queue, case)
    late = RefundFacts("re_probe76late", TOTAL, "usd", str(case.dispute_id), late_status, None)
    refunds.add(late, case.payment_intent_id)

    await deliver(db_session, refunds, queue, late_refund_event(case, late.refund_id))
    [row] = await refund_rows(db_session, case)
    first_seen = row.late_refund_seen_at
    # Stripe's retry of the same event: nothing more is written.
    clock.now += timedelta(minutes=5)
    await deliver(db_session, refunds, queue, late_refund_event(case, late.refund_id))

    if when == "open_then_released":
        assert (await dispute_row(db_session, case)).status is DisputeStatus.OPEN
        assert (await resolve(db_client, world, case, "release")).status_code == 200
    held = late_status != "failed"
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.ABANDONED
    assert (row.late_refund_seen_at is not None) is held
    assert row.late_refund_seen_at == first_seen
    assert await reconcile_flag(db_client, world, case) == (held, held)
    stripe = FakeStripeTransfers()
    # The queued task, run now: the hold is checked when it runs, not when it was queued.
    service = TransferService(db_session, stripe, TransferConfig(STUCK), clock)
    outcome = await service.release(case.job_id)
    if held:
        assert outcome is ReleaseOutcome.HELD
        # The sweep leaves it out too.
        await release_confirmed_jobs(worker_ctx(db_session, stripe))
        assert stripe.creates == []
        alarms = {
            "refund_event_abandoned_refund_succeeded",
            "refund_event_abandoned_refund_live",
            "refund_event_unrecorded_refund",
        }
        errors = [r for r in caplog.records if r.getMessage() in alarms]
        # One per delivery, each naming the hold.
        assert [(r.levelno, r.__dict__["payout_held"]) for r in errors] == [
            (logging.ERROR, "true")
        ] * 2
    else:
        assert outcome is ReleaseOutcome.CREATED


async def test_an_abandoned_refund_stripe_shows_live_again_holds_the_payout(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The abandoned row's own Stripe refund, read again after its event, is no longer failed
    or canceled: the payout of a release decided since stays held."""
    case = await disputed(db_session, world)
    refunds.status = "canceled"
    assert (await resolve(db_client, world, case, "refund")).status_code == 409
    [made] = refunds.refunds.values()
    clock.now += timedelta(minutes=1)
    assert (await abandon(db_session, settings, refunds, case, caplog))[0] == 0
    assert (await resolve(db_client, world, case, "release")).status_code == 200
    refunds.set_status(made.refund_id, "pending")

    await deliver(db_session, refunds, queue, refund_event("refund.updated", made.refund_id, "x"))

    [row] = await refund_rows(db_session, case)
    assert (row.status, row.late_refund_seen_at is not None) == (RefundStatus.ABANDONED, True)
    stripe = FakeStripeTransfers()
    service = TransferService(db_session, stripe, TransferConfig(STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.HELD
    assert stripe.creates == []
    [error] = [r for r in caplog.records if r.getMessage() == "refund_event_abandoned_refund_live"]
    assert error.levelno == logging.ERROR


# --- Round 2: an operator who loses admin at the apply (B4) -------------------------------------


@pytest.mark.parametrize("loss", ["demoted", "suspended"])
async def test_an_operator_who_loses_admin_during_the_apply_is_refused_and_audited(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
    operator: uuid.UUID,
    caplog: pytest.LogCaptureFixture,
    loss: str,
) -> None:
    """The operator was an active admin when the script started and confirmed; during the
    apply's Stripe read they are demoted or suspended. The abandon is refused and rolled back,
    and the refusal is on record for them (operator_not_admin) before the script answers 1."""
    stripe = ListingFake()
    app.dependency_overrides[get_stripe_refunds] = lambda: stripe
    case = await refused_by_stripe(db_client, db_session, world, stripe)
    lists = 0

    async def lose_admin_at_apply() -> None:
        nonlocal lists
        lists += 1
        if lists == 2:  # the apply's own read
            values: dict[str, Any] = (
                {"role": UserRole.AGENT} if loss == "demoted" else {"status": UserStatus.SUSPENDED}
            )
            await db_session.execute(update(User).where(User.id == operator).values(**values))
            await db_session.commit()

    stripe.on_list = lose_admin_at_apply

    code, terminal = await abandon(db_session, settings, stripe, case, caplog)

    assert code == 1
    assert NOT_AN_ADMIN in terminal.text
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.FAILED
    assert await abandon_rows(db_session, case) == []
    [refused] = await refused_rows(db_session, case)
    assert (refused.actor_user_id, refused.after, refused.reason) == (
        operator,
        {"outcome": "operator_not_admin", "refund_id": str(row.id)},
        REASON,
    )


# --- Round 3: a late refund is placed by its key ---------------------------------------------


class AnswerLaterFake(ListingFake):
    """Stripe makes the refund, then `after_create` runs before the create answers: Stripe's
    event can reach the worker before the API stores the refund's id."""

    after_create: Callable[[RefundFacts], Awaitable[None]] | None = None

    async def create_refund(self, **kwargs: Any) -> RefundFacts:
        made = await super().create_refund(**kwargs)
        hook, self.after_create = self.after_create, None
        if hook is not None:
            await hook(made)
        return made


def event_of(made: RefundFacts) -> Any:
    """Stripe's refund.updated for `made`, its metadata as Stripe holds it."""
    base = refund_event("refund.updated", made.refund_id, made.status)
    metadata = {
        key: value
        for key, value in (("dispute_id", made.dispute_id), ("refund_key", made.refund_key))
        if value is not None
    }
    refund = {"id": made.refund_id, "object": "refund", "metadata": metadata}
    return dataclasses.replace(base, payload={**base.payload, "data": {"object": refund}})


@pytest.mark.parametrize("arrives", ["before_its_answer", "after_its_answer", "after_lost_answer"])
async def test_a_new_decision_s_own_early_refund_event_holds_nothing(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    arrives: str,
) -> None:
    """After an abandon, an admin decides a partial refund: its refund (key
    dispute:<id>:refund:2) is the dispute's current one. Its event, whether it comes before the
    create's answer is stored, after it, or after that answer was lost, is never taken for the
    abandoned refund's late money: nothing is marked, and the partial payout is paid."""
    stripe = AnswerLaterFake()
    app.dependency_overrides[get_stripe_refunds] = lambda: stripe
    case = await refused_by_stripe(db_client, db_session, world, stripe)
    clock.now += timedelta(minutes=1)
    assert (await abandon(db_session, settings, stripe, case, caplog))[0] == 0
    early: list[RefundFacts] = []

    async def event_before_the_answer(made: RefundFacts) -> None:
        early.append(made)
        await deliver(db_session, stripe, queue, event_of(made))

    if arrives == "before_its_answer":
        stripe.after_create = event_before_the_answer
    if arrives == "after_lost_answer":
        stripe.lost_answers = 1
        lost = await resolve(db_client, world, case, "partial", ODD_RELEASE)
        assert lost.status_code == 503
        [made] = [
            r for r in stripe.refunds.values() if r.refund_key and r.refund_key.endswith(":2")
        ]
        await deliver(db_session, stripe, queue, event_of(made))
        clock.now += timedelta(minutes=1)

    decided = await resolve(db_client, world, case, "partial", ODD_RELEASE)
    assert decided.status_code == 200, decided.text
    assert decided.json()["status"] == "resolved"
    if arrives == "after_its_answer":
        [made] = [
            r for r in stripe.refunds.values() if r.refund_key and r.refund_key.endswith(":2")
        ]
        await deliver(db_session, stripe, queue, event_of(made))
    if arrives == "before_its_answer":
        assert len(early) == 1

    rows = await refund_rows(db_session, case)
    assert [row.late_refund_seen_at for row in rows] == [None, None]
    assert await reconcile_flag(db_client, world, case) == (False, False)
    assert not [
        r for r in caplog.records if r.getMessage().startswith("refund_event_") and r.levelno >= 40
    ]
    transfers = FakeStripeTransfers()
    service = TransferService(db_session, transfers, TransferConfig(STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.CREATED
    [paid] = transfers.creates
    assert paid["amount_cents"] == ODD_RELEASE


@pytest.mark.parametrize("key", ["abandoned_attempt", "no_attempt"])
async def test_a_late_refund_of_the_abandoned_attempt_or_of_no_attempt_still_holds(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    key: str,
) -> None:
    """The new partial decision settled; then Stripe shows a refund carrying the abandoned
    attempt's key (dispute:<id>:refund), or a key no attempt of the dispute holds: money may
    have gone back outside the records. The payout stays held and staff see it."""
    stripe = AnswerLaterFake()
    app.dependency_overrides[get_stripe_refunds] = lambda: stripe
    case = await refused_by_stripe(db_client, db_session, world, stripe)
    clock.now += timedelta(minutes=1)
    assert (await abandon(db_session, settings, stripe, case, caplog))[0] == 0
    assert (await resolve(db_client, world, case, "partial", ODD_RELEASE)).status_code == 200
    refund_key = (
        f"dispute:{case.dispute_id}:refund"
        if key == "abandoned_attempt"
        else f"dispute:{case.dispute_id}:refund:9"
    )
    late = RefundFacts(
        "re_probe76late3", 700, "usd", str(case.dispute_id), "succeeded", None, refund_key
    )
    stripe.add(late, case.payment_intent_id)

    await deliver(db_session, stripe, queue, event_of(late))
    await deliver(db_session, stripe, queue, event_of(late))

    rows = await refund_rows(db_session, case)
    [abandoned] = [row for row in rows if row.status is RefundStatus.ABANDONED]
    assert abandoned.late_refund_seen_at is not None
    assert await reconcile_flag(db_client, world, case) == (True, True)
    transfers = FakeStripeTransfers()
    service = TransferService(db_session, transfers, TransferConfig(STUCK), clock)
    assert await service.release(case.job_id) is ReleaseOutcome.HELD
    assert transfers.creates == []
    expected = (
        "refund_event_abandoned_refund_succeeded"
        if key == "abandoned_attempt"
        else "refund_event_unrecorded_refund"
    )
    alarms = [r for r in caplog.records if r.getMessage() == expected]
    assert [(r.levelno, r.__dict__["payout_held"]) for r in alarms] == [(logging.ERROR, "true")] * 2


@pytest.mark.parametrize(
    "code",
    [
        "api_key_expired",  # authentication (401)
        "secret_key_required",  # permission (403)
        "parameter_invalid_integer",  # parameter validation (400)
        "idempotency_key_in_use",  # an idempotency conflict
        "resource_missing",  # any other 4xx code outside the refusal list
        None,  # no code at all
    ],
)
async def test_a_retry_create_refused_before_it_was_evaluated_never_makes_it_abandonable(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    code: str | None,
) -> None:
    """#450 round 4. The first create is made at Stripe but its answer is lost. The retry's
    listing does not show it yet, so the retry creates, and Stripe refuses THAT create with a
    code that says nothing about the refund (REFUND_REFUSED_CODES holds none of them). The row
    stays uncertain, the repair refuses to abandon it, and the same decision's next retry finds
    the first refund and carries on with it: one refund at Stripe, never abandoned."""
    case = await disputed(db_session, world)
    refunds.lost_answers = 1
    assert (await resolve(db_client, world, case, "refund")).status_code == 503
    list_refunds = refunds.list_refunds

    async def not_listed_yet(payment_intent_id: str) -> FoundRefunds:
        return FoundRefunds(refunds=(), complete=True)

    monkeypatch.setattr(refunds, "list_refunds", not_listed_yet)
    refunds.errors["create"] = [StripeRejectedError(code=code)]
    assert (await resolve(db_client, world, case, "refund")).status_code == 502

    [row] = await refund_rows(db_session, case)
    assert (row.status, row.attempts, row.last_error_definitive) == (
        RefundStatus.FAILED,
        2,
        False,
    )
    status, terminal = await abandon(db_session, settings, refunds, case, caplog)
    assert status == 1
    assert "is not final" in terminal.text
    assert await abandon_rows(db_session, case) == []

    monkeypatch.setattr(refunds, "list_refunds", list_refunds)
    third = await resolve(db_client, world, case, "refund")

    assert third.status_code == 200, third.text
    [row] = await refund_rows(db_session, case)
    assert row.status is RefundStatus.CREATED
    assert len(refunds.refunds) == 1


@pytest.mark.parametrize("code", sorted(REFUND_REFUSED_CODES))
async def test_a_create_refused_with_a_refusal_code_is_definitive(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    refunds: FakeStripeRefunds,
    code: str,
) -> None:
    case = await disputed(db_session, world)
    refunds.errors["create"] = [StripeRejectedError(code=code)]

    assert (await resolve(db_client, world, case, "refund")).status_code == 502

    [row] = await refund_rows(db_session, case)
    assert (row.status, row.last_error_code, row.last_error_definitive) == (
        RefundStatus.FAILED,
        code,
        True,
    )
