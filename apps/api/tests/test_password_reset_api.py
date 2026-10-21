"""Password reset by emailed 6-digit code over HTTP (D4.3 password, #27).

Codes live in the real Redis of REDIS_URL under a unique prefix; email goes to a fake sender.
"""

import asyncio
import itertools
import json
import logging
import re
import secrets
import uuid
from collections.abc import AsyncIterator, Callable
from contextvars import ContextVar
from dataclasses import dataclass, field

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Message, Receive, Scope, Send

from app.config import Settings
from app.integrations.email import EmailUnavailableError, get_email_sender
from app.modules.auth import password_reset
from app.modules.auth.email_copy import PASSWORD_RESET_CODE, password_reset_code_email
from app.modules.auth.password_reset import ResetCodeStore, get_reset_code_store
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserCredentials, UserStatus
from app.observability import JsonFormatter
from app.rate_limit import (
    DEVELOPMENT_HMAC_KEY,
    RateLimitResult,
    get_rate_limiter,
    hashed_identifier,
)
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    Committed,
    InMemoryRateLimiter,
    backend_pid,
    make_settings,
    wait_until_blocked,
)
from tests.test_auth_api import PASSWORD, login, register

EMAIL = "ana.reset@example.com"
OTHER_EMAIL = "bruno.reset@example.com"
UNKNOWN_EMAIL = "nobody.reset@example.com"
NEW_PASSWORD = "a-brand-new-password"
# Distinct from the defaults, so the tests prove the values come from settings.
TTL_SECONDS = 600
MAX_ATTEMPTS = 3
DAILY_LIMIT = 4  # not the default (5), so the tests prove it comes from settings
DAILY_WINDOW_SECONDS = 7_200
REQUEST_LIMIT = 2
NOW = 1_000.0
OTHER_IP = "203.0.113.7"
STORE_TIMEOUT = 0.5
INVALID_CODE = {
    "error": {"code": "invalid_code", "message": "The code is incorrect or has expired."}
}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}


@dataclass
class SentEmail:
    to: str
    subject: str
    text: str
    html: str

    @property
    def code(self) -> str:
        match = re.search(r"\b([0-9]{6})\b", self.text)
        assert match is not None
        return match.group(1)


@dataclass
class FakeSender:
    sent: list[SentEmail] = field(default_factory=list)
    error: Exception | None = None
    on_send: Callable[[], None] | None = None

    async def send(self, to: str, subject: str, text: str, html: str) -> None:
        if self.on_send:
            self.on_send()
        if self.error:
            raise self.error
        self.sent.append(SentEmail(to, subject, text, html))


def settings_with(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "password_reset_code_ttl_seconds": TTL_SECONDS,
        "password_reset_max_attempts": MAX_ATTEMPTS,
        # High, so only the rate-limit and daily-cap tests ever reach them.
        "password_reset_request_limit": 50,
        "password_reset_daily_limit": 50,
    }
    values.update(overrides)
    return make_settings(**values)


@pytest.fixture
def settings() -> Settings:
    return settings_with()


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def prefix(redis: Redis) -> AsyncIterator[str]:
    prefix = f"pwreset-test-{uuid.uuid4().hex}"
    yield prefix
    keys = [key async for key in redis.scan_iter(match=f"{prefix}:*")]
    if keys:
        await redis.delete(*keys)


@pytest.fixture
def clock() -> list[float]:
    """The rate limiter's time; a test moves it by setting clock[0]."""
    return [NOW]


@pytest.fixture
def sender(app: FastAPI, redis: Redis, prefix: str, clock: list[float]) -> FakeSender:
    fake = FakeSender()
    app.dependency_overrides[get_email_sender] = lambda: fake
    app.dependency_overrides[get_reset_code_store] = lambda: ResetCodeStore(
        redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix
    )
    # A fixed clock, so no test straddles two rate-limit windows unless it moves it.
    limiter = InMemoryRateLimiter(clock=lambda: clock[0])
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return fake


@pytest.fixture
def codes(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Makes new_code deterministic: 100001, 100002, ... in order; yields the codes issued."""
    issued: list[str] = []
    counter = itertools.count(100_001)

    def next_code() -> str:
        issued.append(str(next(counter)))
        return issued[-1]

    monkeypatch.setattr(password_reset, "new_code", next_code)
    return issued


def key(prefix: str, email: str) -> str:
    # These settings set no RATE_LIMIT_KEY_SECRET, so the development key applies.
    return f"{prefix}:{hashed_identifier(email, DEVELOPMENT_HMAC_KEY)}"


def code_digest(code: str) -> str:
    return hashed_identifier(f"password_reset_code:{code}", DEVELOPMENT_HMAC_KEY)


async def forgot(client: httpx.AsyncClient, email: str = EMAIL) -> httpx.Response:
    return await client.post("/v1/auth/password/forgot", json={"email": email})


async def reset(
    client: httpx.AsyncClient,
    code: str,
    email: str = EMAIL,
    new_password: str = NEW_PASSWORD,
) -> httpx.Response:
    return await client.post(
        "/v1/auth/password/reset",
        json={"email": email, "code": code, "new_password": new_password},
    )


async def stored(redis: Redis, prefix: str, email: str = EMAIL) -> dict[str, str]:
    # redis-py types hgetall as `Awaitable | dict` for its sync and async clients alike;
    # on redis.asyncio it is always awaitable.
    raw = await redis.hgetall(key(prefix, email))  # type: ignore[misc]
    return {k.decode(): v.decode() for k, v in raw.items()}


async def refresh(client: httpx.AsyncClient, token: str) -> httpx.Response:
    return await client.post("/v1/auth/refresh", json={"refresh_token": token})


# Forgot


async def test_forgot_is_202_for_known_and_unknown_email_and_sends_only_for_known(
    db_client: httpx.AsyncClient, sender: FakeSender
) -> None:
    await register(db_client, email=EMAIL)

    known = await forgot(db_client, EMAIL)
    unknown = await forgot(db_client, UNKNOWN_EMAIL)

    for response in (known, unknown):
        assert response.status_code == 202
        assert response.content == b""
    assert known.headers.keys() == unknown.headers.keys()
    assert [email.to for email in sender.sent] == [EMAIL]


async def test_forgot_sends_after_response(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Known and unknown emails answer at the same speed: the lookup and the email come after.
    await register(db_client, email=EMAIL)
    response_sent = asyncio.Event()
    looked_up_after: list[bool] = []
    sent_after: list[bool] = []
    original = password_reset.PasswordResetService.send_code

    async def tracked(self: password_reset.PasswordResetService, email: str) -> None:
        looked_up_after.append(response_sent.is_set())
        await original(self, email)

    monkeypatch.setattr(password_reset.PasswordResetService, "send_code", tracked)
    sender.on_send = lambda: sent_after.append(response_sent.is_set())

    async def wrapped(scope: Scope, receive: Receive, send_message: Send) -> None:
        async def tracking_send(message: Message) -> None:
            await send_message(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                response_sent.set()

        response_sent.clear()
        await app(scope, receive, tracking_send)

    transport = httpx.ASGITransport(app=wrapped, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        assert (await forgot(client, EMAIL)).status_code == 202
        assert (await forgot(client, UNKNOWN_EMAIL)).status_code == 202

    assert looked_up_after == [True, True]
    assert sent_after == [True]


async def test_code_is_six_digits_and_stored_hashed_with_ttl(
    db_client: httpx.AsyncClient, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    await register(db_client, email=EMAIL)

    await forgot(db_client)

    [email] = sender.sent
    assert re.fullmatch(r"[0-9]{6}", email.code)
    assert await stored(redis, prefix) == {"code": code_digest(email.code), "tries": "0"}
    ttl = await redis.ttl(key(prefix, EMAIL))
    assert TTL_SECONDS - 5 < ttl <= TTL_SECONDS
    # Neither the code nor the address in any key or value.
    for found in [k.decode() async for k in redis.scan_iter(match=f"{prefix}:*")]:
        assert EMAIL not in found
        assert email.code not in found
    assert email.code not in json.dumps(await stored(redis, prefix))


def test_new_code_is_zero_padded_six_digits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets, "randbelow", lambda bound: 42)

    assert password_reset.new_code() == "000042"


async def test_new_request_replaces_previous_code(
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    codes: list[str],
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    assert (await reset(db_client, "999999")).status_code == 400  # one try spent

    await forgot(db_client)

    first, second = codes
    assert [email.code for email in sender.sent] == [first, second]
    assert await stored(redis, prefix) == {"code": code_digest(second), "tries": "0"}
    assert (await reset(db_client, first)).json() == INVALID_CODE
    assert (await reset(db_client, second)).status_code == 204


@pytest.mark.parametrize(("locale", "subject"), [("en", "Your"), ("es", "Tu")])
async def test_email_is_in_the_users_locale(
    db_client: httpx.AsyncClient, sender: FakeSender, locale: str, subject: str
) -> None:
    await register(db_client, email=EMAIL, locale=locale)

    await forgot(db_client)

    [email] = sender.sent
    assert email.subject == PASSWORD_RESET_CODE[locale].subject
    assert email.subject.startswith(subject)
    assert f"{TTL_SECONDS // 60}" in email.text


async def test_suspended_user_gets_no_email(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
) -> None:
    await register(db_client, email=EMAIL)
    await db_session.execute(
        update(User).where(User.email == EMAIL).values(status=UserStatus.SUSPENDED)
    )

    response = await forgot(db_client)

    assert response.status_code == 202
    assert sender.sent == []
    assert await stored(redis, prefix) == {}


@pytest.mark.parametrize("error", [EmailUnavailableError(), None], ids=["email_down", "redis_down"])
async def test_send_failures_are_202_and_logged(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    caplog: pytest.LogCaptureFixture,
    error: Exception | None,
) -> None:
    await register(db_client, email=EMAIL)
    if error is None:
        dead = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
        app.dependency_overrides[get_reset_code_store] = lambda: ResetCodeStore(
            dead, timeout_seconds=STORE_TIMEOUT
        )
    else:
        sender.error = error

    with caplog.at_level(logging.INFO):
        response = await forgot(db_client)

    assert response.status_code == 202
    assert response.content == b""
    names = {"password_reset_email_unavailable", "password_reset_store_unavailable"}
    [record] = [r for r in caplog.records if r.message in names]
    assert record.levelno == logging.ERROR


# Reset


async def test_reset_success_changes_password_and_revokes_all_sessions(
    db_client: httpx.AsyncClient, sender: FakeSender
) -> None:
    first_session = (await register(db_client, email=EMAIL)).json()
    second_session = (await login(db_client, email=EMAIL)).json()
    others = (await register(db_client, email=OTHER_EMAIL)).json()
    await forgot(db_client)
    [email] = sender.sent

    response = await reset(db_client, email.code)

    assert response.status_code == 204
    assert response.content == b""
    for session in (first_session, second_session):
        rejected = await refresh(db_client, session["refresh_token"])
        assert rejected.status_code == 401
        assert rejected.json()["error"]["code"] == "invalid_refresh_token"
    assert (await login(db_client, email=EMAIL, password=PASSWORD)).status_code == 401
    assert (await login(db_client, email=EMAIL, password=NEW_PASSWORD)).status_code == 200
    # Another user's session is untouched.
    assert (await refresh(db_client, others["refresh_token"])).status_code == 200


async def test_reset_code_is_single_use(
    db_client: httpx.AsyncClient, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent

    first = await reset(db_client, email.code)
    again = await reset(db_client, email.code, new_password="yet-another-password")

    assert first.status_code == 204
    assert again.status_code == 400
    assert again.json() == INVALID_CODE
    assert await stored(redis, prefix) == {}
    assert (await login(db_client, email=EMAIL, password=NEW_PASSWORD)).status_code == 200


async def test_concurrent_resets_with_the_code_succeed_once(
    db_client: httpx.AsyncClient, sender: FakeSender
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent

    responses = await asyncio.gather(*(reset(db_client, email.code) for _ in range(3)))

    assert sorted(response.status_code for response in responses) == [204, 400, 400]


async def test_wrong_code_increments_and_locks_after_max_attempts(
    db_client: httpx.AsyncClient, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent
    wrong = "000000" if email.code != "000000" else "111111"

    for tries in range(1, MAX_ATTEMPTS):
        response = await reset(db_client, wrong)
        assert response.json() == INVALID_CODE
        assert (await stored(redis, prefix))["tries"] == str(tries)
    assert (await reset(db_client, wrong)).json() == INVALID_CODE  # the last try

    assert await stored(redis, prefix) == {}
    locked = await reset(db_client, email.code)
    assert locked.status_code == 400
    assert locked.json() == INVALID_CODE


async def test_store_caps_tries_even_when_concurrent(redis: Redis, prefix: str) -> None:
    # Guesses in flight together each count before any comparison: past the limit the store
    # deletes the code and answers nothing, whatever the service does with earlier answers.
    store = ResetCodeStore(redis, timeout_seconds=STORE_TIMEOUT, prefix=prefix)
    await store.put("id", "digest", TTL_SECONDS)

    claims = await asyncio.gather(*(store.claim_try("id", MAX_ATTEMPTS) for _ in range(5)))

    assert sorted(c.tries for c in claims if c is not None) == list(range(1, MAX_ATTEMPTS + 1))
    assert [c for c in claims if c is None] == [None] * (5 - MAX_ATTEMPTS)
    assert await redis.exists(f"{prefix}:id") == 0
    assert await store.claim_try("id", MAX_ATTEMPTS) is None


async def test_right_code_on_the_last_try_works(
    db_client: httpx.AsyncClient, sender: FakeSender
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent
    wrong = "000000" if email.code != "000000" else "111111"
    for _ in range(MAX_ATTEMPTS - 1):
        await reset(db_client, wrong)

    assert (await reset(db_client, email.code)).status_code == 204


async def test_expired_code_is_400(
    db_client: httpx.AsyncClient, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent
    await redis.pexpire(key(prefix, EMAIL), 1)
    await asyncio.sleep(0.05)

    response = await reset(db_client, email.code)

    assert response.status_code == 400
    assert response.json() == INVALID_CODE


async def test_unknown_email_reset_is_400_same_body(
    db_client: httpx.AsyncClient, sender: FakeSender
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)

    unknown = await reset(db_client, "123456", email=UNKNOWN_EMAIL)
    no_code = await reset(db_client, "123456", email=OTHER_EMAIL)
    wrong = await reset(db_client, "000000" if sender.sent[0].code != "000000" else "111111")

    for response in (unknown, no_code, wrong):
        assert response.status_code == 400
        assert response.json() == INVALID_CODE


async def test_suspended_after_forgot_cannot_reset(
    db_client: httpx.AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent
    await db_session.execute(
        update(User).where(User.email == EMAIL).values(status=UserStatus.SUSPENDED)
    )

    response = await reset(db_client, email.code)

    assert response.status_code == 400
    assert response.json() == INVALID_CODE


async def test_reset_rejects_short_password(
    db_client: httpx.AsyncClient, sender: FakeSender, redis: Redis, prefix: str
) -> None:
    await register(db_client, email=EMAIL)
    await forgot(db_client)
    [email] = sender.sent
    short = "x" * (make_settings().password_min_length - 1)

    response = await reset(db_client, email.code, new_password=short)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    # Checked before the code: no try spent, the code still works.
    assert (await stored(redis, prefix))["tries"] == "0"
    assert (await reset(db_client, email.code)).status_code == 204


@pytest.mark.parametrize(
    "body",
    [
        {"email": EMAIL, "code": "12345", "new_password": NEW_PASSWORD},
        {"email": EMAIL, "code": "1234567", "new_password": NEW_PASSWORD},
        {"email": EMAIL, "code": "12345a", "new_password": NEW_PASSWORD},
        {"email": EMAIL, "code": "".join(chr(0xFF10 + d) for d in range(6)), "new_password": "x"},
        {"email": "not-an-email", "code": "123456", "new_password": NEW_PASSWORD},
        {"email": EMAIL, "code": "123456", "new_password": "x" * 129},
    ],
    ids=["short_code", "long_code", "letter", "fullwidth_digits", "bad_email", "long_password"],
)
async def test_reset_validates_body(
    db_client: httpx.AsyncClient, sender: FakeSender, body: dict[str, str]
) -> None:
    response = await db_client.post("/v1/auth/password/reset", json=body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


# Rate limits


@pytest.mark.parametrize("settings", [settings_with(password_reset_request_limit=REQUEST_LIMIT)])
@pytest.mark.parametrize("route", ["forgot", "reset"])
async def test_rate_limited_429(
    app: FastAPI, db_client: httpx.AsyncClient, sender: FakeSender, route: str
) -> None:
    async def call(client: httpx.AsyncClient, email: str) -> httpx.Response:
        if route == "forgot":
            return await forgot(client, email)
        return await reset(client, "123456", email=email)

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=(OTHER_IP, 1))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as other_ip:
        # Per email: the limit holds across IPs.
        for _ in range(REQUEST_LIMIT):
            assert (await call(db_client, EMAIL)).status_code != 429
        per_email = await call(other_ip, EMAIL)
        # Per IP: the limit holds across emails.
        for n in range(REQUEST_LIMIT - 1):
            assert (await call(other_ip, f"user{n}@example.com")).status_code != 429
        per_ip = await call(other_ip, OTHER_EMAIL)

    for response in (per_email, per_ip):
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "rate_limited"
        assert int(response.headers["Retry-After"]) >= 1


# Logs and copy


async def test_no_email_or_code_in_logs(
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await register(db_client, email=EMAIL)

    with caplog.at_level(logging.DEBUG):
        await forgot(db_client, EMAIL)
        await forgot(db_client, UNKNOWN_EMAIL)
        [email] = sender.sent
        await reset(db_client, "000000" if email.code != "000000" else "111111")
        await reset(db_client, email.code)

    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records)
    hashed = [hashed_identifier(e, DEVELOPMENT_HMAC_KEY) for e in (EMAIL, UNKNOWN_EMAIL)]
    for secret in (EMAIL, UNKNOWN_EMAIL, "ana.reset", email.code, code_digest(email.code)):
        assert secret not in output
    for secret in (*hashed, NEW_PASSWORD, PASSWORD):
        assert secret not in output
    messages = {record.message for record in caplog.records}
    assert {"password_reset_code_sent", "password_reset_not_sent", "password_reset"} <= messages


def test_email_copy_has_en_and_es_and_no_links() -> None:
    assert set(PASSWORD_RESET_CODE) == {"en", "es"}
    en = password_reset_code_email("en", "042917", 900)
    es = password_reset_code_email("es", "042917", 900)

    assert en.subject != es.subject
    assert en.text != es.text
    for content in (en, es):
        assert "042917" in content.text
        assert "<strong>042917</strong>" in content.html
        assert "15" in content.text
        for part in (content.subject, content.text, content.html):
            lowered = part.lower()
            for link in ("http", "www.", "href", "<a", ".com"):
                assert link not in lowered
    # A locale without copy falls back to English; never less than one minute.
    assert password_reset_code_email("fr", "042917", 900) == en
    assert "1 " in password_reset_code_email("en", "042917", 59).text


def test_openapi_documents_password_routes(app: FastAPI) -> None:
    paths = app.openapi()["paths"]

    forgot_responses = paths["/v1/auth/password/forgot"]["post"]["responses"]
    reset_responses = paths["/v1/auth/password/reset"]["post"]["responses"]
    assert {"202", "422", "429"} <= set(forgot_responses)
    assert {"204", "400", "422", "429"} <= set(reset_responses)


# Review fixes: connection use, Redis timeouts, login racing a reset


async def test_forgot_ends_the_read_transaction_before_sending(
    db_client: httpx.AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    # No pooled connection may sit idle in a transaction while Resend answers.
    await register(db_client, email=EMAIL)
    in_transaction: list[bool] = []
    sender.on_send = lambda: in_transaction.append(db_session.in_transaction())

    await forgot(db_client)

    assert in_transaction == [False]


async def test_store_calls_time_out(silent_redis_url: str) -> None:
    hung = Redis.from_url(silent_redis_url)
    store = ResetCodeStore(hung, timeout_seconds=STORE_TIMEOUT, prefix="pwreset-test")
    try:
        async with asyncio.timeout(10):  # without the store's own timeout: fail, not hang
            for call in (
                store.put("id", "digest", TTL_SECONDS),
                store.claim_try("id", MAX_ATTEMPTS),
                store.delete_if("id", "digest"),
            ):
                with pytest.raises(TimeoutError):
                    await call
    finally:
        await hung.aclose()


async def test_hung_redis_fails_forgot_quietly_and_reset_with_500(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    silent_redis_url: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    await register(db_client, email=EMAIL)
    hung = Redis.from_url(silent_redis_url)
    app.dependency_overrides[get_reset_code_store] = lambda: ResetCodeStore(
        hung, timeout_seconds=STORE_TIMEOUT
    )
    try:
        async with asyncio.timeout(10):
            with caplog.at_level(logging.INFO):
                forgotten = await forgot(db_client)
            reset_response = await reset(db_client, "123456")
    finally:
        await hung.aclose()

    assert forgotten.status_code == 202
    assert sender.sent == []
    assert [r for r in caplog.records if r.message == "password_reset_store_unavailable"]
    assert reset_response.status_code == 500
    assert reset_response.json()["error"]["code"] == "internal_error"


async def test_login_racing_reset_cannot_keep_a_session(
    committed: Committed,
    sender: FakeSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A login that read the old hash holds the user row until it commits; the reset waits for
    # it (Postgres reports the wait), then revokes the session that login created.
    client = committed.client
    await register(client, email=committed.email)
    await forgot(client, committed.email)
    [email] = sender.sent
    original = UserService.get_credentials_by_email
    login_locked = asyncio.Event()
    reset_waiting = asyncio.Event()
    pids: dict[str, int] = {}
    # ASGITransport runs the app in the calling task, and gather gives each call its own
    # context: the lookup knows which request it serves.
    is_login: ContextVar[bool] = ContextVar("is_login", default=False)

    async def interleaved(
        self: UserService, email_address: str, *, lock: bool = False
    ) -> UserCredentials | None:
        if is_login.get():
            credentials = await original(self, email_address, lock=lock)
            pids["login"] = await backend_pid(self._session)
            login_locked.set()
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                await reset_waiting.wait()
            await wait_until_blocked(committed.sessions, waiter=pids["reset"], holder=pids["login"])
            return credentials
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            await login_locked.wait()
        pids["reset"] = await backend_pid(self._session)
        reset_waiting.set()
        return await original(self, email_address, lock=lock)

    async def log_in() -> httpx.Response:
        is_login.set(True)
        return await login(client, email=committed.email)

    monkeypatch.setattr(UserService, "get_credentials_by_email", interleaved)

    logged_in, reset_response = await asyncio.gather(
        log_in(), reset(client, email.code, email=committed.email)
    )

    assert logged_in.status_code == 200
    assert reset_response.status_code == 204
    monkeypatch.undo()
    revoked = await refresh(client, logged_in.json()["refresh_token"])
    assert revoked.status_code == 401
    assert (await login(client, email=committed.email, password=NEW_PASSWORD)).status_code == 200


# Daily cap on new codes (Cesar, 2026-10-21)


@pytest.mark.parametrize(
    "settings",
    [
        settings_with(
            password_reset_daily_limit=DAILY_LIMIT,
            password_reset_daily_window_seconds=DAILY_WINDOW_SECONDS,
        )
    ],
)
async def test_daily_cap_stops_new_codes_and_answer_stays_identical(
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    redis: Redis,
    prefix: str,
    codes: list[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    await register(db_client, email=EMAIL)
    allowed = [await forgot(db_client) for _ in range(DAILY_LIMIT)]

    with caplog.at_level(logging.INFO):
        capped = await forgot(db_client)

    assert len(sender.sent) == DAILY_LIMIT
    assert codes == [email.code for email in sender.sent]
    for response in allowed:
        assert (response.status_code, response.content) == (capped.status_code, capped.content)
        assert response.headers.keys() == capped.headers.keys()
    assert capped.status_code == 202
    # No new code: the last one sent is still the stored one, and still works.
    assert (await stored(redis, prefix))["code"] == code_digest(codes[-1])
    [record] = [r for r in caplog.records if r.message == "password_reset_daily_cap_reached"]
    payload = json.loads(JsonFormatter().format(record))
    assert payload["email_id"] == hashed_identifier(EMAIL, DEVELOPMENT_HMAC_KEY)
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {"email_id"}
    assert EMAIL not in json.dumps(payload)
    assert (await reset(db_client, codes[-1])).status_code == 204


@pytest.mark.parametrize(
    "settings",
    [
        settings_with(
            password_reset_daily_limit=DAILY_LIMIT,
            password_reset_daily_window_seconds=DAILY_WINDOW_SECONDS,
        )
    ],
)
async def test_daily_cap_resets_in_a_new_window(
    db_client: httpx.AsyncClient, sender: FakeSender, clock: list[float]
) -> None:
    await register(db_client, email=EMAIL)
    await register(db_client, email=OTHER_EMAIL)
    for _ in range(DAILY_LIMIT + 1):
        await forgot(db_client)
    assert len(sender.sent) == DAILY_LIMIT
    # Per account: another account is not capped.
    await forgot(db_client, OTHER_EMAIL)
    assert sender.sent[-1].to == OTHER_EMAIL

    clock[0] = NOW + DAILY_WINDOW_SECONDS
    await forgot(db_client)

    assert len(sender.sent) == DAILY_LIMIT + 2
    assert sender.sent[-1].to == EMAIL


class FailingLimiter:
    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        raise RedisConnectionError("Error connecting to redis:6379")


async def test_daily_cap_fails_closed(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    sender: FakeSender,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Unlike the request limits, the cap is checked after the response: when the count cannot
    # be taken, no code is issued (the answer was already the same 202).
    await register(db_client, email=EMAIL)
    app.dependency_overrides[get_rate_limiter] = FailingLimiter

    with caplog.at_level(logging.INFO):
        response = await forgot(db_client)

    assert response.status_code == 202
    assert sender.sent == []
    assert [r for r in caplog.records if r.message == "password_reset_store_unavailable"]
