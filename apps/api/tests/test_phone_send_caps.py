"""The phone code's daily caps and region check (#526, found by the #96 review).

Each code is a paid SMS, so beyond the per-minute limits one account, one number and one number
range (its first PHONE_OTP_PREFIX_LENGTH characters, as SMS pumping rotates through a range)
each get a daily budget, which fails closed. And +1 is shared by the US, Canada and the
Caribbean and Atlantic islands: the numbers of those other countries are refused by prefix
(PHONE_EXCLUDED_PREFIXES) before Twilio is called.
"""

from dataclasses import dataclass

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from redis.exceptions import RedisError

from app.config import Settings
from app.integrations.sms_verify import get_phone_verifier
from app.modules.auth.errors import InvalidPhoneNumberError
from app.modules.auth.phone_service import PhoneVerificationService
from app.rate_limit import RateLimitResult, get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.test_phone_verify_api import FakeVerifier, send, sign_up

DAILY_LIMIT = 2
PREFIX_LIMIT = 3
DAY = 86_400
START = 100 * DAY  # the first second of a UTC day, so the hops below stay in that day
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
INVALID = {"error": {"code": "validation_error", "message": "The request is invalid."}}
UNAVAILABLE = {
    "error": {
        "code": "verification_unavailable",
        "message": "Phone verification is unavailable right now. Try again later.",
    }
}


@dataclass
class Clock:
    now: float = START

    def __call__(self) -> float:
        return self.now

    def next_minute(self) -> None:
        """Past every per-minute window, inside the same day."""
        self.now += 120


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        phone_otp_send_daily_limit=DAILY_LIMIT, phone_otp_send_daily_prefix_limit=PREFIX_LIMIT
    )


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def verifier(app: FastAPI, clock: Clock) -> FakeVerifier:
    fake = FakeVerifier()
    app.dependency_overrides[get_phone_verifier] = lambda: fake
    limiter = InMemoryRateLimiter(clock=clock)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return fake


# The region


@pytest.mark.parametrize(
    "phone", ["+18765550123", "+18095550123", "+12425550123", "+14415550123"]
)  # Jamaica, Dominican Republic, Bahamas, Bermuda
async def test_a_number_of_another_country_on_plus_one_is_refused(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, phone: str
) -> None:
    caller = await sign_up(db_client, "caribbean")

    response = await send(db_client, caller, phone)

    assert (response.status_code, response.json()) == (422, INVALID)
    assert verifier.started == []


@pytest.mark.parametrize(
    "phone", ["+13055550123", "+14165550123", "+17875550123"]
)  # Miami, Toronto, Puerto Rico (US)
async def test_us_and_canadian_numbers_get_a_code(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, phone: str
) -> None:
    caller = await sign_up(db_client, "home")

    response = await send(db_client, caller, phone)

    assert response.status_code == 202
    assert verifier.started == [phone]


async def test_the_excluded_prefixes_come_from_settings() -> None:
    """The list replaces the defaults: the region is configuration, not code."""
    settings = make_settings(phone_excluded_prefixes="+1407")
    service = PhoneVerificationService(
        None,  # type: ignore[arg-type]  # the refusal comes before any query
        None,  # type: ignore[arg-type]
        FakeVerifier(),
        settings.phone_allowed_country_codes,
        settings.phone_excluded_prefixes,
    )

    with pytest.raises(InvalidPhoneNumberError):
        await service.prepare_send(None, "+14075550123")  # type: ignore[arg-type]
    assert settings.phone_excluded_prefixes == ["+1407"]
    defaults = make_settings().phone_excluded_prefixes
    assert {"+1876", "+1809", "+1829", "+1849", "+1242"} <= set(defaults)
    assert not {"+1305", "+1407", "+1416", "+1787"} & set(defaults)


@pytest.mark.parametrize("value", ["1876", "+1-876", "+", "+1876,abc"])
def test_an_excluded_prefix_must_be_a_number_prefix(value: str) -> None:
    with pytest.raises(ValidationError, match="PHONE_EXCLUDED_PREFIXES"):
        make_settings(phone_excluded_prefixes=value)


# The daily caps


async def test_one_account_gets_the_daily_number_of_codes(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, clock: Clock
) -> None:
    caller = await sign_up(db_client, "daily-user")

    sent = []
    for n in range(DAILY_LIMIT):
        sent.append((await send(db_client, caller, f"+1407555{n:04d}")).status_code)
        clock.next_minute()
    over = await send(db_client, caller, "+13055559999")

    assert sent == [202] * DAILY_LIMIT
    assert (over.status_code, over.json()) == (429, RATE_LIMITED)
    assert int(over.headers["Retry-After"]) > 120  # the day's window, not a minute's
    assert len(verifier.started) == DAILY_LIMIT


async def test_one_number_gets_the_daily_number_of_codes_across_accounts(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, clock: Clock
) -> None:
    phone = "+14075550123"
    callers = [await sign_up(db_client, f"daily-phone-{n}") for n in range(DAILY_LIMIT + 1)]

    statuses = []
    for caller in callers:
        statuses.append((await send(db_client, caller, phone)).status_code)
        clock.next_minute()

    assert statuses == [202] * DAILY_LIMIT + [429]
    assert verifier.started == [phone] * DAILY_LIMIT


async def test_one_number_range_gets_the_daily_number_of_codes(
    db_client: httpx.AsyncClient, verifier: FakeVerifier, clock: Clock
) -> None:
    """Numbers that share their first PHONE_OTP_PREFIX_LENGTH characters (+1 305 555 by
    default) share a budget, whichever account asks."""
    first = await sign_up(db_client, "range-a")
    second = await sign_up(db_client, "range-b")
    third = await sign_up(db_client, "range-c")
    plan = [(first, "+13055550001"), (first, "+13055550002"), (second, "+13055550003")]

    statuses = []
    for caller, phone in plan:
        statuses.append((await send(db_client, caller, phone)).status_code)
        clock.next_minute()
    over = await send(db_client, third, "+13055550004")
    elsewhere = await send(db_client, third, "+13055560004")

    assert statuses == [202] * PREFIX_LIMIT
    assert (over.status_code, over.json()) == (429, RATE_LIMITED)
    assert elsewhere.status_code == 202  # another range
    assert len(verifier.started) == PREFIX_LIMIT + 1


class DailyCountDown:
    """The per-minute counts work; the daily ones cannot be taken."""

    def __init__(self, clock: Clock) -> None:
        self.inner = InMemoryRateLimiter(clock=clock)

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        if scope.startswith("phone_send_daily"):
            raise RedisError("down")
        return await self.inner.hit(scope, identifier, limit=limit, window_seconds=window_seconds)


async def test_the_daily_caps_fail_closed(
    app: FastAPI, db_client: httpx.AsyncClient, verifier: FakeVerifier, clock: Clock
) -> None:
    limiter = DailyCountDown(clock)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    caller = await sign_up(db_client, "closed")

    response = await send(db_client, caller)

    assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert verifier.started == []


def test_the_send_documents_the_caps(app: FastAPI) -> None:
    responses = app.openapi()["paths"]["/v1/auth/phone/send"]["post"]["responses"]

    assert "verification_unavailable" in responses["503"]["description"]
    assert "rate_limited" in responses["429"]["description"]
    assert "range" in responses["422"]["description"]
