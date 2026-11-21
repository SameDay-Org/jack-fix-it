"""The auth routes' per-IP limits count the visitor behind the web service (#530, #96 S96-08).

The admin panel's login, session refresh and logout are called by the web app's server, from
its one address: counted by that address, every panel visitor shared one bucket, so an
anonymous script could lock every staff member out of the panel (logins) and sign them out
(refreshes). Behind the web service's key (#409), the visitor's address it forwards
(X-JFI-Client-IP) is the one counted. Without the key, the header is never read.
"""

import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Final

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis

from app.config import Settings
from app.integrations.email import get_email_sender
from app.modules.auth.password_reset import ResetCodeStore, get_reset_code_store
from app.rate_limit import get_rate_limiter
from tests.conftest import TEST_WEB_SERVICE_SETTINGS, InMemoryRateLimiter, make_settings
from tests.test_password_reset_api import FakeSender

KEY: Final = str(TEST_WEB_SERVICE_SETTINGS["web_service_key"])
ATTACKER: Final = "203.0.113.10"
STAFF: Final = "198.51.100.20"
LIMIT: Final = 10  # AUTH_RATE_LIMIT_REQUESTS: register, login, refresh and logout, per address
RESET_LIMIT: Final = 3  # PASSWORD_RESET_REQUEST_LIMIT: forgot, per address and per email
NOW: Final = 1_000.0


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        **TEST_WEB_SERVICE_SETTINGS,
        auth_rate_limit_requests=LIMIT,
        password_reset_request_limit=RESET_LIMIT,
    )


@pytest.fixture(autouse=True)
def limiter(app: FastAPI) -> InMemoryRateLimiter:
    # A fixed clock, so no test straddles two rate-limit windows.
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return limiter


def from_web(visitor: str | None, key: str | None = KEY) -> dict[str, str]:
    headers: dict[str, str] = {}
    if key is not None:
        headers["x-jfi-web-key"] = key
    if visitor is not None:
        headers["x-jfi-client-ip"] = visitor
    return headers


async def login(
    client: httpx.AsyncClient, n: int, headers: dict[str, str] | list[tuple[str, str]]
) -> int:
    body = {"email": f"nobody-{n}@example.com", "password": "not-the-password"}
    return (await client.post("/v1/auth/login", json=body, headers=headers)).status_code


async def refresh(client: httpx.AsyncClient, headers: dict[str, str]) -> int:
    body = {"refresh_token": "not-a-refresh-token"}
    return (await client.post("/v1/auth/refresh", json=body, headers=headers)).status_code


async def test_one_visitors_failed_logins_do_not_lock_the_staff_out(
    db_client: httpx.AsyncClient,
) -> None:
    attacker = [await login(db_client, n, from_web(ATTACKER)) for n in range(LIMIT + 1)]
    staff = await login(db_client, 99, from_web(STAFF))

    assert attacker == [401] * LIMIT + [429]  # the attacker's own bucket is spent
    assert staff == 401  # past the limit: a wrong password here, not a 429


async def test_one_visitors_garbage_refreshes_do_not_sign_the_staff_out(
    db_client: httpx.AsyncClient,
) -> None:
    attacker = [await refresh(db_client, from_web(ATTACKER)) for _ in range(LIMIT + 1)]
    staff = await refresh(db_client, from_web(STAFF))

    assert attacker[-1] == 429
    assert staff == 401  # an invalid token, not a 429


@pytest.fixture
async def reset_sender(app: FastAPI) -> AsyncIterator[FakeSender]:
    """The reset code store on the test Redis, under a prefix of its own, and a fake mailer, so
    a forgot request answers its real 202 and never an error."""
    redis = Redis.from_url(Settings().redis_url)
    prefix = f"pwreset-visitor-test-{uuid.uuid4().hex}"
    sender = FakeSender()
    app.dependency_overrides[get_email_sender] = lambda: sender
    app.dependency_overrides[get_reset_code_store] = lambda: ResetCodeStore(
        redis, timeout_seconds=5.0, prefix=prefix
    )
    try:
        yield sender
    finally:
        keys = [key async for key in redis.scan_iter(match=f"{prefix}:*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()


async def test_one_visitors_logouts_have_their_own_bucket(db_client: httpx.AsyncClient) -> None:
    async def logout(n: int, headers: dict[str, str]) -> int:
        body = {"refresh_token": f"not-a-refresh-token-{n}"}
        return (await db_client.post("/v1/auth/logout", json=body, headers=headers)).status_code

    attacker = [await logout(n, from_web(ATTACKER)) for n in range(LIMIT + 1)]
    staff = await logout(99, from_web(STAFF))

    assert attacker == [204] * LIMIT + [429]
    assert staff == 204  # always 204 for an unknown token, and not the attacker's 429


async def test_one_visitors_reset_requests_have_their_own_bucket(
    db_client: httpx.AsyncClient, reset_sender: FakeSender
) -> None:
    """A new email each time, so only the per-address bucket fills (forgot also counts per
    email)."""

    async def forgot(n: int, headers: dict[str, str]) -> int:
        body = {"email": f"nobody-{n}@example.com"}
        return (
            await db_client.post("/v1/auth/password/forgot", json=body, headers=headers)
        ).status_code

    attacker = [await forgot(n, from_web(ATTACKER)) for n in range(RESET_LIMIT + 1)]
    staff = await forgot(99, from_web(STAFF))

    assert attacker == [202] * RESET_LIMIT + [429]
    assert staff == 202  # the route's own answer, not the attacker's 429
    assert reset_sender.sent == []  # no account has these emails


async def test_one_visitors_registrations_do_not_use_up_another_visitors(
    db_client: httpx.AsyncClient,
) -> None:
    async def register(n: int, headers: dict[str, str]) -> int:
        body = {
            "email": f"new-{n}@example.com",
            "password": "correct horse battery",
            "role": "customer",
        }
        return (await db_client.post("/v1/auth/register", json=body, headers=headers)).status_code

    attacker = [await register(n, from_web(ATTACKER)) for n in range(LIMIT + 1)]
    visitor = await register(99, from_web(STAFF))

    assert attacker == [201] * LIMIT + [429]  # one visitor does hit the limit
    assert visitor == 201  # through the same web key, another visitor's bucket is untouched


@pytest.mark.parametrize("key", [None, "not-the-web-service-key"], ids=["no_key", "wrong_key"])
async def test_without_the_key_the_visitor_header_is_ignored(
    db_client: httpx.AsyncClient, key: str | None
) -> None:
    """Anyone can send X-JFI-Client-IP: without the web service's key, a new value per request
    still counts against the caller's own address."""
    statuses = [
        await login(db_client, n, from_web(f"192.0.2.{n + 1}", key=key)) for n in range(LIMIT + 1)
    ]

    assert statuses[-1] == 429


def rendered_logs(caplog: pytest.LogCaptureFixture) -> str:
    """Every captured record as a log line could carry it: the formatted message and every
    attribute, `extra` fields included (the app's JSON formatter writes those too)."""
    return caplog.text + "\n".join(
        json.dumps(record.__dict__, default=str) for record in caplog.records
    )


# X-JFI-Client-IP values per request n that name no one visitor (handoffs/530-web.md): no
# header, a value that is not an address, two headers. A new value each request, so a value
# taken as the bucket would never reach the limit.
NO_ONE_VISITOR: Final[dict[str, Callable[[int], tuple[str, ...]]]] = {
    "no_header": lambda n: (),
    "not_an_address": lambda n: (f"not-an-address-{n}",),
    "two_headers": lambda n: (f"192.0.2.{n + 1}", f"198.51.100.{n + 1}"),
}


@pytest.mark.parametrize("visitors", NO_ONE_VISITOR.values(), ids=NO_ONE_VISITOR.keys())
async def test_the_key_without_one_valid_visitor_counts_the_web_service_and_says_so(
    db_client: httpx.AsyncClient,
    caplog: pytest.LogCaptureFixture,
    visitors: Callable[[int], tuple[str, ...]],
) -> None:
    sent = [visitors(n) for n in range(LIMIT + 1)]
    with caplog.at_level(logging.DEBUG):
        statuses = [
            await login(
                db_client,
                n,
                [("x-jfi-web-key", KEY), *(("x-jfi-client-ip", value) for value in values)],
            )
            for n, values in enumerate(sent)
        ]

    assert statuses == [401] * LIMIT + [429]  # the web service's own address, as before
    messages = [record.getMessage() for record in caplog.records]
    assert messages.count("web_service_visitor_ip_missing") == LIMIT + 1
    logged = rendered_logs(caplog)
    for leak in (KEY, *(value for values in sent for value in values)):
        assert leak not in logged
