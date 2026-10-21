"""Phone verification by SMS code over HTTP (D4.3 phone, #26). Never calls Twilio."""

import asyncio
import hashlib
import hmac
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Message, Receive, Scope, Send

from app.config import Settings
from app.db import get_session
from app.integrations.sms_verify import (
    InvalidPhoneError,
    VerificationThrottledError,
    VerificationUnavailableError,
    get_phone_verifier,
)
from app.modules.users.models import User
from app.observability import JsonFormatter
from app.rate_limit import (
    DEVELOPMENT_HMAC_KEY,
    RedisRateLimiter,
    get_rate_limiter,
    hashed_identifier,
)
from tests.conftest import InMemoryRateLimiter, make_app, make_settings
from tests.test_auth_api import PASSWORD, login, register

# Fictional numbers (555-01xx), in the allowed +1 region.
PHONE = "+14075550123"
OTHER_PHONE = "+14075550188"
CODE = "482915"
WRONG_CODE = "000000"
SEND_LIMIT = 2
CHECK_LIMIT = 3
NOW = 1_000.0
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
INVALID_CODE = {
    "error": {"code": "invalid_code", "message": "The code is incorrect or has expired."}
}
PHONE_UNAVAILABLE = {
    "error": {
        "code": "phone_unavailable",
        "message": "This phone number cannot be used for this account.",
    }
}
UNAVAILABLE = {
    "error": {
        "code": "verification_unavailable",
        "message": "Phone verification is unavailable right now. Try again later.",
    }
}


@dataclass
class FakeVerifier:
    """Twilio Verify stand-in: CODE is right for every number unless told otherwise."""

    started: list[str] = field(default_factory=list)
    checked: list[tuple[str, str]] = field(default_factory=list)
    error: Exception | None = None
    on_start: Callable[[str], None] | None = None

    async def start(self, phone: str) -> None:
        if self.on_start:
            self.on_start(phone)
        if self.error:
            raise self.error
        self.started.append(phone)

    async def check(self, phone: str, code: str) -> bool:
        if self.error:
            raise self.error
        self.checked.append((phone, code))
        return code == CODE


@pytest.fixture
def settings() -> Settings:
    return make_settings(phone_otp_send_limit=SEND_LIMIT, phone_otp_check_limit=CHECK_LIMIT)


@pytest.fixture
def verifier(app: FastAPI) -> FakeVerifier:
    fake = FakeVerifier()
    app.dependency_overrides[get_phone_verifier] = lambda: fake
    # A fixed clock, so no test straddles two rate-limit windows.
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return fake


@dataclass(frozen=True)
class Caller:
    id: str
    headers: dict[str, str]


async def sign_up(client: httpx.AsyncClient, name: str) -> Caller:
    body = (await register(client, email=f"{name}@example.com")).json()
    return Caller(body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"})


async def send(client: httpx.AsyncClient, caller: Caller, phone: str = PHONE) -> httpx.Response:
    return await client.post("/v1/auth/phone/send", json={"phone": phone}, headers=caller.headers)


async def verify(
    client: httpx.AsyncClient, caller: Caller, code: str = CODE, phone: str = PHONE
) -> httpx.Response:
    return await client.post(
        "/v1/auth/phone/verify", json={"phone": phone, "code": code}, headers=caller.headers
    )


async def stored_phone(session: AsyncSession, caller: Caller) -> tuple[str | None, object]:
    statement = (
        select(User.phone, User.phone_verified_at)
        .where(User.id == uuid.UUID(caller.id))
        .execution_options(populate_existing=True)
    )
    phone, verified_at = (await session.execute(statement)).one()
    return phone, verified_at


# Send


async def test_send_202_for_valid_phone(
    db_client: httpx.AsyncClient, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")

    response = await send(db_client, ana)

    assert response.status_code == 202
    assert response.content == b""
    assert verifier.started == [PHONE]


@pytest.mark.parametrize(
    "phone",
    [
        "4075550123",  # no +
        "+04075550123",  # country code starting with 0
        "+1407555",  # too short
        "+1407555012345678",  # more than 15 digits
        "+1 407 555 0123",  # spaces
        "+1407555012a",
        "",
        "+447911123456",  # valid E.164, but +44 is not an allowed country code
    ],
)
async def test_send_rejects_non_e164_and_disallowed_country(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, phone: str
) -> None:
    ana = await sign_up(db_client, "ana")

    response = await send(db_client, ana, phone)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert verifier.started == []


async def test_allowed_country_codes_come_from_settings(
    db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    test_app = make_app(make_settings(phone_allowed_country_codes="+52"))
    test_app.dependency_overrides[get_phone_verifier] = lambda: verifier

    async def session_override() -> AsyncIterator[AsyncSession]:
        yield db_session

    test_app.dependency_overrides[get_session] = session_override
    transport = httpx.ASGITransport(app=test_app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        ana = await sign_up(client, "ana")
        assert (await send(client, ana, PHONE)).status_code == 422
        assert (await send(client, ana, "+525512345678")).status_code == 202


async def test_send_for_number_verified_by_other_user_is_202_and_sends_nothing(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, caplog: pytest.LogCaptureFixture
) -> None:
    owner = await sign_up(db_client, "owner")
    await send(db_client, owner)
    assert (await verify(db_client, owner)).status_code == 200
    ana = await sign_up(db_client, "ana")
    verifier.started.clear()

    with caplog.at_level(logging.INFO):
        response = await send(db_client, ana)

    assert response.status_code == 202
    assert response.content == b""
    assert verifier.started == []
    [skipped] = [r for r in caplog.records if r.message == "phone_send_skipped"]
    assert getattr(skipped, "user_id", None) == ana.id


@pytest.mark.parametrize(
    ("error", "level", "reason"),
    [
        (InvalidPhoneError(), logging.INFO, "invalid_number"),
        (VerificationThrottledError(), logging.INFO, "throttled"),
        (VerificationUnavailableError(), logging.ERROR, None),
    ],
    ids=["invalid_number", "throttled", "provider_down"],
)
async def test_send_provider_outcomes_are_202_and_logged(
    db_client: httpx.AsyncClient,
    verifier: FakeVerifier,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    level: int,
    reason: str | None,
) -> None:
    # The provider is called after the response: its errors cannot change the answer, which
    # would otherwise differ only for numbers that are not taken.
    ana = await sign_up(db_client, "ana")
    verifier.error = error

    with caplog.at_level(logging.INFO):
        response = await send(db_client, ana)

    assert response.status_code == 202
    assert response.content == b""
    names = {"phone_code_not_sent", "phone_verification_unavailable"}
    [record] = [r for r in caplog.records if r.message in names]
    assert record.levelno == level
    assert getattr(record, "user_id", None) == ana.id
    assert getattr(record, "reason", None) == reason


@pytest.mark.parametrize(
    "phone",
    [
        "+1" + "".join(chr(0xFF10 + int(d)) for d in "4075550123"),  # fullwidth digits
        "+1" + "".join(chr(0x0660 + int(d)) for d in "4075550123"),  # Arabic-Indic digits
        "+1407555" + "".join(chr(0x0966 + int(d)) for d in "0123"),  # Devanagari, mixed
    ],
    ids=["fullwidth", "arabic_indic", "devanagari_mixed"],
)
async def test_non_ascii_digits_are_422(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, phone: str
) -> None:
    # One number written in other scripts would get its own hash and rate-limit key.
    ana = await sign_up(db_client, "ana")
    arabic_code = "".join(chr(0x0660 + int(d)) for d in CODE)

    sent = await send(db_client, ana, phone)
    checked = await verify(db_client, ana, code=arabic_code)

    assert sent.status_code == checked.status_code == 422
    assert verifier.started == []
    assert verifier.checked == []


async def test_provider_is_called_only_after_the_response_is_sent(
    app: FastAPI, db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    # Taken and free numbers answer at the same speed: the provider's latency comes after.
    response_sent = asyncio.Event()
    started_after_response: list[bool] = []

    async def wrapped(scope: Scope, receive: Receive, send_message: Send) -> None:
        async def tracking_send(message: Message) -> None:
            await send_message(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                response_sent.set()

        response_sent.clear()
        await app(scope, receive, tracking_send)

    verifier.on_start = lambda phone: started_after_response.append(response_sent.is_set())

    async def session_override() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = session_override
    transport = httpx.ASGITransport(app=wrapped, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        ana = await sign_up(client, "ana")
        assert (await send(client, ana)).status_code == 202

    assert started_after_response == [True]


async def test_send_rate_limited_per_user_and_per_phone(
    db_client: httpx.AsyncClient, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    bruno = await sign_up(db_client, "bruno")
    carla = await sign_up(db_client, "carla")

    # Per user: Ana's third number in the window is refused.
    for n in range(SEND_LIMIT):
        assert (await send(db_client, ana, f"+1407555010{n}")).status_code == 202
    limited_user = await send(db_client, ana, "+14075550199")
    # Per phone: two other users reach the number's limit; a third is refused.
    for caller in (bruno, carla):
        assert (await send(db_client, caller)).status_code == 202
    dave = await sign_up(db_client, "dave")
    limited_phone = await send(db_client, dave)

    for response in (limited_user, limited_phone):
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "rate_limited"
        assert int(response.headers["Retry-After"]) >= 1
    assert "+14075550199" not in verifier.started
    assert verifier.started.count(PHONE) == SEND_LIMIT


# Verify


async def test_verify_success_sets_phone_and_verified_at(
    db_client: httpx.AsyncClient, db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    await send(db_client, ana)

    response = await verify(db_client, ana)

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == ana.id
    assert body["phone"] == PHONE
    assert body["phone_verified"] is True
    phone, verified_at = await stored_phone(db_session, ana)
    assert phone == PHONE
    assert verified_at is not None
    me = (await db_client.get("/v1/auth/me", headers=ana.headers)).json()
    assert (me["phone"], me["phone_verified"]) == (PHONE, True)
    assert verifier.checked == [(PHONE, CODE)]


@pytest.mark.parametrize("code", ["12ab", "123", "12345678901", " 123456", ""])
async def test_verify_rejects_malformed_code(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, code: str
) -> None:
    ana = await sign_up(db_client, "ana")

    response = await verify(db_client, ana, code=code)

    assert response.status_code == 422
    assert verifier.checked == []


async def test_verify_wrong_code_400(
    db_client: httpx.AsyncClient, db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    await send(db_client, ana)

    response = await verify(db_client, ana, code=WRONG_CODE)

    assert response.status_code == 400
    assert response.json() == INVALID_CODE
    assert await stored_phone(db_session, ana) == (None, None)


async def test_verify_rate_limited_per_user(
    db_client: httpx.AsyncClient, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")

    for _ in range(CHECK_LIMIT):
        assert (await verify(db_client, ana, code=WRONG_CODE)).status_code == 400
    limited = await verify(db_client, ana)

    assert limited.status_code == 429
    assert len(verifier.checked) == CHECK_LIMIT


async def test_verify_race_with_other_user_is_409(
    db_client: httpx.AsyncClient, db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    bruno = await sign_up(db_client, "bruno")
    await send(db_client, ana)
    await send(db_client, bruno)
    # Bruno verifies the number first, in the meantime.
    assert (await verify(db_client, bruno)).status_code == 200

    response = await verify(db_client, ana)

    assert response.status_code == 409
    assert response.json() == PHONE_UNAVAILABLE
    assert await stored_phone(db_session, ana) == (None, None)
    assert (await stored_phone(db_session, bruno))[0] == PHONE


async def test_verify_is_idempotent_for_same_number(
    db_client: httpx.AsyncClient, db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    first = await verify(db_client, ana)
    _, first_verified_at = await stored_phone(db_session, ana)

    second = await verify(db_client, ana)

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert await stored_phone(db_session, ana) == (PHONE, first_verified_at)


async def test_verify_another_number_replaces_the_phone(
    db_client: httpx.AsyncClient, db_session: AsyncSession, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    await verify(db_client, ana)

    response = await verify(db_client, ana, phone=OTHER_PHONE)

    assert response.status_code == 200
    assert (await stored_phone(db_session, ana))[0] == OTHER_PHONE


# Failures, auth and privacy


async def test_provider_down_is_503(
    db_client: httpx.AsyncClient,
    verifier: FakeVerifier,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await sign_up(db_client, "ana")
    verifier.error = VerificationUnavailableError()

    with caplog.at_level(logging.INFO):
        response = await verify(db_client, ana)

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    [record] = [r for r in caplog.records if r.message == "phone_verification_unavailable"]
    assert record.levelno == logging.ERROR
    assert getattr(record, "user_id", None) == ana.id


async def test_missing_twilio_config_is_generic_500(db_client: httpx.AsyncClient) -> None:
    # No get_phone_verifier override and no TWILIO_* settings, as in development.
    ana = await sign_up(db_client, "ana")

    response = await send(db_client, ana)

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"


async def test_unauthenticated_is_401(db_client: httpx.AsyncClient, verifier: FakeVerifier) -> None:
    sent = await db_client.post("/v1/auth/phone/send", json={"phone": PHONE})
    checked = await db_client.post("/v1/auth/phone/verify", json={"phone": PHONE, "code": CODE})

    for response in (sent, checked):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_token"
    assert verifier.started == []
    assert verifier.checked == []


async def test_no_phone_or_code_in_logs(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, caplog: pytest.LogCaptureFixture
) -> None:
    ana = await sign_up(db_client, "ana")
    bruno = await sign_up(db_client, "bruno")
    caplog.clear()

    with caplog.at_level(logging.DEBUG):
        await send(db_client, ana)
        await verify(db_client, ana, code=WRONG_CODE)
        await verify(db_client, ana)  # success
        await send(db_client, bruno)  # skipped: Ana's number now
        await verify(db_client, bruno)  # 409
        verifier.error = VerificationUnavailableError()
        await send(db_client, bruno, OTHER_PHONE)  # 503
        verifier.error = None
        for _ in range(CHECK_LIMIT + 1):
            await verify(db_client, bruno, phone=OTHER_PHONE, code=WRONG_CODE)  # ends in 429

    messages = {r.message for r in caplog.records}
    assert {"phone_code_sent", "phone_code_rejected", "phone_verified"} <= messages
    assert {"phone_send_skipped", "phone_verify_conflict", "phone_verification_unavailable"} <= (
        messages
    )
    formatter = JsonFormatter()
    output = "\n".join(formatter.format(r) for r in caplog.records)
    for secret in (PHONE, PHONE[1:], PHONE[-7:], OTHER_PHONE[-7:], CODE, WRONG_CODE, PASSWORD):
        assert secret not in output
    for record in caplog.records:
        if record.message.startswith("phone_"):
            payload = json.loads(formatter.format(record))
            assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
                "user_id"
            }


# Fixture value only; real secrets live in Railway variables.
KEY_SECRET = "test-rate-limit-key-secret-not-real-0123"


@pytest.mark.parametrize(
    "settings",
    [
        make_settings(
            phone_otp_send_limit=SEND_LIMIT,
            phone_otp_check_limit=CHECK_LIMIT,
            rate_limit_key_secret=KEY_SECRET,
        )
    ],
)
async def test_no_raw_identifier_in_any_key(
    app: FastAPI, db_client: httpx.AsyncClient, verifier: FakeVerifier
) -> None:
    # Login (email) and phone send and check (phone), on the real Redis.
    redis = Redis.from_url(Settings().redis_url)
    prefix = f"rl-test-{uuid.uuid4().hex}"
    app.dependency_overrides[get_rate_limiter] = lambda: RedisRateLimiter(
        redis, prefix=prefix, clock=lambda: NOW
    )
    try:
        ana = await sign_up(db_client, "ana")
        await login(db_client, email="Ana@Example.com")
        await send(db_client, ana)
        await verify(db_client, ana)
        keys = sorted([k.decode() async for k in redis.scan_iter(match=f"{prefix}:*")])
    finally:
        found = [k async for k in redis.scan_iter(match=f"{prefix}:*")]
        if found:
            await redis.delete(*found)
        await redis.aclose()

    email = "ana@example.com"  # normalized before hashing
    email_key = hmac.new(KEY_SECRET.encode(), email.encode(), hashlib.sha256).hexdigest()
    phone_key = hmac.new(KEY_SECRET.encode(), PHONE.encode(), hashlib.sha256).hexdigest()
    assert keys == sorted(
        [
            f"{prefix}:auth_register:127.0.0.1:16",
            f"{prefix}:auth_login:127.0.0.1:16",
            f"{prefix}:auth_login_email:{email_key}:16",
            f"{prefix}:phone_send_user:{ana.id}:16",
            f"{prefix}:phone_send_phone:{phone_key}:16",
            f"{prefix}:phone_check_user:{ana.id}:16",
            f"{prefix}:phone_check_phone:{phone_key}:16",
        ]
    )
    # Neither the raw value, nor its plain hash, nor the development key's HMAC.
    forbidden = [email, "ana", PHONE[1:], PHONE[-7:]]
    for value in (email, PHONE):
        forbidden.append(hashlib.sha256(value.encode()).hexdigest())
        forbidden.append(hashed_identifier(value, DEVELOPMENT_HMAC_KEY))
    for key in keys:
        for value in forbidden:
            assert value not in key
