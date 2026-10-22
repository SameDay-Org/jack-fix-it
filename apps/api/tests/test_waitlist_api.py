"""POST /v1/waitlist: out-of-area contacts (D8.3, #46)."""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.auth import security
from app.modules.categories.models import Category
from app.modules.categories.service import CategoryService
from app.modules.service_areas.models import ServiceArea
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.modules.waitlist.models import WaitlistEntry
from app.modules.waitlist.service import WaitlistService
from app.observability import JsonFormatter
from app.rate_limit import DEVELOPMENT_HMAC_KEY, get_rate_limiter, hashed_identifier
from tests.conftest import TEST_JWT_SECRET, InMemoryRateLimiter, make_settings

# Fixture values only: no real ZIP, region or contact.
UNSERVED = "00009"
SERVED = "00001"
EMAIL = "ana.wait@example.com"
PHONE = "+14075550123"
JOIN_LIMIT = 4  # not the default (5), so the tests prove it comes from settings
NOW = 1_000.0
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}


@pytest.fixture
def settings() -> Settings:
    return make_settings(waitlist_join_limit=JOIN_LIMIT, auth_rate_limit_requests=100)


@pytest.fixture(autouse=True)
async def setup(app: FastAPI, db_session: AsyncSession) -> None:
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    db_session.add(ServiceArea(region="Test Region", city="Testville", state="ZZ", zip_code=SERVED))
    await db_session.flush()


async def join(
    client: httpx.AsyncClient, headers: dict[str, str] | None = None, **body: Any
) -> httpx.Response:
    values: dict[str, Any] = {"zip_code": UNSERVED, "email": EMAIL, "source": "web"}
    values.update(body)
    values = {key: value for key, value in values.items() if value is not None}
    return await client.post("/v1/waitlist", json=values, headers=headers or {})


async def entries(session: AsyncSession) -> list[WaitlistEntry]:
    statement = (
        select(WaitlistEntry)
        .order_by(WaitlistEntry.created_at, WaitlistEntry.zip_code, WaitlistEntry.email)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def make_category(session: AsyncSession, *, active: bool = True) -> uuid.UUID:
    category = Category(
        slug=f"test-{uuid.uuid4().hex[:8]}", names={"en": "Test", "es": "Prueba"}, active=active
    )
    session.add(category)
    await session.flush()
    return category.id


async def test_email_or_phone_required(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await join(db_client, email=None)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await entries(db_session) == []


async def test_served_zip_409(db_client: httpx.AsyncClient, db_session: AsyncSession) -> None:
    for zip_code in (SERVED, f"{SERVED}-1234"):
        response = await join(db_client, zip_code=zip_code)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "zip_served"
    assert await entries(db_session) == []


async def test_same_contact_same_zip_not_duplicated_and_202(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    category = await make_category(db_session)

    first = await join(db_client, locale="en")
    again = await join(db_client, email=EMAIL.upper(), locale="es", category_id=str(category))
    by_phone = await join(db_client, email=None, phone=PHONE, source="app")
    both = await join(db_client, phone=PHONE)  # two entries, one per contact: neither merges

    for response in (first, again, by_phone, both):
        assert response.status_code == 202
        assert response.content == b""
    assert first.headers.keys() == again.headers.keys()
    rows = await entries(db_session)
    by_contact = {(row.email, row.phone): row for row in rows}
    assert set(by_contact) == {(EMAIL, None), (None, PHONE)}
    email_entry = by_contact[(EMAIL, None)]
    assert (email_entry.locale, email_entry.category_id) == ("en", category)
    assert email_entry.zip_code == UNSERVED


async def test_one_entry_learns_the_other_contact(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await join(db_client)

    await join(db_client, phone=PHONE, locale="es")

    [entry] = await entries(db_session)
    assert (entry.email, entry.phone, entry.locale) == (EMAIL, PHONE, "es")


async def test_different_zip_creates_new(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await join(db_client, zip_code=UNSERVED)
    await join(db_client, zip_code="00010-1234")

    rows = await entries(db_session)
    assert sorted(row.zip_code for row in rows) == ["00009", "00010"]


async def test_signed_in_links_user_id(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user = User(email="pro-wait@example.com", password_hash="x", role=UserRole.PRO)
    db_session.add(user)
    await db_session.flush()
    access = security.create_access_token(
        user_id=user.id,
        role=user.role,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )

    signed_in = await join(db_client, headers={"Authorization": f"Bearer {access}"})
    bad_token = await join(
        db_client, headers={"Authorization": "Bearer not-a-token"}, email="other@example.com"
    )

    assert signed_in.status_code == bad_token.status_code == 202
    rows = {row.email: row for row in await entries(db_session)}
    assert rows[EMAIL].user_id == user.id
    assert rows["other@example.com"].user_id is None


@pytest.mark.parametrize(
    "body",
    [
        {"phone": "+447911123456", "email": None},
        {"phone": "4075550123", "email": None},
        {"zip_code": "0009"},
        {"email": "not-an-email"},
        {"source": "sms"},
        {"locale": "fr"},
        {"name": "Ana"},
    ],
    ids=[
        "country_not_allowed",
        "not_e164",
        "bad_zip",
        "bad_email",
        "bad_source",
        "bad_locale",
        "extra_field",
    ],
)
async def test_invalid_phone_or_category_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, body: dict[str, Any]
) -> None:
    response = await join(db_client, **body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await entries(db_session) == []


@pytest.mark.parametrize("active", [False, None], ids=["inactive", "unknown"])
async def test_inactive_or_unknown_category_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, active: bool | None
) -> None:
    category = await make_category(db_session, active=False) if active is False else uuid.uuid4()

    response = await join(db_client, category_id=str(category))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_category"


async def test_rate_limited(app: FastAPI, db_client: httpx.AsyncClient) -> None:
    for n in range(JOIN_LIMIT):
        assert (await join(db_client, zip_code=f"0002{n}")).status_code == 202
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False, client=("203.0.113.7", 1))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as other_ip:
        # Per contact: the same email is limited from another IP too.
        per_contact = await join(other_ip, zip_code="00030")
        fresh = await join(other_ip, zip_code="00030", email="someone@example.com")
    # Per IP: the first IP is limited even for another contact.
    per_ip = await join(db_client, email="someone.else@example.com")

    assert fresh.status_code == 202
    for response in (per_contact, per_ip):
        assert response.status_code == 429
        assert response.json()["error"]["code"] == "rate_limited"


async def test_no_contact_in_logs(
    db_client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        await join(db_client, phone=PHONE)
        await join(db_client, zip_code=SERVED)

    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for secret in (EMAIL, "ana.wait", PHONE, PHONE[1:], UNSERVED):
        assert secret not in output
    for contact in (EMAIL, PHONE):
        assert hashed_identifier(contact, DEVELOPMENT_HMAC_KEY) not in output
    [record] = [r for r in caplog.records if r.message == "waitlist_joined"]
    assert getattr(record, "zip_prefix", None) == UNSERVED[:3]


async def test_entries_for_zip_lists_pending_contacts(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    await join(db_client)
    await join(db_client, email=None, phone=PHONE, locale="es")
    await join(db_client, zip_code="00010", email="else@example.com")
    [notified] = [e for e in await entries(db_session) if e.phone == PHONE]
    notified.notified_at = datetime.now(UTC)
    await db_session.flush()

    service = WaitlistService(
        db_session, ServiceAreaService(db_session), CategoryService(db_session), ["+1"]
    )
    contacts = await service.entries_for_zip(f"{UNSERVED}-0000")

    assert [(c.email, c.phone, c.locale) for c in contacts] == [(EMAIL, None, "en")]
