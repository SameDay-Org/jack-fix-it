"""ResendEmailSender against httpx.MockTransport: never calls Resend (#27)."""

import json
import logging
from collections.abc import Callable

import httpx
import pytest

from app.integrations.email import RESEND_EMAILS_URL, EmailUnavailableError, ResendEmailSender
from app.observability import JsonFormatter
from tests.conftest import TEST_EMAIL_SETTINGS, make_settings

API_KEY = "re_test_key_not_real"
SENDER = "Jack Fix It <no-reply@example.invalid>"
TO = "ana.probe@example.com"
SUBJECT = "Probe subject 4821"
TEXT = "Probe text 482915"
HTML = "<p>Probe html 482915</p>"

Handler = Callable[[httpx.Request], httpx.Response]


def sender(handler: Handler) -> ResendEmailSender:
    return ResendEmailSender(
        api_key=API_KEY,
        sender=SENDER,
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )


async def send(handler: Handler) -> None:
    await sender(handler).send(TO, SUBJECT, TEXT, HTML)


async def test_posts_to_resend_with_bearer() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"})

    await send(handler)

    [request] = requests
    assert request.method == "POST"
    assert str(request.url) == RESEND_EMAILS_URL
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.headers["Content-Type"] == "application/json"
    assert json.loads(request.content) == {
        "from": SENDER,
        "to": [TO],
        "subject": SUBJECT,
        "text": TEXT,
        "html": HTML,
    }


def test_from_settings_requires_key_and_sender() -> None:
    assert isinstance(
        ResendEmailSender.from_settings(make_settings(**TEST_EMAIL_SETTINGS)), ResendEmailSender
    )
    for missing in ("resend_api_key", "email_from"):
        settings = make_settings(**{**TEST_EMAIL_SETTINGS, missing: None})
        with pytest.raises(RuntimeError, match="RESEND_API_KEY"):
            ResendEmailSender.from_settings(settings)


def raise_error(error: Exception) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    return handler


FAILURES: list[tuple[str, Handler]] = [
    ("timeout", raise_error(httpx.ReadTimeout("timed out"))),
    ("connect_error", raise_error(httpx.ConnectError("unreachable"))),
    ("500", lambda request: httpx.Response(500, json={"message": f"failed for {TO}"})),
    ("503", lambda request: httpx.Response(503, text="unavailable")),
    # Resend refuses the message: a bad key, an unverified domain, invalid input.
    ("401", lambda request: httpx.Response(401, json={"message": "API key is invalid"})),
    ("422", lambda request: httpx.Response(422, json={"message": f"Invalid `to`: {TO}"})),
]


@pytest.mark.parametrize(
    "handler", [handler for _, handler in FAILURES], ids=[n for n, _ in FAILURES]
)
async def test_timeout_and_5xx_raise_typed_error(handler: Handler) -> None:
    with pytest.raises(EmailUnavailableError) as error:
        await send(handler)

    # Nothing of the message rides on the exception either.
    assert str(error.value) == ""
    assert error.value.__cause__ is None


@pytest.mark.parametrize(
    "handler", [handler for _, handler in FAILURES], ids=[n for n, _ in FAILURES]
)
async def test_logs_no_address_or_body(handler: Handler, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(EmailUnavailableError):
        await send(handler)

    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records)
    assert caplog.records
    for secret in (TO, "ana.probe", SUBJECT, TEXT, HTML, "482915", API_KEY, "failed for"):
        assert secret not in output
