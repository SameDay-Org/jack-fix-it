"""The app-launch interest list (#409): POST /v1/interest, from the web service only, limited per
visitor address and per email, one row per email, the same answer for a repeat, nothing about
the visitor in the logs or Sentry. On the rolled-back test session."""

import logging
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.main import create_app
from app.modules.interest.models import LaunchInterest
from app.modules.interest.repository import InterestRepository
from app.observability import JsonFormatter
from app.rate_limit import IdentifierHasher, RateLimitResult, get_rate_limiter
from tests.conftest import (
    TEST_EMAIL_SETTINGS,
    TEST_JWT_SECRET,
    TEST_RATE_LIMIT_SETTINGS,
    TEST_REFRESH_SETTINGS,
    TEST_STORAGE_SETTINGS,
    TEST_STRIPE_SETTINGS,
    TEST_TWILIO_SETTINGS,
    TEST_WEB_SERVICE_SETTINGS,
    InMemoryRateLimiter,
    make_settings,
)
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads
from tests.test_sentry_scrubbing import sentry_transport as sentry_transport

KEY: Final = str(TEST_WEB_SERVICE_SETTINGS["web_service_key"])
EMAIL: Final = "probe-interest-409@example.com"
VISITOR: Final = "203.0.113.77"
SPOOFED: Final = "198.51.100.66"
CONSENT: Final = "interest-2026-11-19"
NOW: Final = datetime(2030, 3, 1, tzinfo=UTC)
PATH: Final = "/v1/interest"


@dataclass
class RecordingLimiter:
    """Allows every hit (or none), and records each: which bucket, keyed by what."""

    allowed: bool = True
    hits: list[tuple[str, str, int, int]] = field(default_factory=list)

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        self.hits.append((scope, identifier, limit, window_seconds))
        return RateLimitResult(allowed=self.allowed, retry_after_seconds=7)


def interest_app(
    session: AsyncSession, settings: Settings | None = None, limiter: object | None = None
) -> FastAPI:
    app = create_app(settings or make_settings(**TEST_WEB_SERVICE_SETTINGS))
    chosen = limiter or InMemoryRateLimiter(clock=lambda: NOW.timestamp())
    app.dependency_overrides[get_rate_limiter] = lambda: chosen

    async def same() -> AsyncIterator[AsyncSession]:
        yield session

    app.dependency_overrides[get_session] = same
    return app


@asynccontextmanager
async def client_of(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


def body(**overrides: object) -> dict[str, object]:
    return {"email": EMAIL, "locale": "es", "source": "showcase", "consent_version": CONSENT} | {
        key: value for key, value in overrides.items()
    }


def web(ip: str | None = VISITOR, key: str | None = KEY, **extra: str) -> dict[str, str]:
    headers = dict(extra)
    if key is not None:
        headers["x-jfi-web-key"] = key
    if ip is not None:
        headers["x-jfi-client-ip"] = ip
    return headers


async def rows(session: AsyncSession) -> list[LaunchInterest]:
    statement = select(LaunchInterest).execution_options(populate_existing=True)
    return list((await session.scalars(statement)).all())


@contextmanager
def counted_statements(session: AsyncSession) -> Iterator[list[str]]:
    statements: list[str] = []
    engine = session.get_bind().engine

    def record(*args: Any) -> None:
        statements.append(args[2])

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


# --- One row per email, the same answer for a repeat -------------------------------------------


async def test_a_join_is_kept_once_with_its_consent_and_a_repeat_looks_the_same(
    db_session: AsyncSession,
) -> None:
    """The email trimmed and lowercased; the consent's version and time stored. A repeat, in
    other case and with newer words, answers byte for byte what the first did, through as many
    statements, and the first consent stands."""
    app = interest_app(db_session)
    async with client_of(app) as client:
        with counted_statements(db_session) as first_statements:
            first = await client.post(PATH, json=body(email=f"  {EMAIL.upper()} "), headers=web())
        with counted_statements(db_session) as repeat_statements:
            repeat = await client.post(
                PATH, json=body(consent_version="interest-2027-01-01"), headers=web()
            )

    for answer in (first, repeat):
        assert answer.status_code == 202, answer.text
        assert answer.content == b""
        assert answer.headers["cache-control"] == "no-store"
    assert {k: v for k, v in first.headers.items() if k != "x-request-id"} == {
        k: v for k, v in repeat.headers.items() if k != "x-request-id"
    }
    assert len(first_statements) == len(repeat_statements)
    [row] = await rows(db_session)
    assert (row.email, row.locale, row.source.value, row.consent_version) == (
        EMAIL,
        "es",
        "showcase",
        CONSENT,
    )
    assert row.consented_at is not None


async def test_the_language_and_the_source_have_their_defaults(db_session: AsyncSession) -> None:
    async with client_of(interest_app(db_session)) as client:
        answer = await client.post(
            PATH, json={"email": EMAIL, "consent_version": CONSENT}, headers=web()
        )

    assert answer.status_code == 202, answer.text
    [row] = await rows(db_session)
    assert (row.locale, row.source.value) == ("en", "showcase")


# --- The web service only ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("configured", "sent"),
    [
        (True, None),  # no key
        (True, "x" * 40),  # another key
        (True, KEY[:-1]),  # almost
        (True, KEY + "x"),
        (False, KEY),  # no key configured: nobody is the web service
    ],
)
async def test_only_the_web_service_s_key_is_accepted(
    db_session: AsyncSession, configured: bool, sent: str | None
) -> None:
    """401 invalid_service_key, before the body is read: a caller without the key learns
    nothing of the validation either. Nothing stored, no limit counted."""
    settings = make_settings(**TEST_WEB_SERVICE_SETTINGS) if configured else make_settings()
    limiter = RecordingLimiter()
    async with client_of(interest_app(db_session, settings, limiter)) as client:
        answers = [
            await client.post(PATH, json=body(), headers=web(key=sent)),
            await client.post(PATH, json={"email": "not an email"}, headers=web(key=sent)),
        ]

    for answer in answers:
        assert answer.status_code == 401
        assert answer.json()["error"]["code"] == "invalid_service_key"
    assert await rows(db_session) == []
    assert limiter.hits == []


# --- The limits: the forwarded visitor, the email as a keyed hash -----------------------------


@pytest.mark.parametrize(
    ("headers", "bucket"),
    [
        # The visitor's address, whatever X-Forwarded-For a client sent.
        (web(**{"X-Forwarded-For": SPOOFED}), VISITOR),
        (web(ip=f"::ffff:{VISITOR}"), VISITOR),  # one client, one bucket
        (web(ip="2001:db8::7"), "2001:db8::7"),
        # Not one valid address: the caller's own (here, the test client's).
        (web(ip=None), "127.0.0.1"),
        (web(ip=f"{VISITOR}, {SPOOFED}"), "127.0.0.1"),
        (web(ip="not-an-address"), "127.0.0.1"),
        (web(ip=None, **{"X-Forwarded-For": SPOOFED}), "127.0.0.1"),
    ],
)
async def test_the_limits_count_the_forwarded_visitor_and_the_hashed_email(
    db_session: AsyncSession, headers: dict[str, str], bucket: str
) -> None:
    limiter = RecordingLimiter()
    settings = make_settings(**TEST_WEB_SERVICE_SETTINGS)
    async with client_of(interest_app(db_session, settings, limiter)) as client:
        answer = await client.post(PATH, json=body(), headers=headers)

    assert answer.status_code == 202, answer.text
    hashed = IdentifierHasher.from_settings(settings)(EMAIL)
    window = settings.interest_window_seconds
    assert limiter.hits == [
        ("interest_join_ip", bucket, settings.interest_ip_limit, window),
        ("interest_join_email", hashed, settings.interest_email_limit, window),
    ]
    assert EMAIL not in str(limiter.hits)


async def test_two_visitor_address_headers_are_no_address(db_session: AsyncSession) -> None:
    limiter = RecordingLimiter()
    async with client_of(interest_app(db_session, limiter=limiter)) as client:
        answer = await client.post(
            PATH,
            json=body(),
            headers=[
                ("x-jfi-web-key", KEY),
                ("x-jfi-client-ip", VISITOR),
                ("x-jfi-client-ip", SPOOFED),
            ],
        )

    assert answer.status_code == 202, answer.text
    assert limiter.hits[0][1] == "127.0.0.1"


async def test_joins_are_limited_per_visitor_and_per_email(db_session: AsyncSession) -> None:
    settings = make_settings(
        **TEST_WEB_SERVICE_SETTINGS, interest_ip_limit=2, interest_email_limit=2
    )
    async with client_of(interest_app(db_session, settings)) as client:
        same_visitor = [
            await client.post(PATH, json=body(email=f"n{n}@example.com"), headers=web())
            for n in range(3)
        ]
        other_visitor = await client.post(
            PATH, json=body(email="other@example.com"), headers=web(ip=SPOOFED)
        )
        same_email = [
            await client.post(PATH, json=body(), headers=web(ip=f"203.0.113.{n}"))
            for n in range(1, 4)
        ]

    assert [answer.status_code for answer in same_visitor] == [202, 202, 429]
    assert same_visitor[2].json()["error"]["code"] == "rate_limited"
    assert int(same_visitor[2].headers["retry-after"]) > 0
    assert other_visitor.status_code == 202
    assert [answer.status_code for answer in same_email] == [202, 202, 429]


# --- Plain text, checked ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "sent",
    [
        body(email="not an email"),
        body(email="probe@exa\x00mple.com"),
        body(email="pro\nbe@example.com"),
        body(email=("x" * 320) + "@example.com"),
        body(email=None),
        body(locale="fr"),
        body(source="app"),
        body(consent_version=""),
        body(consent_version="interest 2026"),
        body(consent_version="x" * 65),
        body(consent_version="-starts-with-a-dash"),
        body(consent_version="ünïcode"),
        {"email": EMAIL, "locale": "es", "source": "showcase"},  # no consent version
        body(name="Ana"),  # nothing but what the list keeps
    ],
)
async def test_a_body_the_list_does_not_take_is_refused(
    db_session: AsyncSession, sent: dict[str, object]
) -> None:
    async with client_of(interest_app(db_session)) as client:
        answer = await client.post(PATH, json=sent, headers=web())

    assert answer.status_code == 422
    assert answer.json()["error"]["code"] == "validation_error"
    assert EMAIL not in answer.text
    assert await rows(db_session) == []


# --- Nothing about the visitor in the logs or Sentry -----------------------------------------


async def test_no_email_or_visitor_address_is_logged(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """A join, a repeat, a refusal of each kind: the logs carry flags and codes only."""
    settings = make_settings(**TEST_WEB_SERVICE_SETTINGS, interest_ip_limit=3)
    with caplog.at_level(logging.DEBUG):
        async with client_of(interest_app(db_session, settings)) as client:
            await client.post(PATH, json=body(), headers=web())
            await client.post(PATH, json=body(), headers=web())
            await client.post(PATH, json=body(email=f"{EMAIL}x"), headers=web(key="wrong"))
            await client.post(PATH, json=body(locale="fr"), headers=web())
            await client.post(PATH, json=body(), headers=web())  # rate limited

    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    assert "interest_joined" in logs
    assert "web_service_key_refused" in logs
    for leak in (EMAIL, VISITOR, KEY):
        assert leak not in logs, leak


@pytest.mark.parametrize("failure", ["runtime_error", "check_violation"])
async def test_a_failed_write_is_a_500_that_sends_no_email_to_sentry_or_the_logs(
    db_session: AsyncSession,
    sentry_transport: MemoryTransport,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
) -> None:
    real_add = InterestRepository.add_if_new

    async def fail(self: InterestRepository, email: str, *args: Any) -> bool:
        if failure == "runtime_error":
            raise RuntimeError("probe failure")
        # The email's CHECK (lower case) refuses it: the database's error carries the value.
        return await real_add(self, email.upper(), *args)

    monkeypatch.setattr(InterestRepository, "add_if_new", fail)
    app = interest_app(db_session, make_settings(**TEST_WEB_SERVICE_SETTINGS, sentry_dsn=TEST_DSN))
    with caplog.at_level(logging.DEBUG):
        async with client_of(app) as client:
            answer = await client.post(PATH, json=body(), headers=web())
    sentry_sdk.flush()

    assert answer.status_code == 500
    assert answer.json()["error"]["code"] == "internal_error"
    payloads = _payloads(sentry_transport)
    assert any('"exception"' in payload for payload in payloads), "no event was captured"
    wire = "\n".join(payloads)
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    for leak in (EMAIL, EMAIL.upper(), VISITOR, KEY):
        assert leak not in answer.text
        assert leak not in wire, leak
        assert leak not in logs, leak


# --- The key is required where deployed -------------------------------------------------------


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_the_web_service_key_is_required_where_deployed(app_env: str) -> None:
    deployed: dict[str, object] = {
        "app_env": app_env,
        "jwt_secret": TEST_JWT_SECRET,
        **TEST_STORAGE_SETTINGS,
        **TEST_TWILIO_SETTINGS,
        **TEST_RATE_LIMIT_SETTINGS,
        **TEST_REFRESH_SETTINGS,
        **TEST_EMAIL_SETTINGS,
        **TEST_STRIPE_SETTINGS,
    }
    short = "s" * 31
    with pytest.raises(ValidationError, match="WEB_SERVICE_KEY") as missing:
        make_settings(**deployed)
    with pytest.raises(ValidationError, match="WEB_SERVICE_KEY"):
        make_settings(**deployed, web_service_key="")
    with pytest.raises(ValidationError, match="WEB_SERVICE_KEY") as too_short:
        make_settings(**deployed, web_service_key=short)

    assert short not in str(too_short.value)
    assert "32 characters" in str(missing.value)
    settings = make_settings(**deployed, **TEST_WEB_SERVICE_SETTINGS)
    assert KEY not in repr(settings)
