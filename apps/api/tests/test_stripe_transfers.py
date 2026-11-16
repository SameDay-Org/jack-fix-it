"""The Stripe transfers wrapper (#68) on the real SDK, over a recording HTTP client: what each call
sends (the idempotency key above all), how answers and errors come back, and that a refused
transfer reaches neither the logs nor Sentry with an id, an amount or Stripe's message."""

import json
import logging
import uuid
from typing import Any

import pytest
import sentry_sdk
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_transfers import TRANSFER_LIST_LIMIT, StripeTransfersClient
from app.modules.payments.models import Payment
from app.modules.payments.transfers import ReleaseOutcome, TransferService
from app.modules.pros.models import ProProfile
from app.observability import configure_logging, init_sentry
from tests.conftest import make_settings
from tests.job_world import PAYOUT, build_world
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport
from tests.test_stripe_connect import (
    FAKE_KEY,
    NETWORK_ERROR,
    REQUEST_ID,
    Answer,
    RecordingHTTPClient,
)
from tests.test_transfers import CONFIG, Clock, confirmed_job

__all__ = ["sentry_transport"]

# Fixture values only: ids that name nothing real.
ACCOUNT = "acct_fixture68dest"
CHARGE = "ch_fixture68charge"
INTENT = "pi_fixture68intent"
TRANSFER = "tr_fixture68transfer"
JOB_ID = "3c4d5e6f-dddd-4eee-8fff-000111222333"
GROUP = "request:4d5e6f70-eeee-4fff-8000-111222333444"
KEY = f"transfer:{JOB_ID}"


def client(*answers: Answer) -> tuple[StripeTransfersClient, RecordingHTTPClient]:
    http = RecordingHTTPClient(*answers)
    wrapper = StripeTransfersClient(
        secret_key=FAKE_KEY, timeout_seconds=5.0, max_network_retries=0, http_client=http
    )
    return wrapper, http


def transfer_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": TRANSFER,
        "object": "transfer",
        "amount": PAYOUT,
        "amount_reversed": 0,
        "currency": "usd",
        "destination": ACCOUNT,
        "metadata": {"job_id": JOB_ID},
        "reversed": False,
        "transfer_group": GROUP,
    }
    body.update(overrides)
    return body


def refusal(code: str) -> dict[str, Any]:
    message = f"Insufficient funds for {ACCOUNT} from {CHARGE} ({PAYOUT})"
    return {"error": {"type": "invalid_request_error", "code": code, "message": message}}


async def create(wrapper: StripeTransfersClient, source: str | None = CHARGE) -> Any:
    return await wrapper.create_transfer(
        amount_cents=PAYOUT,
        currency="usd",
        destination=ACCOUNT,
        transfer_group=GROUP,
        source_transaction=source,
        metadata={"job_id": JOB_ID},
        idempotency_key=KEY,
    )


@pytest.fixture(autouse=True)
def app_logging() -> None:
    configure_logging("DEBUG")


async def test_create_sends_the_transfer_with_its_idempotency_key() -> None:
    wrapper, http = client((200, transfer_body()))

    made = await create(wrapper)

    assert (made.transfer_id, made.amount_cents, made.destination, made.job_id) == (
        TRANSFER,
        PAYOUT,
        ACCOUNT,
        JOB_ID,
    )
    assert (made.reversed, made.request_id) == (False, REQUEST_ID)
    [(method, url, headers, form)] = http.sent
    assert (method, url) == ("post", "https://api.stripe.com/v1/transfers")
    assert headers["Idempotency-Key"] == KEY
    assert form == {
        "amount": [str(PAYOUT)],
        "currency": ["usd"],
        "destination": [ACCOUNT],
        "transfer_group": [GROUP],
        "source_transaction": [CHARGE],
        "metadata[job_id]": [JOB_ID],
    }


async def test_create_without_a_charge_sends_no_source() -> None:
    wrapper, http = client((200, transfer_body()))

    await create(wrapper, source=None)

    [(_, _, _, form)] = http.sent
    assert "source_transaction" not in form


@pytest.mark.parametrize(
    ("overrides", "reversed_"),
    [({"reversed": True, "amount_reversed": PAYOUT}, True), ({"amount_reversed": 1}, True)],
    ids=["full", "partial"],
)
async def test_a_reversal_reads_as_reversed(overrides: dict[str, Any], reversed_: bool) -> None:
    wrapper, _ = client((200, transfer_body(**overrides)))

    assert (await create(wrapper)).reversed is reversed_


async def test_list_reads_the_group_one_page() -> None:
    other = transfer_body(id="tr_fixture68other", metadata={}, destination={"id": ACCOUNT})
    wrapper, http = client(
        (200, {"object": "list", "data": [transfer_body(), other], "has_more": True})
    )

    found = await wrapper.list_transfers(GROUP)

    assert not found.complete
    assert [(t.transfer_id, t.job_id, t.destination) for t in found.transfers] == [
        (TRANSFER, JOB_ID, ACCOUNT),
        ("tr_fixture68other", None, ACCOUNT),
    ]
    [(method, url, _, _)] = http.sent
    assert method == "get"
    assert url.startswith("https://api.stripe.com/v1/transfers?")
    assert f"transfer_group={GROUP.replace(':', '%3A')}" in url
    assert f"limit={TRANSFER_LIST_LIMIT}" in url


@pytest.mark.parametrize(
    ("charge", "expected"),
    [(CHARGE, CHARGE), ({"id": CHARGE, "object": "charge"}, CHARGE), (None, None)],
    ids=["id", "expanded", "none"],
)
async def test_the_charge_of_a_payment_intent(charge: object, expected: str | None) -> None:
    body = {"id": INTENT, "object": "payment_intent", "latest_charge": charge}
    wrapper, http = client((200, body))

    assert await wrapper.charge_of_payment_intent(INTENT) == expected
    [(method, url, _, _)] = http.sent
    assert (method, url) == ("get", f"https://api.stripe.com/v1/payment_intents/{INTENT}")


@pytest.mark.parametrize(
    ("answer", "error"),
    [
        ((400, refusal("insufficient_funds")), StripeRejectedError),
        ((409, refusal("idempotency_key_in_use")), StripeUnavailableError),
        ((500, refusal("api_error")), StripeUnavailableError),
        (NETWORK_ERROR, StripeUnavailableError),
    ],
    ids=["refused", "in_flight", "server", "network"],
)
async def test_errors_carry_the_code_never_the_text(
    answer: Answer, error: type[Exception], caplog: pytest.LogCaptureFixture
) -> None:
    wrapper, _ = client(answer)

    with pytest.raises(error) as raised:
        await create(wrapper)

    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__
    for leak in (ACCOUNT, CHARGE, str(PAYOUT)):
        assert leak not in str(raised.value)
        assert leak not in caplog.text


async def test_a_refused_release_reaches_sentry_without_ids_or_amounts(
    db_session: AsyncSession,
    sentry_transport: MemoryTransport,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The real wrapper, a refused create: the error log becomes a Sentry event with ids and
    Stripe's code only; no account, charge, PaymentIntent or transfer id, no amount and no text
    of Stripe's message reaches it or the logs."""
    world = await build_world(db_session)
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == world.pro.profile_id)
        .values(stripe_account_id=ACCOUNT, payouts_enabled=True)
    )
    job = await confirmed_job(db_session, world, stripe_payment_intent_id=INTENT)
    payment = await db_session.scalar(
        update(Payment).where(Payment.quote_id == job.quote_id).values().returning(Payment.id)
    )
    wrapper, http = client(
        (200, {"id": INTENT, "object": "payment_intent", "latest_charge": CHARGE}),
        (400, refusal("insufficient_funds")),
    )
    init_sentry(make_settings(sentry_dsn=TEST_DSN))

    with caplog.at_level(logging.DEBUG):
        outcome = await TransferService(db_session, wrapper, CONFIG, Clock()).release(job.id)
    sentry_sdk.flush()

    assert outcome is ReleaseOutcome.FAILED
    assert len(http.sent) == 2
    payloads = _payloads(sentry_transport)
    events = [
        e
        for e in (json.loads(p) for p in payloads)
        if e.get("logentry", {}).get("message") == "transfer_stripe_rejected"
    ]
    assert events, "no event was captured"
    for event in events:
        assert event["extra"]["stripe_code"] == "insufficient_funds"
        assert event["extra"]["job_id"] == str(job.id)
        assert event["extra"]["payment_id"] == str(payment)
    leaks = (ACCOUNT, CHARGE, INTENT, TRANSFER, str(PAYOUT), "Insufficient funds")
    wire = "\n".join(payloads)
    rendered = caplog.text + "".join(str(r.__dict__) for r in caplog.records)
    for leak in leaks:
        assert leak not in wire, leak
        assert leak not in rendered, leak
    assert uuid.UUID(events[0]["extra"]["transfer_id"])
