"""ExpoPushSender against httpx.MockTransport: never calls Expo (#54)."""

import json
import logging
from collections.abc import Callable

import httpx
import pytest

from app.integrations.expo_push import (
    RECEIPTS_URL,
    SEND_URL,
    ExpoPushSender,
    PushMessage,
    PushUnavailableError,
    Receipt,
    Ticket,
)
from app.observability import JsonFormatter
from tests.conftest import make_settings

ACCESS_TOKEN = "expo-access-token-not-real"
TOKEN = "ExponentPushToken[probe-token-4821]"
TITLE = "Probe title 4821"
BODY = "Probe body 4821"

Handler = Callable[[httpx.Request], httpx.Response]


def sender(handler: Handler, access_token: str | None = None) -> ExpoPushSender:
    return ExpoPushSender(
        access_token=access_token, timeout_seconds=5, transport=httpx.MockTransport(handler)
    )


def message(n: int = 0) -> PushMessage:
    return PushMessage(to=f"ExponentPushToken[t{n}]", title=TITLE, body=BODY, data={"url": "/x"})


def ok_tickets(request: httpx.Request) -> httpx.Response:
    sent = json.loads(request.content)
    return httpx.Response(
        200, json={"data": [{"status": "ok", "id": f"id-{m['to']}"} for m in sent]}
    )


async def test_chunks_by_100() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return ok_tickets(request)

    tickets = await sender(handler).send([message(n) for n in range(250)])

    assert [len(json.loads(r.content)) for r in requests] == [100, 100, 50]
    assert all(str(r.url) == SEND_URL for r in requests)
    assert tickets == [Ticket(id=f"id-ExponentPushToken[t{n}]") for n in range(250)]
    first = json.loads(requests[0].content)[0]
    assert first == {
        "to": "ExponentPushToken[t0]",
        "title": TITLE,
        "body": BODY,
        "data": {"url": "/x"},
        "sound": "default",
    }


async def test_ticket_errors_are_kept_in_order() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"status": "ok", "id": "a"},
                    {"status": "error", "details": {"error": "DeviceNotRegistered"}},
                    {"status": "error", "message": "no details"},
                ]
            },
        )

    tickets = await sender(handler).send([message(n) for n in range(3)])

    assert tickets == [
        Ticket(id="a"),
        Ticket(id=None, error="DeviceNotRegistered"),
        Ticket(id=None, error="unknown"),
    ]


async def test_receipts_in_batches() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        ids = json.loads(request.content)["ids"]
        data: dict[str, object] = {i: {"status": "ok"} for i in ids if i != "pending"}
        data["dead"] = {"status": "error", "details": {"error": "DeviceNotRegistered"}}
        return httpx.Response(200, json={"data": data})

    receipts = await sender(handler).get_receipts(["a", "pending", "dead"])

    assert str(requests[0].url) == RECEIPTS_URL
    assert receipts == {
        "a": Receipt(ok=True),
        "dead": Receipt(ok=False, error="DeviceNotRegistered"),
    }


@pytest.mark.parametrize("access_token", [ACCESS_TOKEN, None])
async def test_bearer_only_when_configured(access_token: str | None) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return ok_tickets(request)

    await sender(handler, access_token).send([message()])

    [request] = requests
    if access_token is None:
        assert "Authorization" not in request.headers
    else:
        assert request.headers["Authorization"] == f"Bearer {ACCESS_TOKEN}"


def test_from_settings_reads_the_optional_token() -> None:
    with_token = ExpoPushSender.from_settings(make_settings(expo_access_token=ACCESS_TOKEN))
    without = ExpoPushSender.from_settings(make_settings())

    assert with_token._headers["Authorization"] == f"Bearer {ACCESS_TOKEN}"
    assert "Authorization" not in without._headers


def raise_error(error: Exception) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    return handler


FAILURES: list[tuple[str, Handler]] = [
    ("timeout", raise_error(httpx.ReadTimeout("timed out"))),
    ("connect_error", raise_error(httpx.ConnectError("unreachable"))),
    ("500", lambda request: httpx.Response(500, json={"errors": [{"message": f"bad {TOKEN}"}]})),
    ("401", lambda request: httpx.Response(401, text="unauthorized")),
    ("not_json", lambda request: httpx.Response(200, text="<html>")),
    ("wrong_count", lambda request: httpx.Response(200, json={"data": []})),
]


@pytest.mark.parametrize(
    "handler", [handler for _, handler in FAILURES], ids=[n for n, _ in FAILURES]
)
async def test_timeouts_and_5xx_raise_typed(handler: Handler) -> None:
    with pytest.raises(PushUnavailableError) as error:
        await sender(handler).send([message()])

    assert str(error.value) == ""
    assert error.value.__cause__ is None


@pytest.mark.parametrize(
    "handler", [handler for _, handler in FAILURES], ids=[n for n, _ in FAILURES]
)
async def test_logs_no_tokens_or_bodies(handler: Handler, caplog: pytest.LogCaptureFixture) -> None:
    probe = PushMessage(to=TOKEN, title=TITLE, body=BODY)

    with caplog.at_level(logging.DEBUG), pytest.raises(PushUnavailableError):
        await sender(handler, ACCESS_TOKEN).send([probe])

    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    assert caplog.records
    for secret in (TOKEN, "probe-token", TITLE, BODY, ACCESS_TOKEN):
        assert secret not in output
