"""#450 round 4: which answers to a refund CREATE are definitive, on the real stripe-python SDK.

Each answer goes through the SDK's own error parsing (its error classes by HTTP status and
type) and our stripe_errors.raise_typed, as in production. Only a create refused with a code in
REFUND_REFUSED_CODES is definitive; an authentication, permission, validation, idempotency, rate
limit, Stripe-side or network failure never is: it says nothing about an earlier create."""

import uuid
from typing import Any

import pytest

from app.integrations.stripe_errors import StripeCallError
from app.integrations.stripe_refunds import StripeRefundsClient
from app.modules.payments.refunds import (
    REFUND_REFUSED_CODES,
    RefundAttempt,
    RefundCreateRejectedError,
    make_refund,
)
from tests.test_stripe_connect import FAKE_KEY, NETWORK_ERROR, Answer, RecordingHTTPClient

ATTEMPT = RefundAttempt(
    refund_id=uuid.uuid4(),
    dispute_id=uuid.uuid4(),
    job_id=uuid.uuid4(),
    payment_id=uuid.uuid4(),
    payment_intent_id="pi_fixture450",
    amount_cents=1_000,
    currency="usd",
    idempotency_key="dispute:fixture:refund",
    number=1,
    initiated_by=uuid.uuid4(),
)


def error(kind: str, code: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"type": kind, "message": "fixture message"}
    if code is not None:
        body["code"] = code
    return {"error": body}


NOT_EVALUATED: dict[str, Answer] = {
    "authentication_401": (401, error("invalid_request_error", "api_key_expired")),
    "permission_403": (403, error("invalid_request_error", "secret_key_required")),
    "validation_400": (400, error("invalid_request_error", "parameter_invalid_integer")),
    "idempotency_400": (400, error("idempotency_error")),
    "rate_limit_429": (429, error("invalid_request_error", "rate_limit")),
    "api_500": (500, error("api_error")),
    "connection": NETWORK_ERROR,
}


async def create_answering(answer: Answer) -> StripeCallError:
    http = RecordingHTTPClient(answer)
    client = StripeRefundsClient(
        secret_key=FAKE_KEY, timeout_seconds=5.0, max_network_retries=0, http_client=http
    )
    with pytest.raises(StripeCallError) as raised:
        await make_refund(client, ATTEMPT)
    assert http.sent, "the create reached the HTTP client"
    return raised.value


@pytest.mark.parametrize("answer", list(NOT_EVALUATED.values()), ids=list(NOT_EVALUATED))
async def test_a_create_refused_before_it_was_evaluated_is_never_definitive(
    answer: Answer,
) -> None:
    raised = await create_answering(answer)

    assert not (isinstance(raised, RefundCreateRejectedError) and raised.definitive)


@pytest.mark.parametrize("code", sorted(REFUND_REFUSED_CODES))
async def test_a_create_refused_with_a_refusal_code_is_definitive(code: str) -> None:
    raised = await create_answering((400, error("invalid_request_error", code)))

    assert isinstance(raised, RefundCreateRejectedError)
    assert raised.definitive
    assert raised.code == code
