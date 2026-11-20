"""The auth routes' per-IP limits count the visitor behind the web service (#530, #96 S96-08).

The admin panel's login, session refresh and logout are called by the web app's server, from
its one address: counted by that address, every panel visitor shared one bucket, so an
anonymous script could lock every staff member out of the panel (logins) and sign them out
(refreshes). Behind the web service's key (#409), the visitor's address it forwards
(X-JFI-Client-IP) is the one counted. Without the key, the header is never read.
"""

import logging
from collections.abc import Callable
from typing import Final

import httpx
import pytest
from fastapi import FastAPI

from app.config import Settings
from app.rate_limit import get_rate_limiter
from tests.conftest import TEST_WEB_SERVICE_SETTINGS, InMemoryRateLimiter, make_settings

KEY: Final = str(TEST_WEB_SERVICE_SETTINGS["web_service_key"])
ATTACKER: Final = "203.0.113.10"
STAFF: Final = "198.51.100.20"
LIMIT: Final = 10  # AUTH_RATE_LIMIT_REQUESTS's default
NOW: Final = 1_000.0


@pytest.fixture
def settings() -> Settings:
    return make_settings(**TEST_WEB_SERVICE_SETTINGS)


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


async def login(client: httpx.AsyncClient, n: int, headers: dict[str, str]) -> int:
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


async def test_one_visitors_logouts_and_reset_requests_have_their_own_bucket(
    db_client: httpx.AsyncClient,
) -> None:
    """A new email each time, so only the per-address bucket fills (forgot also counts per
    email)."""
    bodies: dict[str, Callable[[int], dict[str, str]]] = {
        "/v1/auth/logout": lambda n: {"refresh_token": f"not-a-refresh-token-{n}"},
        "/v1/auth/password/forgot": lambda n: {"email": f"nobody-{n}@example.com"},
    }
    for path, body in bodies.items():
        spent = [
            (await db_client.post(path, json=body(n), headers=from_web(ATTACKER))).status_code
            for n in range(LIMIT + 1)
        ]
        other = (await db_client.post(path, json=body(99), headers=from_web(STAFF))).status_code

        assert spent[-1] == 429, path
        assert other != 429, path


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


async def test_the_key_without_a_visitor_counts_the_web_service_and_says_so(
    db_client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        statuses = [await login(db_client, n, from_web(None)) for n in range(LIMIT + 1)]

    assert statuses[-1] == 429  # the web service's own address, as before
    assert "web_service_visitor_ip_missing" in [record.getMessage() for record in caplog.records]
    assert ATTACKER not in caplog.text
    assert KEY not in caplog.text
