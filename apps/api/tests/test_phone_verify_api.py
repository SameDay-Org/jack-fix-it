"""Phone verification by SMS code over HTTP (D4.3 phone, #26). Never calls Twilio."""

import hashlib
import json
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.sms_verify import (
    InvalidPhoneError,
    VerificationUnavailableError,
    get_phone_verifier,
)
from app.modules.users.models import User
from app.observability import JsonFormatter
from app.rate_limit import RedisRateLimiter, get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_app, make_settings
from tests.test_auth_api import PASSWORD, register

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

    async def start(self, phone: str) -> None:
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


async def test_send_invalid_number_for_sms_is_422(
    db_client: httpx.AsyncClient, verifier: FakeVerifier
) -> None:
    ana = await sign_up(db_client, "ana")
    verifier.error = InvalidPhoneError()

    response = await send(db_client, ana)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


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


@pytest.mark.parametrize("route", ["send", "verify"])
async def test_provider_down_is_503(
    db_client: httpx.AsyncClient,
    verifier: FakeVerifier,
    caplog: pytest.LogCaptureFixture,
    route: str,
) -> None:
    ana = await sign_up(db_client, "ana")
    verifier.error = VerificationUnavailableError()

    with caplog.at_level(logging.INFO):
        response = await (send(db_client, ana) if route == "send" else verify(db_client, ana))

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


async def test_rate_limit_keys_hash_the_phone(
    app: FastAPI, db_client: httpx.AsyncClient, verifier: FakeVerifier
) -> None:
    redis = Redis.from_url(Settings().redis_url)
    prefix = f"rl-test-{uuid.uuid4().hex}"
    app.dependency_overrides[get_rate_limiter] = lambda: RedisRateLimiter(
        redis, prefix=prefix, clock=lambda: NOW
    )
    try:
        ana = await sign_up(db_client, "ana")
        await send(db_client, ana)
        await verify(db_client, ana)
        # Only the phone limits; sign-up has its own per-IP key.
        keys = sorted([k.decode() async for k in redis.scan_iter(match=f"{prefix}:phone_*")])
    finally:
        found = [k async for k in redis.scan_iter(match=f"{prefix}:*")]
        if found:
            await redis.delete(*found)
        await redis.aclose()

    digest = hashlib.sha256(PHONE.encode()).hexdigest()
    assert keys == sorted(
        [
            f"{prefix}:phone_send_user:{ana.id}:16",
            f"{prefix}:phone_send_phone:{digest}:16",
            f"{prefix}:phone_check_user:{ana.id}:16",
            f"{prefix}:phone_check_phone:{digest}:16",
        ]
    )
    for key in keys:
        assert PHONE[1:] not in key
        assert PHONE[-7:] not in key
