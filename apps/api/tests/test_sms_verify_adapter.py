"""TwilioPhoneVerifier against httpx.MockTransport: never calls Twilio (#26)."""

import base64
import contextlib
import json
import logging
from collections.abc import Callable, Mapping
from urllib.parse import parse_qs

import httpx
import pytest

from app.integrations.sms_verify import (
    InvalidPhoneError,
    TwilioPhoneVerifier,
    VerificationUnavailableError,
)
from app.observability import JsonFormatter

ACCOUNT_SID = "ACtest00000000000000000000000000"
AUTH_TOKEN = "test-twilio-auth-token-not-real"
SERVICE_SID = "VAtest00000000000000000000000000"
PHONE = "+14075550123"
CODE = "123456"
SERVICE_URL = f"https://verify.twilio.com/v2/Services/{SERVICE_SID}"

Handler = Callable[[httpx.Request], httpx.Response]


def verifier(handler: Handler) -> TwilioPhoneVerifier:
    return TwilioPhoneVerifier(
        account_sid=ACCOUNT_SID,
        auth_token=AUTH_TOKEN,
        service_sid=SERVICE_SID,
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )


def respond(status: int, body: Mapping[str, object] | None = None) -> Handler:
    return lambda request: httpx.Response(status, json=dict(body or {}))


def form(request: httpx.Request) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(request.content.decode()).items()}


async def test_start_posts_to_verify_service_with_basic_auth() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json={"status": "pending"})

    await verifier(handler).start(PHONE)

    [request] = requests
    assert request.method == "POST"
    assert str(request.url) == f"{SERVICE_URL}/Verifications"
    assert form(request) == {"To": PHONE, "Channel": "sms"}
    expected = base64.b64encode(f"{ACCOUNT_SID}:{AUTH_TOKEN}".encode()).decode()
    assert request.headers["Authorization"] == f"Basic {expected}"


async def test_check_posts_code_to_verification_check() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "approved", "valid": True})

    assert await verifier(handler).check(PHONE, CODE) is True
    [request] = requests
    assert str(request.url) == f"{SERVICE_URL}/VerificationCheck"
    assert form(request) == {"To": PHONE, "Code": CODE}


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (200, {"status": "approved", "valid": True}, True),
        (200, {"status": "pending", "valid": False}, False),  # a wrong code
        (200, {"status": "canceled"}, False),
        (200, {}, False),
        # No pending verification: expired, already used or never sent.
        (404, {"code": 20404}, False),
        # Too many wrong codes: Twilio closed the verification.
        (429, {"code": 60202}, False),
    ],
    ids=["approved", "pending", "canceled", "no_status", "expired", "max_attempts"],
)
async def test_check_returns_true_only_on_approved(
    status: int, body: dict[str, object], expected: bool
) -> None:
    assert await verifier(respond(status, body)).check(PHONE, CODE) is expected


async def test_invalid_number_raises_invalid_phone() -> None:
    # Twilio's body echoes the number; it must never reach a log or an exception.
    body = {"code": 60200, "message": f"Invalid parameter `To`: {PHONE}", "status": 400}

    with pytest.raises(InvalidPhoneError) as start_error:
        await verifier(respond(400, body)).start(PHONE)
    with pytest.raises(InvalidPhoneError) as check_error:
        await verifier(respond(400, body)).check(PHONE, CODE)

    for error in (start_error, check_error):
        assert PHONE not in str(error.value)
        assert error.value.__cause__ is None


def timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectTimeout("timed out", request=request)


def refused(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


@pytest.mark.parametrize(
    "handler",
    [
        timeout,
        refused,
        respond(500),
        respond(503),
        respond(401, {"code": 20003}),  # wrong credentials
        respond(403),
    ],
    ids=["timeout", "refused", "500", "503", "401", "403"],
)
async def test_timeout_and_5xx_raise_unavailable(handler: Handler) -> None:
    client = verifier(handler)

    with pytest.raises(VerificationUnavailableError):
        await client.start(PHONE)
    with pytest.raises(VerificationUnavailableError):
        await client.check(PHONE, CODE)


async def test_check_with_an_unreadable_body_is_unavailable() -> None:
    # start ignores the body of a 2xx; check needs it to know the verification's status.
    client = verifier(lambda request: httpx.Response(200, content=b"not json"))

    with pytest.raises(VerificationUnavailableError):
        await client.check(PHONE, CODE)


async def test_start_404_is_unavailable_not_a_bad_code() -> None:
    # On start, a 404 means a wrong service SID: a configuration problem.
    with pytest.raises(VerificationUnavailableError):
        await verifier(respond(404, {"code": 20404})).start(PHONE)


async def test_timeout_comes_from_settings() -> None:
    seen: list[dict[str, float | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.extensions["timeout"])
        return httpx.Response(201, json={})

    client = TwilioPhoneVerifier(
        account_sid=ACCOUNT_SID,
        auth_token=AUTH_TOKEN,
        service_sid=SERVICE_SID,
        timeout_seconds=1.5,
        transport=httpx.MockTransport(handler),
    )
    await client.start(PHONE)

    assert seen == [{"connect": 1.5, "read": 1.5, "write": 1.5, "pool": 1.5}]


async def test_adapter_logs_no_number_or_code(caplog: pytest.LogCaptureFixture) -> None:
    echo = {"message": f"To {PHONE}, code {CODE}"}
    handlers: list[Handler] = [
        respond(201, echo),
        respond(200, {"status": "approved", **echo}),
        respond(400, echo),
        respond(500, echo),
        timeout,
        lambda request: httpx.Response(200, content=f"{PHONE} {CODE}".encode()),
    ]

    with caplog.at_level(logging.DEBUG):
        for handler in handlers:
            client = verifier(handler)
            for call in (client.start(PHONE), client.check(PHONE, CODE)):
                with contextlib.suppress(InvalidPhoneError, VerificationUnavailableError):
                    await call

    assert any(r.message.startswith("twilio_verify_") for r in caplog.records)
    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records)
    for secret in (PHONE, PHONE.lstrip("+"), CODE, AUTH_TOKEN):
        assert secret not in output
    for record in caplog.records:
        if record.message.startswith("twilio_verify_"):
            extras = set(json.loads(formatter.format(record)))
            assert extras <= {
                "timestamp",
                "level",
                "logger",
                "message",
                "request_id",
                "operation",
                "status_code",
                "error",
            }
