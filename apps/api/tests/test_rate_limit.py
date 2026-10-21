"""Rate limits on the unauthenticated auth routes (D4.4, #28)."""

import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Literal

import httpx
import pytest
from argon2 import PasswordHasher
from fastapi import FastAPI
from pydantic import SecretStr
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError

from app.config import AppEnv, Settings
from app.modules.auth import security
from app.modules.users.service import UserService
from app.observability import JsonFormatter
from app.rate_limit import (
    DEVELOPMENT_HMAC_KEY,
    IdentifierHasher,
    RateLimiter,
    RateLimitResult,
    RedisRateLimiter,
    get_rate_limiter,
    hashed_identifier,
    window_position,
)
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.test_auth_api import PASSWORD, login, register

IP_LIMIT = 3
EMAIL_LIMIT = 2
WINDOW_SECONDS = 60
# A fixed clock 20 s before the end of a window, so no test straddles two windows.
NOW = 1_000.0
RETRY_AFTER = "20"
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
OTHER_IP = "203.0.113.7"
TIMEOUT_SECONDS = 0.2


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        auth_rate_limit_requests=IP_LIMIT,
        login_rate_limit_per_email=EMAIL_LIMIT,
        auth_rate_limit_window_seconds=WINDOW_SECONDS,
        rate_limit_timeout_seconds=TIMEOUT_SECONDS,
    )


@pytest.fixture
def limiter(app: FastAPI) -> InMemoryRateLimiter:
    """The app's limiter, on the fixed clock."""
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return limiter


@pytest.fixture
async def other_ip_client(
    app: FastAPI, db_client: httpx.AsyncClient
) -> AsyncIterator[httpx.AsyncClient]:
    """A second client on the same app and test session, from another IP address."""
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=(OTHER_IP, 40_000))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest.fixture
async def redis_client() -> AsyncIterator[Redis]:
    """The real Redis of REDIS_URL. Tests use their own key prefix and delete it afterwards."""
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def key_prefix(redis_client: Redis) -> AsyncIterator[str]:
    prefix = f"rl-test-{uuid.uuid4().hex}"
    yield prefix
    keys = [key async for key in redis_client.scan_iter(match=f"{prefix}:*")]
    if keys:
        await redis_client.delete(*keys)


def assert_rate_limited(response: httpx.Response) -> None:
    assert response.status_code == 429
    assert response.json() == RATE_LIMITED
    assert response.headers["Retry-After"] == RETRY_AFTER


def email(n: int) -> str:
    return f"user{n}@example.com"


# Keyed identifiers (#137)

# Fixture values only; real secrets live in Railway variables.
SECRET_A = "test-rate-limit-key-a-not-real-0123456789"
SECRET_B = "test-rate-limit-key-b-not-real-0123456789"


def test_hmac_key_depends_on_secret() -> None:
    value = "probe.user@example.com"

    under_a = hashed_identifier(value, SECRET_A)

    assert under_a == hmac.new(SECRET_A.encode(), value.encode(), hashlib.sha256).hexdigest()
    assert under_a != hashed_identifier(value, SECRET_B)
    assert under_a != hashlib.sha256(value.encode()).hexdigest()


def test_same_input_same_key() -> None:
    hasher = IdentifierHasher.from_settings(make_settings(rate_limit_key_secret=SECRET_A))

    assert hasher("+14075550123") == hasher("+14075550123")
    assert hasher("+14075550123") == hashed_identifier("+14075550123", SECRET_A)
    assert hasher("+14075550123") != hasher("+14075550124")
    assert SECRET_A not in repr(hasher)


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_dev_fallback_only_without_secret(app_env: AppEnv) -> None:
    unset = IdentifierHasher.from_settings(make_settings(app_env=app_env))
    configured = IdentifierHasher.from_settings(
        make_settings(app_env=app_env, rate_limit_key_secret=SECRET_A)
    )

    assert unset("x") == hashed_identifier("x", DEVELOPMENT_HMAC_KEY)
    assert configured("x") == hashed_identifier("x", SECRET_A)


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_dev_fallback_never_used_when_deployed(app_env: AppEnv) -> None:
    # Settings refuses to load without the secret (test_config); a hand-built one that skips
    # validation must not fall back either.
    unvalidated = Settings.model_construct(app_env=app_env, rate_limit_key_secret=None)
    with pytest.raises(RuntimeError, match="RATE_LIMIT_KEY_SECRET"):
        IdentifierHasher.from_settings(unvalidated)

    deployed = Settings.model_construct(app_env=app_env, rate_limit_key_secret=SecretStr(SECRET_A))
    hasher = IdentifierHasher.from_settings(deployed)
    assert hasher("x") == hashed_identifier("x", SECRET_A)
    assert hasher("x") != hashed_identifier("x", DEVELOPMENT_HMAC_KEY)


# The limiter


async def test_counter_allows_up_to_limit_then_blocks() -> None:
    limiter = InMemoryRateLimiter(clock=lambda: NOW)

    results = [
        await limiter.hit("scope", "id", limit=3, window_seconds=WINDOW_SECONDS) for _ in range(5)
    ]

    assert [result.allowed for result in results] == [True, True, True, False, False]
    assert {result.retry_after_seconds for result in results} == {20}
    other = await limiter.hit("scope", "other-id", limit=3, window_seconds=WINDOW_SECONDS)
    assert other.allowed


async def test_window_resets() -> None:
    now = [1_019.5]
    limiter = InMemoryRateLimiter(clock=lambda: now[0])
    for _ in range(3):
        await limiter.hit("scope", "id", limit=3, window_seconds=WINDOW_SECONDS)

    blocked = await limiter.hit("scope", "id", limit=3, window_seconds=WINDOW_SECONDS)
    now[0] = 1_020.0
    next_window = await limiter.hit("scope", "id", limit=3, window_seconds=WINDOW_SECONDS)

    # Half a second left still reads as 1, never 0.
    assert blocked == RateLimitResult(allowed=False, retry_after_seconds=1)
    assert next_window == RateLimitResult(allowed=True, retry_after_seconds=60)


@pytest.mark.parametrize(
    ("now", "expected"),
    [(0.0, (0, 60)), (59.9, (0, 1)), (60.0, (1, 60)), (1_000.0, (16, 20))],
)
def test_window_position(now: float, expected: tuple[int, int]) -> None:
    assert window_position(now, WINDOW_SECONDS) == expected


async def test_redis_limiter_is_atomic_under_concurrency(
    redis_client: Redis, key_prefix: str
) -> None:
    limiter = RedisRateLimiter(redis_client, prefix=key_prefix, clock=lambda: NOW)
    limit = 20

    results = await asyncio.gather(
        *(
            limiter.hit("scope", "id", limit=limit, window_seconds=WINDOW_SECONDS)
            for _ in range(limit + 5)
        )
    )

    assert sum(result.allowed for result in results) == limit
    key = f"{key_prefix}:scope:id:16"
    assert await redis_client.get(key) == str(limit + 5).encode()
    # EXPIRE was set once, on the first hit, to the window length.
    assert 0 < await redis_client.ttl(key) <= WINDOW_SECONDS


# Enforcement on the routes


async def test_login_returns_429_with_retry_after_after_limit(
    db_client: httpx.AsyncClient, limiter: InMemoryRateLimiter
) -> None:
    # Distinct emails, so only the per-IP limit applies.
    for n in range(IP_LIMIT):
        assert (await login(db_client, email=email(n))).status_code == 401

    assert_rate_limited(await login(db_client, email=email(99)))


async def test_register_returns_429_after_limit(
    db_client: httpx.AsyncClient, limiter: InMemoryRateLimiter
) -> None:
    for n in range(IP_LIMIT):
        assert (await register(db_client, email=email(n))).status_code == 201

    assert_rate_limited(await register(db_client, email=email(99)))
    # The limited request created nothing: login as that email is unknown.
    limiter.counts.clear()
    assert (await login(db_client, email=email(99))).status_code == 401


@pytest.mark.parametrize("route", ["refresh", "logout"])
async def test_refresh_and_logout_are_limited_per_ip(
    db_client: httpx.AsyncClient,
    other_ip_client: httpx.AsyncClient,
    limiter: InMemoryRateLimiter,
    route: Literal["refresh", "logout"],
) -> None:
    path = f"/v1/auth/{route}"
    body = {"refresh_token": security.new_refresh_token()}
    for _ in range(IP_LIMIT):
        assert (await db_client.post(path, json=body)).status_code in (401, 204)

    assert_rate_limited(await db_client.post(path, json=body))
    # Per client IP: another address still gets through.
    assert (await other_ip_client.post(path, json=body)).status_code in (401, 204)


async def test_limits_are_per_route(
    db_client: httpx.AsyncClient, limiter: InMemoryRateLimiter
) -> None:
    for n in range(IP_LIMIT):
        await login(db_client, email=email(n))

    assert_rate_limited(await login(db_client, email=email(99)))
    assert (await register(db_client, email=email(99))).status_code == 201


async def test_login_per_email_limit_applies_across_ips(
    db_client: httpx.AsyncClient,
    other_ip_client: httpx.AsyncClient,
    limiter: InMemoryRateLimiter,
) -> None:
    await register(db_client)
    limiter.counts.clear()
    for _ in range(EMAIL_LIMIT):
        assert (await login(db_client, password="wrong horse battery")).status_code == 401

    # Another IP, well under its own limit, is stopped by the email's limit.
    assert_rate_limited(await login(other_ip_client))
    # Normalization: a differently written form of the same email counts the same.
    assert_rate_limited(await login(other_ip_client, email="  ANA@Example.com"))
    assert (await login(other_ip_client, email=email(1))).status_code == 401


async def test_limited_request_never_verifies_password(
    db_client: httpx.AsyncClient,
    limiter: InMemoryRateLimiter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Use up the register limit and the email's login limit, then spy on the limited calls.
    await register(db_client)
    for n in range(IP_LIMIT - 1):
        await register(db_client, email=email(n))
    for _ in range(EMAIL_LIMIT):
        await login(db_client)
    calls: list[str] = []

    class SpyHasher(PasswordHasher):
        def verify(self, hash: str | bytes, password: str | bytes) -> Literal[True]:
            calls.append("verify")
            return super().verify(hash, password)

        def hash(self, password: str | bytes, *, salt: bytes | None = None) -> str:
            calls.append("hash")
            return super().hash(password, salt=salt)

    async def spy_lookup(self: UserService, email: str) -> None:
        calls.append("lookup")

    monkeypatch.setattr(security, "PASSWORD_HASHER", SpyHasher())
    monkeypatch.setattr(UserService, "get_credentials_by_email", spy_lookup)

    assert_rate_limited(await login(db_client))
    assert_rate_limited(await register(db_client, email=email(99)))

    assert calls == []


async def test_429_body_does_not_reveal_which_limit(
    db_client: httpx.AsyncClient,
    other_ip_client: httpx.AsyncClient,
    limiter: InMemoryRateLimiter,
) -> None:
    for n in range(IP_LIMIT):
        await login(db_client, email=email(n))
    per_ip = await login(db_client, email=email(99))
    for _ in range(EMAIL_LIMIT):
        await login(other_ip_client, email=email(50))
    per_email = await login(other_ip_client, email=email(50))

    assert per_ip.status_code == per_email.status_code == 429
    assert per_ip.json() == per_email.json() == RATE_LIMITED
    assert per_ip.headers["Retry-After"] == per_email.headers["Retry-After"]


class FailingLimiter:
    def __init__(self, error: Exception) -> None:
        self.error = error

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        raise self.error


@pytest.mark.parametrize(
    "error", [RedisConnectionError("Error connecting to redis:6379"), OSError("unreachable")]
)
async def test_redis_failure_allows_request_and_logs(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
) -> None:
    failing: RateLimiter = FailingLimiter(error)
    app.dependency_overrides[get_rate_limiter] = lambda: failing
    target = "probe@example.com"

    with caplog.at_level(logging.INFO):
        responses = [await login(db_client, email=target) for _ in range(IP_LIMIT + 2)]

    # Fail open: every request reached the service.
    assert [response.status_code for response in responses] == [401] * (IP_LIMIT + 2)
    records = [r for r in caplog.records if r.message == "rate_limit_unavailable"]
    assert records
    assert all(r.levelno == logging.ERROR for r in records)
    # Both login limits failed open; the scope is the only detail logged.
    assert {getattr(r, "scope", None) for r in records} == {"auth_login", "auth_login_email"}
    formatter = JsonFormatter()
    for record in records:
        payload = json.loads(formatter.format(record))
        assert set(payload) <= {"timestamp", "level", "logger", "message", "request_id", "scope"}
    output = "\n".join(formatter.format(r) for r in caplog.records)
    hashes = (
        hashlib.sha256(target.encode()).hexdigest(),
        hashed_identifier(target, DEVELOPMENT_HMAC_KEY),
    )
    for secret in (target, *hashes, "127.0.0.1", PASSWORD):
        assert secret not in output


@pytest.fixture
async def silent_redis_url() -> AsyncIterator[str]:
    """A TCP server that accepts connections and never answers: a hung Redis."""
    connections: list[asyncio.StreamWriter] = []

    async def accept(_: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connections.append(writer)

    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"redis://127.0.0.1:{port}/0"
    finally:
        for writer in connections:
            writer.close()
        server.close()
        await server.wait_closed()


async def test_hung_redis_fails_open_within_timeout(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    silent_redis_url: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = Redis.from_url(silent_redis_url)
    hung = RedisRateLimiter(client)
    app.dependency_overrides[get_rate_limiter] = lambda: hung

    started = time.perf_counter()
    try:
        # Without the limiter's own timeout the request would wait forever; fail instead.
        async with asyncio.timeout(10):
            with caplog.at_level(logging.INFO):
                response = await login(db_client, email="probe@example.com")
    finally:
        await client.aclose()
    elapsed = time.perf_counter() - started

    assert response.status_code == 401
    # Two checks (IP, then email), each cut off at the timeout; the rest is one Argon2 verify.
    assert elapsed < 2 * TIMEOUT_SECONDS + 2
    records = [r for r in caplog.records if r.message == "rate_limit_unavailable"]
    assert {getattr(r, "scope", None) for r in records} == {"auth_login", "auth_login_email"}


async def test_ipv4_mapped_client_shares_the_ipv4_bucket(
    app: FastAPI, db_client: httpx.AsyncClient, limiter: InMemoryRateLimiter
) -> None:
    def client_from(host: str) -> httpx.AsyncClient:
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=(host, 1))
        return httpx.AsyncClient(transport=transport, base_url="http://testserver")

    async with client_from(f"::ffff:{OTHER_IP}") as mapped, client_from(OTHER_IP) as plain:
        for n in range(IP_LIMIT):
            assert (await register(mapped, email=email(n))).status_code == 201

        assert_rate_limited(await register(plain, email=email(99)))


async def test_email_is_hashed_in_key(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    redis_client: Redis,
    key_prefix: str,
) -> None:
    redis_limiter = RedisRateLimiter(redis_client, prefix=key_prefix, clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: redis_limiter
    target = "Probe.User@Example.com"

    assert (await login(db_client, email=target)).status_code == 401

    keys = sorted([key.decode() async for key in redis_client.scan_iter(match=f"{key_prefix}:*")])
    # These settings set no RATE_LIMIT_KEY_SECRET, so the development key applies.
    digest = hashed_identifier("probe.user@example.com", DEVELOPMENT_HMAC_KEY)
    assert keys == sorted(
        [
            f"{key_prefix}:auth_login:127.0.0.1:16",
            f"{key_prefix}:auth_login_email:{digest}:16",
        ]
    )
    for key in keys:
        assert "@" not in key
        assert "probe" not in key.lower()


def test_openapi_documents_429_on_auth_routes(app: FastAPI) -> None:
    paths = app.openapi()["paths"]

    for route in ("register", "login", "refresh", "logout"):
        response = paths[f"/v1/auth/{route}"]["post"]["responses"]["429"]
        assert response["content"]["application/json"]["schema"] == {
            "$ref": "#/components/schemas/ErrorResponse"
        }
        assert "Retry-After" in response["headers"]
