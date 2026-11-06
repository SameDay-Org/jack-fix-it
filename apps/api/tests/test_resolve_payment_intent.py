"""scripts/resolve_payment_intent.py: staff settle an unresolved PaymentIntent create (#58,
Gatekeeper round 1 B1). Never calls Stripe: the payments tests' fake stands in for the wrapper."""

import asyncio
import io
import json
import logging
import re
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_payments import PaymentIntentFacts, StripePayments
from app.modules.payments.models import CURRENCY, Payment
from app.modules.users.models import User
from app.observability import JsonFormatter
from scripts.resolve_payment_intent import Io, run
from tests.conftest import make_settings
from tests.test_create_staff_user import sessions_of
from tests.test_opportunities_api import World, build_world
from tests.test_payments_api import FakeStripePayments, accepted_request

INTENT = "pi_resolve0fixture1"
CUSTOMER = "cus_resolve0fixture1"
AMOUNT = 10_000
# Any PaymentIntent, customer or secret, not the help's pi_...
STRIPE_ID = re.compile(r"(pi|cus|ek)_[A-Za-z0-9]")
# Older than the reconcile window (the app answers 409), younger than Stripe's key retention.
YOUNG = timedelta(hours=23)
OLD = timedelta(hours=25)


class Terminal:
    """Scripted answers for input(), and the captured output. `while_asked` runs while the
    prompt waits (the script asks from a worker thread)."""

    def __init__(
        self, answers: list[str] | None = None, while_asked: Callable[[], None] | None = None
    ) -> None:
        self.answers: Iterator[str] = iter(answers or [])
        self.while_asked = while_asked
        self.prompts: list[str] = []
        self.out = io.StringIO()
        self.io = Io(prompt=self._prompt, out=self.out)

    def _prompt(self, text: str) -> str:
        self.prompts.append(text)
        if self.while_asked is not None:
            self.while_asked()
        return next(self.answers)

    @property
    def text(self) -> str:
        return self.out.getvalue()


@pytest.fixture
def settings() -> Settings:
    return make_settings(stripe_secret_key=None)


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


@dataclass(frozen=True)
class Lost:
    """A payment whose create is unresolved, and what Stripe shows of its intent."""

    payment_id: uuid.UUID
    facts: PaymentIntentFacts


async def lost_payment(
    session: AsyncSession,
    world: World,
    *,
    intent_id: str | None = None,
    attempted: timedelta | None = OLD,
) -> Lost:
    """A committed payment of the world's customer (Stripe Customer CUSTOMER), with no intent
    unless `intent_id`, its create attempted `attempted` ago."""
    request_id, quote_id, _ = await accepted_request(session, world, amount=AMOUNT, pending=0)
    await session.execute(
        update(User).where(User.id == world.customer_id).values(stripe_customer_id=CUSTOMER)
    )
    payment = Payment(
        request_id=request_id,
        quote_id=quote_id,
        customer_id=world.customer_id,
        amount_cents=AMOUNT,
        tax_cents=0,
        customer_total_cents=AMOUNT,
        platform_fee_cents=1_500,
        pro_payout_cents=8_500,
        take_rate_bps=1_500,
        currency=CURRENCY,
        stripe_payment_intent_id=intent_id,
        payment_intent_requested_at=None if attempted is None else datetime.now(UTC) - attempted,
    )
    session.add(payment)
    await session.commit()
    facts = PaymentIntentFacts(
        payment_intent_id=INTENT,
        amount_cents=AMOUNT,
        currency=CURRENCY,
        customer_id=CUSTOMER,
        payment_id=str(payment.id),
    )
    return Lost(payment.id, facts)


def stripe_with(*facts: PaymentIntentFacts) -> FakeStripePayments:
    stripe = FakeStripePayments()
    for one in facts:
        stripe.add_intent(one)
    return stripe


async def stored(
    session: AsyncSession, payment_id: uuid.UUID
) -> tuple[str | None, datetime | None]:
    row = (
        await session.execute(
            select(Payment.stripe_payment_intent_id, Payment.payment_intent_requested_at)
            .where(Payment.id == payment_id)
            .execution_options(populate_existing=True)
        )
    ).one()
    return row[0], row[1]


async def resolve(
    session: AsyncSession,
    settings: Settings,
    stripe: StripePayments | None,
    terminal: Terminal,
    caplog: pytest.LogCaptureFixture,
    *argv: str,
) -> tuple[int, list[dict[str, object]]]:
    """Runs the script; asserts that neither its output nor its logs hold a Stripe id, and
    returns the exit code and the JSON log lines."""
    with caplog.at_level(logging.DEBUG):
        code = await run(list(argv), sessions_of(session), settings, stripe, terminal.io)
    formatter = JsonFormatter()
    lines = [formatter.format(record) for record in caplog.records]
    for text in (terminal.text, *lines):
        assert not STRIPE_ID.search(text), text
    return code, [json.loads(line) for line in lines]


def resolved(logs: list[dict[str, object]]) -> list[tuple[object, object]]:
    return [
        (log["payment_id"], log["action"])
        for log in logs
        if log["message"] == "payment_intent_resolved"
    ]


async def test_adopt_stores_the_intent_after_confirming(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    lost = await lost_payment(db_session, world)
    terminal = Terminal(answers=["y"])

    code, logs = await resolve(
        db_session,
        settings,
        stripe_with(lost.facts),
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--adopt",
        INTENT,
    )

    assert code == 0, terminal.text
    assert (await stored(db_session, lost.payment_id))[0] == INTENT
    assert terminal.prompts == ["Proceed? [y/N] "]
    assert terminal.text.splitlines()[-1] == (
        f"Payment {lost.payment_id} now has the given PaymentIntent."
    )
    assert resolved(logs) == [(str(lost.payment_id), "adopt")]


async def test_adopt_not_confirmed_changes_nothing(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    lost = await lost_payment(db_session, world)
    before = await stored(db_session, lost.payment_id)
    terminal = Terminal(answers=["n"])

    code, logs = await resolve(
        db_session,
        settings,
        stripe_with(lost.facts),
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--adopt",
        INTENT,
    )

    assert code == 1
    assert "Not confirmed; nothing changed." in terminal.text
    assert await stored(db_session, lost.payment_id) == before
    assert resolved(logs) == []


@pytest.mark.parametrize(
    "mismatch",
    [
        lambda f: replace(f, payment_id=str(uuid.uuid4())),
        lambda f: replace(f, payment_id=None),
        lambda f: replace(f, amount_cents=AMOUNT + 1),
        lambda f: replace(f, currency="eur"),
        lambda f: replace(f, customer_id="cus_resolve0someoneelse"),
    ],
    ids=["other_payment", "no_payment", "amount", "currency", "customer"],
)
async def test_adopt_refuses_an_intent_that_is_not_this_payments(
    db_session: AsyncSession,
    world: World,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    mismatch: Callable[[PaymentIntentFacts], PaymentIntentFacts],
) -> None:
    lost = await lost_payment(db_session, world)
    terminal = Terminal(answers=["y"])

    code, logs = await resolve(
        db_session,
        settings,
        stripe_with(mismatch(lost.facts)),
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--adopt",
        INTENT,
    )

    assert code == 1
    assert "is not this payment's" in terminal.text
    assert terminal.prompts == []
    assert (await stored(db_session, lost.payment_id))[0] is None
    assert resolved(logs) == []


async def test_adopt_refuses_a_payment_with_an_intent_or_none(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    held = await lost_payment(db_session, world, intent_id="pi_resolve0held")
    stripe = stripe_with(held.facts)

    code, _ = await resolve(
        db_session,
        settings,
        stripe,
        Terminal(),
        caplog,
        "--payment",
        str(held.payment_id),
        "--adopt",
        INTENT,
    )
    missing = Terminal()
    missing_code, _ = await resolve(
        db_session,
        settings,
        stripe,
        missing,
        caplog,
        "--payment",
        str(uuid.uuid4()),
        "--adopt",
        INTENT,
    )

    assert code == missing_code == 1
    assert (await stored(db_session, held.payment_id))[0] == "pi_resolve0held"
    assert "No payment has this id; nothing changed." in missing.text


async def test_adopt_refuses_an_intent_another_payment_holds(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    lost = await lost_payment(db_session, world)
    await lost_payment(db_session, world, intent_id=INTENT)
    terminal = Terminal(answers=["y"])

    code, _ = await resolve(
        db_session,
        settings,
        stripe_with(lost.facts),
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--adopt",
        INTENT,
    )

    assert code == 1
    assert "already another payment's" in terminal.text
    assert (await stored(db_session, lost.payment_id))[0] is None


@pytest.mark.parametrize("text", ["sk_test_pasted0secret", "pi_x_secret_y", "cus_resolve0x"])
async def test_adopt_refuses_text_that_is_not_an_intent_id(
    db_session: AsyncSession,
    world: World,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    text: str,
) -> None:
    lost = await lost_payment(db_session, world)
    terminal = Terminal()

    code, _ = await resolve(
        db_session,
        settings,
        stripe_with(lost.facts),
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--adopt",
        text,
    )

    assert code == 1
    assert "--adopt takes a PaymentIntent id (pi_...)." in terminal.text
    assert text not in terminal.text


async def test_adopt_without_stripe_or_of_an_unknown_intent_is_refused(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    lost = await lost_payment(db_session, world)
    argv = ("--payment", str(lost.payment_id), "--adopt", INTENT)
    unconfigured, unknown = Terminal(), Terminal()

    first, _ = await resolve(db_session, settings, None, unconfigured, caplog, *argv)
    second, _ = await resolve(db_session, settings, stripe_with(), unknown, caplog, *argv)

    assert first == second == 1
    assert "Stripe is not configured" in unconfigured.text
    assert "Stripe refused to read that PaymentIntent" in unknown.text
    assert (await stored(db_session, lost.payment_id))[0] is None


async def test_allow_new_clears_an_attempt_older_than_24_hours(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    lost = await lost_payment(db_session, world, attempted=OLD)
    terminal = Terminal(answers=["yes"])

    code, logs = await resolve(
        db_session,
        settings,
        None,  # no Stripe needed
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--allow-new",
    )

    assert code == 0, terminal.text
    assert await stored(db_session, lost.payment_id) == (None, None)
    assert terminal.text.splitlines()[-1] == f"Payment {lost.payment_id} can create a new one."
    assert resolved(logs) == [(str(lost.payment_id), "allow_new")]


@pytest.mark.parametrize(
    ("attempted", "intent_id", "message"),
    [
        (YOUNG, None, "less than 24 hours ago and may still land"),
        (None, None, "no PaymentIntent create to clear"),
        (OLD, "pi_resolve0held", "already has a PaymentIntent"),
    ],
    ids=["young", "never_attempted", "has_intent"],
)
async def test_allow_new_refuses(
    db_session: AsyncSession,
    world: World,
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
    attempted: timedelta | None,
    intent_id: str | None,
    message: str,
) -> None:
    lost = await lost_payment(db_session, world, attempted=attempted, intent_id=intent_id)
    before = await stored(db_session, lost.payment_id)
    terminal = Terminal(answers=["y"])

    code, logs = await resolve(
        db_session,
        settings,
        None,
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--allow-new",
    )

    assert code == 1
    assert message in terminal.text
    assert terminal.prompts == []
    assert await stored(db_session, lost.payment_id) == before
    assert resolved(logs) == []


async def test_apply_checks_again_what_changed_during_the_prompt(
    db_session: AsyncSession, world: World, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """While the operator reads the prompt, the customer's own retry may store the intent; the
    apply, under the row lock, finds it and changes nothing."""
    lost = await lost_payment(db_session, world)
    loop = asyncio.get_running_loop()

    async def store_meanwhile() -> None:
        await db_session.execute(
            update(Payment)
            .where(Payment.id == lost.payment_id)
            .values(stripe_payment_intent_id="pi_resolve0meanwhile")
        )
        await db_session.commit()

    def change() -> None:
        asyncio.run_coroutine_threadsafe(store_meanwhile(), loop).result(timeout=10)

    terminal = Terminal(answers=["y"], while_asked=change)

    code, logs = await resolve(
        db_session,
        settings,
        stripe_with(lost.facts),
        terminal,
        caplog,
        "--payment",
        str(lost.payment_id),
        "--adopt",
        INTENT,
    )

    assert code == 1
    assert "already has a PaymentIntent" in terminal.text
    assert (await stored(db_session, lost.payment_id))[0] == "pi_resolve0meanwhile"
    assert resolved(logs) == []


@pytest.mark.parametrize(
    "argv",
    [
        ["--adopt", INTENT],
        ["--payment", INTENT, "--adopt", "3f0c6a2e-1111-4222-8333-444455556666"],
        ["--payment", "3f0c6a2e-1111-4222-8333-444455556666"],
        ["--payment", "3f0c6a2e-1111-4222-8333-444455556666", "--adopt", INTENT, "--allow-new"],
        ["--payment", "3f0c6a2e-1111-4222-8333-444455556666", "--allow-new", INTENT],
    ],
)
async def test_flags_need_one_payment_and_one_action(
    argv: list[str],
    settings: Settings,
    db_session: AsyncSession,
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        await run(argv, sessions_of(db_session), settings, None, Terminal().io)

    assert exit_info.value.code == 2
    assert INTENT not in capsys.readouterr().err
