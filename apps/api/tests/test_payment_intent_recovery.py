"""A PaymentIntent create whose answer was lost (#58, Gatekeeper round 1 B1), and a quote accepted
again after its payment was canceled (B4). Never calls Stripe: the payments tests' fake stands
in, and clearing its `intents_by_key` is Stripe forgetting the idempotency keys (it keeps them
at least 24 hours) while the intents stay."""

import dataclasses
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import PaymentIntentFacts
from app.modules.payments.models import Payment, PaymentStatus
from app.modules.payments.service import PaymentService
from app.modules.payouts.errors import PaymentsUnavailableError
from tests.test_opportunities_api import World
from tests.test_payments_api import (
    CONFIG,
    PROVIDER_ERROR,
    RECONCILE_AFTER,
    UNAVAILABLE,
    FakeStripePayments,
    accepted_request,
    events,
    extra_of,
    pay,
    payments_of,
    rendered,
    settings,
    stripe_fake,
    take_rate,
    world,
)
from tests.test_payments_concurrency import Committed, committed

__all__ = ["committed", "settings", "stripe_fake", "take_rate", "world"]  # fixtures, by name

NEEDS_REVIEW = {
    "error": {
        "code": "payment_needs_review",
        "message": "This payment needs a review by our support team.",
    }
}


async def lost_create(
    client: httpx.AsyncClient, session: AsyncSession, world: World, stripe: FakeStripePayments
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """A payment whose PaymentIntent Stripe made but whose answer was lost: (request id, quote
    id, payment id; ids, as a rollback expires the row). The row holds no intent, and the
    create's time."""
    request_id, quote_id, _ = await accepted_request(session, world)
    stripe.lost_answers = 1
    lost = await pay(client, world, request_id, quote_id)
    assert (lost.status_code, lost.json()) == (503, UNAVAILABLE)
    [payment] = await payments_of(session, quote_id)
    assert payment.stripe_payment_intent_id is None
    assert payment.payment_intent_requested_at is not None
    assert len(stripe.intents) == 1
    return request_id, quote_id, payment.id


async def age(session: AsyncSession, payment_id: uuid.UUID, by: timedelta) -> datetime:
    """Moves the create's time `by` into the past; returns it."""
    when = datetime.now(UTC) - by
    await session.execute(
        update(Payment).where(Payment.id == payment_id).values(payment_intent_requested_at=when)
    )
    return when


async def row(session: AsyncSession, payment_id: uuid.UUID) -> Payment:
    payment = await session.scalar(
        select(Payment).where(Payment.id == payment_id).execution_options(populate_existing=True)
    )
    assert payment is not None
    return payment


# Within the window: Stripe still holds the key


async def test_retry_within_the_window_sends_the_same_key_and_searches_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    stamped = await age(db_session, payment_id, RECONCILE_AFTER - timedelta(minutes=5))

    retried = await pay(db_client, world, request_id, quote_id)

    assert retried.status_code == 200, retried.text
    first, second = stripe_fake.intent_calls
    assert first["idempotency_key"] == second["idempotency_key"] == f"payment_intent:{payment_id}"
    assert stripe_fake.searches == []
    [intent_id] = stripe_fake.intents
    stored = await row(db_session, payment_id)
    assert stored.stripe_payment_intent_id == intent_id
    # The first attempt's time: a retry never moves it.
    assert stored.payment_intent_requested_at == stamped


# Past the window: Stripe may have forgotten the key


async def test_retry_after_the_window_adopts_the_lost_intent(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The Gatekeeper's probe: the key forgotten, the retry finds the one intent by its metadata
    and stores it; no second create, the same sheet; later calls retrieve it."""
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))
    stripe_fake.intents_by_key.clear()
    [intent_id] = stripe_fake.intents

    with caplog.at_level(logging.INFO):
        retried = await pay(db_client, world, request_id, quote_id)
        again = await pay(db_client, world, request_id, quote_id)

    assert (retried.status_code, again.status_code) == (200, 200), retried.text
    secret = stripe_fake.intents[intent_id].client_secret
    assert retried.json()["payment_intent_client_secret"] == secret
    assert again.json()["payment_intent_client_secret"] == secret
    assert len(stripe_fake.intents) == len(stripe_fake.intent_calls) == 1
    assert stripe_fake.searches == [payment_id]
    assert stripe_fake.retrieved == [intent_id, intent_id]
    assert (await row(db_session, payment_id)).stripe_payment_intent_id == intent_id
    [adopted] = events(caplog, "payment_intent_adopted")
    assert adopted.levelno == logging.WARNING
    assert extra_of(adopted)["payment_id"] == str(payment_id)
    assert "pi_" not in rendered(caplog)


async def test_no_intent_found_is_409_creates_nothing_and_keeps_the_time(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A create that failed before Stripe made anything, past the window: the search finds
    nothing, and an empty search never authorizes a create (it may lag, and a delayed create
    may still land). Every retry is a 409 until staff resolve it."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    stripe_fake.errors["create_payment_intent"] = StripeUnavailableError(request_id="req_x")
    assert (await pay(db_client, world, request_id, quote_id)).status_code == 503
    del stripe_fake.errors["create_payment_intent"]
    [payment] = await payments_of(db_session, quote_id)
    payment_id = payment.id
    stamped = await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))

    with caplog.at_level(logging.INFO):
        first = await pay(db_client, world, request_id, quote_id)
        second = await pay(db_client, world, request_id, quote_id)

    assert (first.status_code, first.json()) == (409, NEEDS_REVIEW)
    assert (second.status_code, second.json()) == (409, NEEDS_REVIEW)
    assert stripe_fake.intent_calls == []
    assert stripe_fake.intents == {}
    assert stripe_fake.searches == [payment_id, payment_id]
    assert stripe_fake.ephemeral_keys == []
    stored = await row(db_session, payment_id)
    assert (stored.stripe_payment_intent_id, stored.payment_intent_requested_at) == (None, stamped)
    logged = events(caplog, "payment_intent_ambiguous")
    assert len(logged) == 2
    assert logged[0].levelno == logging.ERROR
    assert {k: extra_of(logged[0])[k] for k in ("payment_id", "count", "search_complete")} == {
        "payment_id": str(payment_id),
        "count": 0,
        "search_complete": True,
    }


async def test_two_intents_found_is_409(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    [original] = stripe_fake.facts.values()
    stripe_fake.add_intent(dataclasses.replace(original, payment_intent_id="pi_fake_twin"))
    await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))
    stripe_fake.intents_by_key.clear()

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, NEEDS_REVIEW)
    assert len(stripe_fake.intent_calls) == 1
    assert (await row(db_session, payment_id)).stripe_payment_intent_id is None
    [logged] = events(caplog, "payment_intent_ambiguous")
    assert extra_of(logged)["count"] == 2


@pytest.mark.parametrize(
    "mismatch",
    [
        lambda f: dataclasses.replace(f, amount_cents=f.amount_cents - 1),
        lambda f: dataclasses.replace(f, currency="eur"),
        lambda f: dataclasses.replace(f, customer_id="cus_fake_someone_else"),
        lambda f: dataclasses.replace(f, customer_id=None),
    ],
    ids=["amount", "currency", "customer", "no_customer"],
)
async def test_one_intent_that_is_not_the_payments_is_409(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
    mismatch: Callable[[PaymentIntentFacts], PaymentIntentFacts],
) -> None:
    """One match whose amount, currency or customer differs from the row's counts as
    ambiguous: nothing is adopted."""
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    [(intent_id, facts)] = stripe_fake.facts.items()
    stripe_fake.facts[intent_id] = mismatch(facts)
    await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))
    stripe_fake.intents_by_key.clear()

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, NEEDS_REVIEW)
    assert len(stripe_fake.intent_calls) == 1
    assert (await row(db_session, payment_id)).stripe_payment_intent_id is None
    [logged] = events(caplog, "payment_intent_ambiguous")
    assert extra_of(logged)["count"] == 1


async def test_an_intent_another_payment_holds_is_409(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The one match is already stored on another payment (unique stripe_payment_intent_id):
    not adopted, a 409 for staff, never a 500."""
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    [intent_id] = stripe_fake.intents
    other_request, other_quote, _ = await accepted_request(db_session, world)
    assert (await pay(db_client, world, other_request, other_quote)).status_code == 200
    [other] = await payments_of(db_session, other_quote)
    await db_session.execute(
        update(Payment).where(Payment.id == other.id).values(stripe_payment_intent_id=intent_id)
    )
    await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))
    stripe_fake.intents_by_key.clear()

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, NEEDS_REVIEW)
    assert (await row(db_session, payment_id)).stripe_payment_intent_id is None
    [logged] = events(caplog, "payment_intent_ambiguous")
    assert extra_of(logged)["count"] == 1


async def test_an_incomplete_search_is_409(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))
    stripe_fake.intents_by_key.clear()
    stripe_fake.search_complete = False

    with caplog.at_level(logging.INFO):
        response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (409, NEEDS_REVIEW)
    assert (await row(db_session, payment_id)).stripe_payment_intent_id is None
    [logged] = events(caplog, "payment_intent_ambiguous")
    assert extra_of(logged)["search_complete"] is False


@pytest.mark.parametrize(
    ("error", "status", "body"),
    [
        (StripeUnavailableError(request_id="req_s", code="rate_limit"), 503, UNAVAILABLE),
        (StripeRejectedError(request_id="req_s", code="invalid_request"), 502, PROVIDER_ERROR),
    ],
    ids=["unavailable", "rejected"],
)
async def test_a_failed_search_creates_nothing_and_keeps_the_time(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
    error: Exception,
    status: int,
    body: dict[str, object],
) -> None:
    request_id, quote_id, payment_id = await lost_create(db_client, db_session, world, stripe_fake)
    stamped = await age(db_session, payment_id, RECONCILE_AFTER + timedelta(minutes=5))
    stripe_fake.intents_by_key.clear()
    stripe_fake.errors["search_payment_intents"] = error

    response = await pay(db_client, world, request_id, quote_id)

    assert (response.status_code, response.json()) == (status, body)
    assert len(stripe_fake.intent_calls) == 1
    stored = await row(db_session, payment_id)
    assert (stored.stripe_payment_intent_id, stored.payment_intent_requested_at) == (None, stamped)


# Committed sessions: the Gatekeeper's probe as it ran


async def test_lost_answer_after_key_pruning_adopts_the_first_intent(committed: Committed) -> None:
    """Real commits: the create's time is committed before Stripe answers (read from another
    session inside the call), the answer is lost, the payment ages two days, Stripe forgets the
    key; the retry adopts the first intent instead of creating a second."""
    stripe = FakeStripePayments(lost_answers=1)
    seen: list[datetime | None] = []

    async def read_stamp() -> None:
        async with committed.sessions() as other:
            seen.append(
                await other.scalar(
                    select(Payment.payment_intent_requested_at).where(
                        Payment.quote_id == committed.quote_id
                    )
                )
            )

    stripe.on_create_intent = read_stamp
    async with committed.sessions() as session:
        with pytest.raises(PaymentsUnavailableError):
            await PaymentService(session, stripe, CONFIG).payment_sheet(
                committed.customer, committed.request_id, committed.quote_id
            )
    [stamp] = seen
    assert stamp is not None
    stripe.on_create_intent = None
    async with committed.sessions() as session:
        payment = await session.scalar(
            select(Payment).where(Payment.quote_id == committed.quote_id)
        )
        assert payment is not None
        assert payment.stripe_payment_intent_id is None
        await age(session, payment.id, timedelta(days=2))
        await session.commit()
    stripe.intents_by_key.clear()

    async with committed.sessions() as session:
        result = await PaymentService(session, stripe, CONFIG).payment_sheet(
            committed.customer, committed.request_id, committed.quote_id
        )

    [intent_id] = stripe.intents
    assert len(stripe.intent_calls) == 1
    assert result.payment_intent_client_secret == stripe.intents[intent_id].client_secret
    async with committed.sessions() as session:
        stored = await session.scalar(
            select(Payment.stripe_payment_intent_id).where(Payment.quote_id == committed.quote_id)
        )
    assert stored == intent_id


# B4: one payment per acceptance


async def test_a_quote_accepted_again_after_a_cancel_gets_a_new_payment(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stripe_fake: FakeStripePayments,
) -> None:
    """The first payment's PaymentIntent was canceled (#61 cancels the row and reopens the
    quote; here the row is canceled and the quote stands accepted again): the next call makes a
    new payment, with its own id, key, create time and PaymentIntent; the canceled one stays as
    it was. Later calls return the new one."""
    request_id, quote_id, _ = await accepted_request(db_session, world)
    first = await pay(db_client, world, request_id, quote_id)
    [old] = await payments_of(db_session, quote_id)
    await db_session.execute(
        update(Payment).where(Payment.id == old.id).values(status=PaymentStatus.CANCELED)
    )

    second = await pay(db_client, world, request_id, quote_id)
    third = await pay(db_client, world, request_id, quote_id)

    assert (first.status_code, second.status_code, third.status_code) == (200, 200, 200)
    rows = {p.id: p for p in await payments_of(db_session, quote_id)}
    assert len(rows) == 2
    [new_id] = set(rows) - {old.id}
    canceled, new = rows[old.id], rows[new_id]
    assert (canceled.status, canceled.stripe_payment_intent_id) == (
        PaymentStatus.CANCELED,
        old.stripe_payment_intent_id,
    )
    assert new.status is PaymentStatus.REQUIRES_PAYMENT
    assert new.payment_intent_requested_at is not None
    assert new.stripe_payment_intent_id not in (None, old.stripe_payment_intent_id)
    assert (new.amount_cents, new.customer_total_cents) == (old.amount_cents, old.amount_cents)
    old_call, new_call = stripe_fake.intent_calls
    assert old_call["idempotency_key"] == f"payment_intent:{old.id}"
    assert new_call["idempotency_key"] == f"payment_intent:{new.id}"
    assert new_call["metadata"] == {
        "payment_id": str(new.id),
        "quote_id": str(quote_id),
        "request_id": str(request_id),
    }
    secrets = [r.json()["payment_intent_client_secret"] for r in (first, second, third)]
    assert secrets[0] != secrets[1] == secrets[2]
