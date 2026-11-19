"""scripts/resolve_dispute_refund.py (#434): staff abandon a dispute's refund Stripe refused for
good, failed or canceled, once Stripe shows none for the dispute that could still move money;
an admin then decides the dispute again. Stripe is faked (the resolution tests' fake); the
script runs on the rolled-back test session, its audit row checked there."""

import io
import logging
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_errors import StripeRejectedError
from app.integrations.stripe_refunds import FoundRefunds, RefundFacts, get_stripe_refunds
from app.modules.audit.models import AuditLog
from app.modules.disputes.models import DisputeStatus
from app.modules.payments.models import Payment, Refund, RefundStatus
from app.modules.payments.transfers import ReleaseOutcome, TransferConfig, TransferService
from app.modules.users.types import UserRole
from scripts.resolve_dispute_refund import Io, run
from scripts.staff_operator import NOT_AN_ADMIN
from tests.audit_helpers import OPERATOR_DOMAIN, OPERATOR_EMAIL, make_staff
from tests.conftest import make_settings
from tests.job_world import JobWorld
from tests.test_create_staff_user import sessions_of
from tests.test_dispute_resolution_api import (
    STUCK,
    TOTAL,
    Case,
    Clock,
    FakeStripeRefunds,
    deliver,
    dispute_row,
    disputed,
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
from tests.test_transfers import FakeStripeTransfers

REASON: Final = "zq434 ticket 77"


@pytest.fixture
def settings() -> Settings:
    return make_settings(refund_stuck_pending_minutes=int(STUCK.total_seconds() // 60))


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


@pytest.mark.parametrize(
    ("situation", "expected"),
    [
        ("resolved", "is resolved"),
        ("no_refund", "has no refund to abandon"),
        ("in_flight", "is under way"),
        ("live_at_stripe", "may still give the money back"),
        ("stripe_lists_a_live_one", "not failed or canceled"),
        ("listing_incomplete", "more refunds for this payment than one page"),
        ("not_confirmed", "Not confirmed"),
    ],
)
async def test_abandoning_is_refused_while_the_refund_could_still_move_money(
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
    elif situation == "in_flight":
        # Stamped just now, as the script's own (real) clock reads it.
        await _pending_refund(db_session, case, world, attempts=1, requested_at=datetime.now(UTC))
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
        elif situation == "listing_incomplete":
            refunds.list_complete = False
    rows_before = [(r.id, r.status, r.attempts) for r in await refund_rows(db_session, case)]

    code, terminal = await abandon(db_session, settings, refunds, case, caplog, terminal)

    assert code == 1
    assert expected in terminal.text, terminal.text
    assert [(r.id, r.status, r.attempts) for r in await refund_rows(db_session, case)] == (
        rows_before
    )
    assert await abandon_rows(db_session, case) == []


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
