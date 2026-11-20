"""The receipt emails (#62, PR C): the worker's send_payment_receipt and send_tip_receipt, their
queueing from the payment and tip webhooks, and the copy's legal guard.

On the rolled-back test session, which the tasks' session factory hands out (their commits
only release a savepoint), with the payment calls' Stripe fake and a recording email sender.
"""

import logging
import re
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import fields
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import pytest
from arq import Retry
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.email_layout import EmailContent, SenderIdentity
from app.integrations.email import EmailUnavailableError
from app.integrations.stripe_errors import StripeUnavailableError
from app.integrations.stripe_payments import CardFacts, TipIntentFacts
from app.modules.jobs.models import Job, JobStatus
from app.modules.payments.models import Payment
from app.modules.payments.reconciliation import JobBooked
from app.modules.payments.webhook_handlers import announce
from app.modules.receipts.email_copy import (
    COPY,
    ReceiptEmailFacts,
    money,
    payment_method,
    payment_receipt_email,
    tip_receipt_email,
)
from app.modules.receipts.tasks import send_payment_receipt, send_tip_receipt
from app.modules.tips.models import Tip, TipChoice, TipStatus
from app.modules.tips.webhooks import tip_event_handler
from app.modules.users.models import User
from app.modules.webhooks.events import AfterCommit
from tests.conftest import make_settings
from tests.job_world import FEE, LINE1, LINE2, PAYOUT, PRICE, TAX, JobWorld, build_world, make_job
from tests.test_password_reset_api import FakeSender
from tests.test_payment_webhooks import RecordingQueue
from tests.test_payments_api import FakeStripePayments
from tests.test_tip_webhooks import event as tip_event_of
from tests.test_transfers import add_payment

MAX_TRIES: Final = 3
VISA: Final = CardFacts(brand="visa", last4="4242", wallet=None)
TIP: Final = 1_250
CUSTOMER: Final = "cus_r62receipts"


def stripe_holds_tip(stripe: FakeStripePayments, tip: Tip, intent: str) -> None:
    """Stripe holds the tip's intent, succeeded: what the tip handler reads (#510 round 1)."""
    stripe.add_tip_intent(
        TipIntentFacts(
            payment_intent_id=intent,
            amount_cents=TIP,
            currency="usd",
            customer_id=CUSTOMER,
            status="succeeded",
            failed=False,
            kind="tip",
            tip_id=str(tip.id),
            job_id=str(tip.job_id),
            attempt=str(tip.attempt),
        )
    )
    stripe.tip_statuses[intent] = "succeeded"


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        receipt_email_max_attempts=MAX_TRIES,
        receipt_legal_name="Fixture Legal Name LLC",
        receipt_support_email="support@fixture.invalid",
        receipt_mailing_address="1 Fixture Way, Orlando FL",
        business_time_zone="America/New_York",
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def context(
    session: AsyncSession,
    settings: Settings,
    stripe: FakeStripePayments | None,
    sender: FakeSender | None,
    job_try: int = 1,
) -> dict[str, Any]:
    @asynccontextmanager
    async def sessions() -> AsyncIterator[AsyncSession]:
        yield session

    return {
        "session_factory": sessions,
        "settings": settings,
        "stripe_payments": stripe,
        "email_sender": sender,
        "job_try": job_try,
    }


async def booked(session: AsyncSession, world: JobWorld, **payment: Any) -> tuple[Job, Payment]:
    job = await make_job(session, world, JobStatus.SCHEDULED)
    return job, await add_payment(session, world, job, **payment)


async def payment_row(session: AsyncSession, payment_id: uuid.UUID) -> Payment:
    statement = (
        select(Payment).where(Payment.id == payment_id).execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


def stripe_with(payment: Payment, card: CardFacts | None = VISA) -> FakeStripePayments:
    stripe = FakeStripePayments()
    if card is not None and payment.stripe_payment_intent_id is not None:
        stripe.cards[payment.stripe_payment_intent_id] = card
    return stripe


# --- The payment's receipt ----------------------------------------------------------------


async def test_the_payment_receipt_is_sent_once_with_the_card_read_from_stripe(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    _job, payment = await booked(db_session, world)
    stripe, sender = stripe_with(payment), FakeSender()

    await send_payment_receipt(context(db_session, settings, stripe, sender), str(payment.id))
    await send_payment_receipt(context(db_session, settings, stripe, sender), str(payment.id))

    [email] = sender.sent
    assert sender.keys == [f"payment-receipt:{payment.id}"]
    row = await payment_row(db_session, payment.id)
    assert (row.card_brand, row.card_last4, row.wallet) == ("visa", "4242", None)
    assert row.receipt_emailed_at is not None
    # The second run read nothing: the email was already accepted.
    assert len(stripe.card_reads) == 1
    address = await db_session.scalar(select(User.email).where(User.id == world.customer.id))
    assert email.to == address
    assert email.subject.startswith("Your Jack Fix It receipt · JF-")
    for part in (email.text, email.html):
        assert "Hi Ana," in part
        assert "Service: Plumbing" in part
        assert "Pro: María P." in part
        assert "City: Orlando" in part
        assert f"Service: {money(PRICE)}" in part
        assert f"Tax: {money(TAX)}" in part
        assert f"Total paid: {money(PRICE + TAX)}" in part
        assert "Visa •••• 4242" in part
        assert "Questions? Write to support@fixture.invalid or open Help in the app." in part
        assert "Fixture Legal Name LLC · 1 Fixture Way, Orlando FL" in part
        # Never the street, the fee, the payout or a Stripe id.
        for leak in (LINE1, LINE2, money(FEE), money(PAYOUT), "pi_probe68"):
            assert leak not in part, leak
    # The scheduled start (2030-01-15 14:30 UTC) in New York: 9:30 AM.
    assert "Scheduled: Jan 15, 2030, 9:30 AM" in email.text


async def test_the_receipt_is_in_the_customer_s_language(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    _, payment = await booked(db_session, world)
    await db_session.execute(update(User).where(User.id == world.customer.id).values(locale="es"))
    sender = FakeSender()

    await send_payment_receipt(
        context(db_session, settings, stripe_with(payment), sender), str(payment.id)
    )

    [email] = sender.sent
    assert email.subject.startswith("Tu recibo de Jack Fix It · JF-")
    assert "Hola, Ana:" in email.text
    assert "Servicio: Plomería" in email.text
    assert f"Total pagado: {money(PRICE + TAX)}" in email.text
    assert "Pagado con Visa •••• 4242" in email.text
    assert "Programado: 15 ene 2030, 09:30" in email.text


async def test_a_stored_card_is_never_read_again_nor_replaced(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    _, payment = await booked(db_session, world, card_brand="mastercard", card_last4="5555")
    stripe, sender = stripe_with(payment), FakeSender()

    await send_payment_receipt(context(db_session, settings, stripe, sender), str(payment.id))

    assert stripe.card_reads == []
    row = await payment_row(db_session, payment.id)
    assert (row.card_brand, row.card_last4) == ("mastercard", "5555")
    assert "Mastercard •••• 5555" in sender.sent[0].text


async def test_stripe_unavailable_retries_then_sends_without_the_card(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    _, payment = await booked(db_session, world)
    stripe = stripe_with(payment)
    stripe.errors["card_of"] = StripeUnavailableError(request_id="req_down")
    sender = FakeSender()

    with pytest.raises(Retry):
        await send_payment_receipt(context(db_session, settings, stripe, sender), str(payment.id))
    assert sender.sent == []
    await send_payment_receipt(
        context(db_session, settings, stripe, sender, job_try=MAX_TRIES), str(payment.id)
    )

    [email] = sender.sent
    assert "Paid with Card" in email.text
    row = await payment_row(db_session, payment.id)
    assert (row.card_brand, row.receipt_emailed_at is not None) == (None, True)


async def test_the_email_provider_unavailable_retries_then_gives_up_for_staff(
    db_session: AsyncSession, world: JobWorld, settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    _, payment = await booked(db_session, world)
    sender = FakeSender(error=EmailUnavailableError())

    with pytest.raises(Retry):
        await send_payment_receipt(
            context(db_session, settings, stripe_with(payment), sender), str(payment.id)
        )
    with caplog.at_level(logging.INFO):
        await send_payment_receipt(
            context(db_session, settings, stripe_with(payment), sender, job_try=MAX_TRIES),
            str(payment.id),
        )

    assert (await payment_row(db_session, payment.id)).receipt_emailed_at is None
    [error] = [r for r in caplog.records if r.getMessage() == "receipt_email_not_sent"]
    assert error.levelno == logging.ERROR
    assert error.__dict__["payment_id"] == str(payment.id)


async def test_without_email_configured_nothing_is_sent_but_the_card_is_kept(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    _, payment = await booked(db_session, world)

    await send_payment_receipt(
        context(db_session, settings, stripe_with(payment), None), str(payment.id)
    )

    row = await payment_row(db_session, payment.id)
    assert (row.card_brand, row.receipt_emailed_at) == ("visa", None)


async def test_a_payment_that_did_not_succeed_gets_no_email(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    _, payment = await booked(db_session, world, status="requires_payment")
    sender = FakeSender()

    await send_payment_receipt(
        context(db_session, settings, stripe_with(payment), sender), str(payment.id)
    )

    assert sender.sent == []


# --- The tip's receipt --------------------------------------------------------------------


async def add_tip(session: AsyncSession, world: JobWorld, job: Job) -> Tip:
    tip = Tip(
        job_id=job.id,
        request_id=job.request_id,
        customer_id=world.customer.id,
        pro_id=world.pro.profile_id,
        choice=TipChoice.CUSTOM,
        amount_cents=TIP,
        currency="usd",
        status=TipStatus.SUCCEEDED,
        succeeded_at=datetime.now(UTC),
        stripe_payment_intent_id=f"pi_r62tip{uuid.uuid4().hex[:8]}",
        attempt=1,
    )
    session.add(tip)
    await session.flush()
    return tip


async def test_the_tip_receipt_is_sent_once_with_its_own_card(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    at = datetime.now(UTC) - timedelta(hours=1)
    job = await make_job(db_session, world, JobStatus.CONFIRMED, completed_at=at, confirmed_at=at)
    await add_payment(db_session, world, job)
    tip = await add_tip(db_session, world, job)
    stripe, sender = FakeStripePayments(), FakeSender()
    assert tip.stripe_payment_intent_id is not None
    stripe.cards[tip.stripe_payment_intent_id] = CardFacts("visa", "1881", "google_pay")

    await send_tip_receipt(context(db_session, settings, stripe, sender), str(tip.id))
    await send_tip_receipt(context(db_session, settings, stripe, sender), str(tip.id))

    [email] = sender.sent
    assert sender.keys == [f"tip-receipt:{tip.id}"]
    assert email.subject.startswith("Your Jack Fix It tip receipt · JF-")
    assert "Thank you for your tip for María P." in email.text
    assert f"Tip: {money(TIP)}" in email.text
    assert f"Total paid: {money(TIP)}" in email.text
    assert "Google Pay (Visa •••• 1881)" in email.text
    assert money(PRICE) not in email.text
    row = (
        await db_session.scalars(
            select(Tip).where(Tip.id == tip.id).execution_options(populate_existing=True)
        )
    ).one()
    assert (row.card_last4, row.receipt_emailed_at is not None) == ("1881", True)


# --- Queued once, from the webhooks -------------------------------------------------------


async def test_a_booking_queues_its_payment_s_receipt_once() -> None:
    queue = RecordingQueue()
    booked = JobBooked(
        job_id=uuid.uuid4(),
        request_id=uuid.uuid4(),
        customer_id=uuid.uuid4(),
        pro_user_id=uuid.uuid4(),
        public_code="JF-000124",
        payment_id=uuid.uuid4(),
    )

    await announce(booked, queue, 1.0)
    await announce(booked, queue, 1.0)  # the same job id: not queued again

    receipts = [job for job in queue.jobs.values() if job[0] == "send_payment_receipt"]
    assert receipts == [("send_payment_receipt", (str(booked.payment_id),))]


# --- The copy -----------------------------------------------------------------------------

# The app's legal guard (apps/mobile/src/i18n/legalCopy.test.ts), in Python's own syntax:
# [^\W\d_] is a letter, as \p{L} there.
_L: Final = r"[^\W\d_]"
FORBIDDEN: Final = {
    "en": re.compile(
        r"\b(held|hold(?:s|ing)?|escrow\w*|custod(?:y|ial)|guarantee\w*|warrant(?:y|ies)|"
        r"protect(?:ed|ion|s|ing)?|refund\w*|money back|pay safely|releas(?:e|ed|es|ing)|"
        r"insured|licensed)\b",
        re.IGNORECASE,
    ),
    "es": re.compile(
        rf"(?<!{_L})(reten{_L}*|retien{_L}*|retuv{_L}*|escrow{_L}*|fideicomis{_L}*|custodi{_L}*|"
        rf"garant{_L}*|proteg{_L}*|protecci[oó]n|reembols{_L}*|reintegr{_L}*|"
        rf"(?:devol|devuelv){_L}* (?:{_L}+ ){{0,2}}dinero|"
        r"paga(?:r|s)? (?:con seguridad|de (?:forma|manera) segura|seguro)|"
        rf"liber(?:a|á|ó|e|en|an|ad[oa]s?|ar{_L}*|amos|aci[oó]n)|asegurad[oa]s?|"
        rf"licenciad[oa]s?|con licencia)(?!{_L})",
        re.IGNORECASE,
    ),
}


@pytest.mark.parametrize("language", ["en", "es"])
def test_the_email_copy_promises_nothing_the_legal_rule_forbids(language: str) -> None:
    copy = COPY[language]
    strings = [
        value
        for field in fields(copy)
        for value in (
            getattr(copy, field.name)
            if isinstance(getattr(copy, field.name), tuple)
            else (getattr(copy, field.name),)
        )
    ]

    found = [(text, match) for text in strings for match in FORBIDDEN[language].findall(text)]

    assert found == []
    assert len(strings) > 20


@pytest.mark.parametrize(
    ("language", "text"),
    [
        ("en", "We refund it"),
        ("en", "Your payment is protected"),
        ("es", "Te devolvemos tu dinero"),
        ("es", "El pago está protegido"),
    ],
)
def test_the_guard_catches_what_it_should(language: str, text: str) -> None:
    assert FORBIDDEN[language].search(text) is not None


@pytest.mark.parametrize(
    ("card", "expected"),
    [
        (None, "Card"),
        (CardFacts(None, None, None), "Card"),
        (CardFacts("visa", "4242", None), "Visa •••• 4242"),
        (CardFacts("amex", "0005", "apple_pay"), "Apple Pay (American Express •••• 0005)"),
        (CardFacts("cartes_bancaires", None, None), "Cartes Bancaires"),
    ],
)
def test_the_card_is_named_as_people_say_it(card: CardFacts | None, expected: str) -> None:
    assert payment_method(card, "en") == expected


def test_money_is_written_in_dollars() -> None:
    assert [money(cents) for cents in (0, 5, 125_000, -5_000)] == [
        "$0.00",
        "$0.05",
        "$1,250.00",
        "-$50.00",
    ]


async def test_a_tip_that_succeeds_queues_its_receipt_once(
    db_session: AsyncSession, world: JobWorld
) -> None:
    at = datetime.now(UTC) - timedelta(hours=1)
    job = await make_job(db_session, world, JobStatus.CONFIRMED, completed_at=at, confirmed_at=at)
    await db_session.execute(
        update(User).where(User.id == world.customer.id).values(stripe_customer_id=CUSTOMER)
    )
    tip = await add_tip(db_session, world, job)
    await db_session.execute(
        update(Tip)
        .where(Tip.id == tip.id)
        .values(status=TipStatus.REQUIRES_PAYMENT, succeeded_at=None)
    )
    assert tip.stripe_payment_intent_id is not None
    queue, stripe = RecordingQueue(), FakeStripePayments()
    stripe_holds_tip(stripe, tip, tip.stripe_payment_intent_id)
    handler = tip_event_handler(lambda: stripe)

    for _ in range(2):  # Stripe sends the event again: nothing more is queued
        after = AfterCommit()
        event = tip_event_of("payment_intent.succeeded", intent=tip.stripe_payment_intent_id)
        await handler(db_session, event, after)
        for action in after.actions:
            await action(queue, 1.0)

    receipts = [job for job in queue.jobs.values() if job[0] == "send_tip_receipt"]
    assert receipts == [("send_tip_receipt", (str(tip.id),))]


HOSTILE = "<script>alert(\"x\")</script> & 'quoted'"
ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#x27;quoted&#x27;"


@pytest.mark.parametrize(
    ("build", "values"),
    # The name, category, pro, city and address; the tip's intro names the pro again.
    [(payment_receipt_email, 5), (tip_receipt_email, 6)],
    ids=["payment", "tip"],
)
def test_every_value_is_html_escaped_in_the_html_part(
    build: Callable[[ReceiptEmailFacts], EmailContent], values: int
) -> None:
    """#514 (the Vault, N1): a name, a pro, a category, a city or an address the customer or
    staff typed reaches the HTML part escaped, never as markup; the text part keeps it as
    typed."""
    facts = ReceiptEmailFacts(
        locale="en",
        first_name=f"Ana {HOSTILE}",
        code="K7Q29MXA",
        category=f"Plumbing {HOSTILE}",
        pro_name=f"Bea {HOSTILE}",
        scheduled="Nov 22, 2026, 2:30 PM",
        city=f"Orlando {HOSTILE}",
        lines=(("Service", 10_000),),
        total_cents=10_000,
        card=None,
        sender=SenderIdentity(
            legal_name="Fixture LLC",
            support_email="support@fixture.invalid",
            mailing_address=f"1 Main St {HOSTILE}",
        ),
    )

    email = build(facts)

    assert "<script" not in email.html
    assert ESCAPED in email.html
    assert email.html.count(ESCAPED) == values
    assert HOSTILE in email.text
