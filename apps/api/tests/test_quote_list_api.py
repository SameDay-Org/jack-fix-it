"""GET /v1/requests/{request_id}/quotes: the customer compares quotes (D10.1, #188)."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth import security
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.schemas import CustomerQuote, CustomerQuoteList, QuotePro
from app.modules.requests.models import RequestStatus
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.conftest import TEST_JWT_SECRET
from tests.test_opportunities_api import (
    EMAIL,
    NOT_FOUND,
    PHONE,
    World,
    build_world,
    make_pro,
    make_request,
)
from tests.test_requests_api import make_caller

FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
INVALID_TOKEN = {
    "error": {
        "code": "invalid_token",
        "message": "The access token is missing, invalid or expired.",
    }
}
T0 = datetime(2026, 10, 20, 12, tzinfo=UTC)
PRO_PHONE = "+13055550199"
STRIPE_ID = "acct_probe188stripe"
PHOTO_KEY = "u/probe-photo-owner/profile_photo/probe188.jpg"
ITEM_KEYS = {
    "id",
    "amount_cents",
    "scope",
    "duration_minutes",
    "proposed_start_at",
    "expires_at",
    "status",
    "created_at",
    "pro",
}
PRO_KEYS = {"id", "name", "rating_avg", "jobs_count", "years_of_experience", "verified"}


@dataclass(frozen=True)
class QuotingPro:
    profile_id: uuid.UUID
    user_id: uuid.UUID
    email: str


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


def path(request_id: uuid.UUID) -> str:
    return f"/v1/requests/{request_id}/quotes"


def headers_for(user_id: uuid.UUID, role: UserRole) -> dict[str, str]:
    token = security.create_access_token(
        user_id=user_id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return {"Authorization": f"Bearer {token}"}


def customer(world: World) -> dict[str, str]:
    return headers_for(world.customer_id, UserRole.CUSTOMER)


async def quoting_pro(
    session: AsyncSession,
    *,
    first_name: str | None = "María",
    last_name: str | None = "Pérez",
    rating: str | None = None,
    jobs_count: int = 0,
    years: int | None = None,
    verification: ProVerificationStatus = ProVerificationStatus.APPROVED,
) -> QuotingPro:
    """A pro with every private field filled, so a leak would show."""
    pro = await make_pro(session)
    user = await session.get(User, pro.caller.id)
    profile = await session.get(ProProfile, pro.profile_id)
    assert user is not None
    assert profile is not None
    user.first_name, user.last_name = first_name, last_name
    user.phone = PRO_PHONE if not await _phone_taken(session) else None
    profile.rating_avg = Decimal(rating) if rating is not None else None
    profile.jobs_count = jobs_count
    profile.years_of_experience = years
    profile.verification_status = verification
    profile.bio = "probe-bio-188"
    profile.photo_key = f"{PHOTO_KEY}-{pro.profile_id.hex}"
    profile.stripe_account_id = f"{STRIPE_ID}-{pro.profile_id.hex}"
    await session.flush()
    return QuotingPro(pro.profile_id, user.id, user.email)


async def _phone_taken(session: AsyncSession) -> bool:
    """users.phone is unique: only the first pro of a test carries PRO_PHONE."""
    return (await session.scalar(select(User.id).where(User.phone == PRO_PHONE))) is not None


async def add_quote(
    session: AsyncSession,
    request_id: uuid.UUID,
    pro: QuotingPro,
    *,
    amount: int = 10_000,
    status: QuoteStatus = QuoteStatus.PENDING,
    expires_in: timedelta = timedelta(hours=24),
    created_at: datetime = T0,
    scope: str = "Replace the faucet",
) -> uuid.UUID:
    """created_at is set: rows flushed in one transaction would otherwise share now()."""
    quote = Quote(
        request_id=request_id,
        pro_id=pro.profile_id,
        amount_cents=amount,
        scope=scope,
        duration_minutes=90,
        proposed_start_at=datetime.now(UTC) + timedelta(days=2),
        expires_at=datetime.now(UTC) + expires_in,
        status=status,
        created_at=created_at,
    )
    session.add(quote)
    await session.flush()
    return quote.id


async def listed_ids(
    client: httpx.AsyncClient, world: World, request_id: uuid.UUID
) -> list[uuid.UUID]:
    response = await client.get(path(request_id), headers=customer(world))
    assert response.status_code == 200, response.text
    return [uuid.UUID(item["id"]) for item in response.json()["items"]]


# What is listed, in what order


async def test_owner_sees_open_quotes_cheapest_first(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pros = [await quoting_pro(db_session) for _ in range(4)]
    dear = await add_quote(db_session, request_id, pros[0], amount=30_000, created_at=T0)
    tie_late = await add_quote(
        db_session, request_id, pros[1], amount=15_000, created_at=T0 + timedelta(minutes=5)
    )
    cheap = await add_quote(
        db_session, request_id, pros[2], amount=9_000, created_at=T0 + timedelta(hours=1)
    )
    tie_early = await add_quote(
        db_session, request_id, pros[3], amount=15_000, created_at=T0 + timedelta(minutes=1)
    )

    response = await db_client.get(path(request_id), headers=customer(world))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"items"}
    assert [uuid.UUID(item["id"]) for item in body["items"]] == [cheap, tie_early, tie_late, dear]
    first = body["items"][0]
    assert set(first) == ITEM_KEYS
    assert set(first["pro"]) == PRO_KEYS
    assert (first["amount_cents"], first["duration_minutes"], first["status"]) == (
        9_000,
        90,
        "pending",
    )
    assert first["pro"]["id"] == str(pros[2].profile_id)
    # Stable: the same order on every read.
    assert await listed_ids(db_client, world, request_id) == [cheap, tie_early, tie_late, dear]


async def test_full_tie_is_broken_by_id(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    ids = [
        await add_quote(db_session, request_id, await quoting_pro(db_session), amount=5_000)
        for _ in range(3)
    ]

    assert await listed_ids(db_client, world, request_id) == sorted(ids)


async def test_expired_by_time_is_left_out(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    live = await add_quote(db_session, request_id, await quoting_pro(db_session))
    # Still "pending" in the table (no expiry worker yet, #51), but past its expires_at.
    await add_quote(
        db_session, request_id, await quoting_pro(db_session), expires_in=-timedelta(seconds=1)
    )

    assert await listed_ids(db_client, world, request_id) == [live]


async def test_closed_quotes_are_left_out(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    live = await add_quote(db_session, request_id, await quoting_pro(db_session), amount=99_000)
    for status in (QuoteStatus.REJECTED, QuoteStatus.EXPIRED, QuoteStatus.WITHDRAWN):
        # Cheaper and not yet past expires_at: only the status leaves them out.
        await add_quote(
            db_session, request_id, await quoting_pro(db_session), amount=1_000, status=status
        )

    assert await listed_ids(db_client, world, request_id) == [live]


async def test_accepted_request_keeps_its_quote_screen(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.ACCEPTED)
    # The accepted quote stays listed past its expires_at: it is no longer an offer.
    accepted = await add_quote(
        db_session,
        request_id,
        await quoting_pro(db_session),
        amount=20_000,
        status=QuoteStatus.ACCEPTED,
        expires_in=-timedelta(hours=1),
    )
    pending = await add_quote(db_session, request_id, await quoting_pro(db_session), amount=12_000)
    await add_quote(
        db_session,
        request_id,
        await quoting_pro(db_session),
        amount=11_000,
        expires_in=-timedelta(seconds=1),
    )
    await add_quote(
        db_session,
        request_id,
        await quoting_pro(db_session),
        amount=10_000,
        status=QuoteStatus.REJECTED,
    )

    response = await db_client.get(path(request_id), headers=customer(world))

    assert response.status_code == 200
    items = response.json()["items"]
    assert [(uuid.UUID(i["id"]), i["status"]) for i in items] == [
        (pending, "pending"),
        (accepted, "accepted"),
    ]


@pytest.mark.parametrize(
    "status",
    [
        RequestStatus.RECEIVED,
        RequestStatus.REVIEWING,
        RequestStatus.FINDING_PRO,
        RequestStatus.EXPIRED,
        RequestStatus.CANCELLED,
    ],
)
async def test_request_without_quotes_is_an_empty_list(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, status: RequestStatus
) -> None:
    request_id = await make_request(db_session, world, status)
    # A live pending quote left on the request (nothing closes quotes on a cancelled or
    # expired request yet): the quote screen is gone, so it is not listed.
    await add_quote(db_session, request_id, await quoting_pro(db_session))

    response = await db_client.get(path(request_id), headers=customer(world))

    assert response.status_code == 200
    assert response.json() == {"items": []}


async def test_quote_ready_without_open_quotes_is_an_empty_list(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)

    assert await listed_ids(db_client, world, request_id) == []


async def test_other_requests_quotes_are_not_listed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    mine = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    other = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session)
    listed = await add_quote(db_session, mine, pro)
    await add_quote(db_session, other, pro)

    assert await listed_ids(db_client, world, mine) == [listed]


# Who may read


async def test_strangers_get_404_like_unknown(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    await add_quote(db_session, request_id, await quoting_pro(db_session))
    stranger = await make_caller(db_session, UserRole.CUSTOMER)

    foreign = await db_client.get(path(request_id), headers=stranger.headers)
    unknown = await db_client.get(path(uuid.uuid4()), headers=customer(world))

    assert (foreign.status_code, unknown.status_code) == (404, 404)
    assert foreign.json() == unknown.json() == NOT_FOUND
    assert foreign.content == unknown.content


async def test_non_customers_are_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    quoting = await quoting_pro(db_session)
    await add_quote(db_session, request_id, quoting)
    admin = await make_caller(db_session, UserRole.ADMIN)
    callers = [
        headers_for(quoting.user_id, UserRole.PRO),  # even the pro who quoted
        headers_for(world.agent_id, UserRole.AGENT),
        admin.headers,
    ]

    for headers in callers:
        response = await db_client.get(path(request_id), headers=headers)
        assert response.status_code == 403
        assert response.json() == FORBIDDEN


async def test_unauthenticated_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)

    for headers in ({}, {"Authorization": "Bearer not-a-token"}):
        response = await db_client.get(path(request_id), headers=headers)
        assert response.status_code == 401
        assert response.json() == INVALID_TOKEN


async def test_malformed_id_422(db_client: httpx.AsyncClient, world: World) -> None:
    response = await db_client.get("/v1/requests/not-a-uuid/quotes", headers=customer(world))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# What the customer sees of the scope and the pro


async def test_scope_is_redacted_with_the_pros_own_contacts(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session)
    local, domain = pro.email.split("@")
    spaced_email = f"{local.upper()} @ {domain.replace('.', ' . ')}"
    scope = (
        f"Install a 6 inch duct for $120. Email {spaced_email} or text 305 555 0199, "
        "also 30 55 55 01 99, or call me at 786-555-0100."
    )
    quote_id = await add_quote(db_session, request_id, pro, scope=scope)

    response = await db_client.get(path(request_id), headers=customer(world))

    assert response.status_code == 200
    shown = response.json()["items"][0]["scope"]
    assert shown == (
        "Install a 6 inch duct for $120. Email ••• or text •••, also •••, or call me at •••."
    )
    stored = await db_session.scalar(
        select(Quote.scope).where(Quote.id == quote_id).execution_options(populate_existing=True)
    )
    assert stored == scope


async def test_known_values_are_the_quoting_pros_not_another_pros(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """A phone grouped as "30 55 55 01 99" is no pattern (app.redaction known gaps): only the
    known-value pass masks it, and only with the phone of the pro who wrote it."""
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    with_phone = await quoting_pro(db_session)  # the first pro of the test holds PRO_PHONE
    without_phone = await quoting_pro(db_session)
    scope = "Same day, 30 55 55 01 99"
    await add_quote(db_session, request_id, with_phone, scope=scope, amount=1_000)
    await add_quote(db_session, request_id, without_phone, scope=scope, amount=2_000)

    response = await db_client.get(path(request_id), headers=customer(world))

    assert [item["scope"] for item in response.json()["items"]] == ["Same day, •••", scope]


async def test_no_pro_contact_or_internal_field_leaks(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session, rating="4.5", jobs_count=3, years=7)
    await add_quote(db_session, request_id, pro, scope="Clean the drain")

    response = await db_client.get(path(request_id), headers=customer(world))

    assert response.status_code == 200
    document = response.json()
    secrets = (
        pro.email,
        PRO_PHONE,
        PRO_PHONE.removeprefix("+1"),
        str(pro.user_id),
        pro.user_id.hex,
        STRIPE_ID,
        PHOTO_KEY,
        "probe-bio-188",
        "Pérez",  # the full last name: only its initial is public
        EMAIL,  # nor the customer's own details
        PHONE,
        str(world.customer_id),
    )
    for value in _values(document):
        for secret in secrets:
            assert secret not in value, secret
    for secret in secrets:
        assert secret not in response.text, secret
    keys = _keys(document)
    for key in (
        "user_id",
        "email",
        "phone",
        "stripe_account_id",
        "payouts_enabled",
        "photo_key",
        "photo",
        "bio",
        "documents",
        "verification_status",
        "pro_id",
        "request_id",
        "customer_id",
    ):
        assert key not in keys, key


async def test_pro_fields(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    rated = await quoting_pro(db_session, rating="4.8", jobs_count=12, years=9)
    new = await quoting_pro(db_session, last_name=None)
    unnamed = await quoting_pro(db_session, first_name=None, last_name=None)
    pending = await quoting_pro(db_session, verification=ProVerificationStatus.PENDING)
    await add_quote(db_session, request_id, rated, amount=1_000)
    await add_quote(db_session, request_id, new, amount=2_000)
    await add_quote(db_session, request_id, unnamed, amount=3_000)
    await add_quote(db_session, request_id, pending, amount=4_000)

    response = await db_client.get(path(request_id), headers=customer(world))

    pros = [item["pro"] for item in response.json()["items"]]
    assert pros == [
        {
            "id": str(rated.profile_id),
            "name": "María P.",
            "rating_avg": "4.80",
            "jobs_count": 12,
            "years_of_experience": 9,
            "verified": True,
        },
        {
            "id": str(new.profile_id),
            "name": None,
            "rating_avg": None,
            "jobs_count": 0,
            "years_of_experience": None,
            "verified": True,
        },
        {
            "id": str(unnamed.profile_id),
            "name": None,
            "rating_avg": None,
            "jobs_count": 0,
            "years_of_experience": None,
            "verified": True,
        },
        {
            "id": str(pending.profile_id),
            "name": "María P.",
            "rating_avg": None,
            "jobs_count": 0,
            "years_of_experience": None,
            "verified": False,
        },
    ]


async def test_quote_fields_round_trip(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    quote_id = await add_quote(db_session, request_id, await quoting_pro(db_session), amount=4_321)
    stored = await db_session.get(Quote, quote_id)
    assert stored is not None

    [item] = (await db_client.get(path(request_id), headers=customer(world))).json()["items"]

    assert item["amount_cents"] == 4_321
    assert datetime.fromisoformat(item["proposed_start_at"]) == stored.proposed_start_at
    assert datetime.fromisoformat(item["expires_at"]) == stored.expires_at
    assert datetime.fromisoformat(item["created_at"]) == stored.created_at == T0


# Cost


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


async def test_constant_query_count(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    one = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    five = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pros = [await quoting_pro(db_session) for _ in range(5)]
    await add_quote(db_session, one, pros[0])
    for n, pro in enumerate(pros):
        await add_quote(db_session, five, pro, amount=1_000 + n)

    counts: list[int] = []
    for request_id, expected in ((one, 1), (five, 5)):
        db_session.expunge_all()  # nothing served from the identity map
        with counted_statements(db_session) as statements:
            response = await db_client.get(path(request_id), headers=customer(world))
        assert len(response.json()["items"]) == expected
        counts.append(len(statements))

    # The caller's account, the request, its quotes, the pros, their names, their contacts.
    assert counts == [6, 6]


# The contract


def test_response_models_forbid_extra_fields() -> None:
    pro = {
        "id": str(uuid.uuid4()),
        "name": None,
        "rating_avg": None,
        "jobs_count": 0,
        "years_of_experience": None,
        "verified": True,
    }
    item = {
        "id": str(uuid.uuid4()),
        "amount_cents": 1,
        "scope": "x",
        "duration_minutes": 1,
        "proposed_start_at": T0.isoformat(),
        "expires_at": T0.isoformat(),
        "status": "pending",
        "created_at": T0.isoformat(),
        "pro": pro,
    }
    CustomerQuoteList.model_validate({"items": [item]})
    for model, document in (
        (QuotePro, {**pro, "user_id": "x"}),
        (CustomerQuote, {**item, "pro_id": "x"}),
        (CustomerQuoteList, {"items": [], "next_cursor": None}),
    ):
        with pytest.raises(ValueError, match="Extra inputs are not permitted"):
            model.model_validate(document)


def test_openapi_documents_the_route(app: FastAPI) -> None:
    schema = app.openapi()
    operation = schema["paths"]["/v1/requests/{request_id}/quotes"]["get"]

    assert {"200", "401", "403", "404"} <= set(operation["responses"])
    assert "not_found" in operation["responses"]["404"]["description"]
    assert "forbidden" in operation["responses"]["403"]["description"]
    assert operation["tags"] == ["quotes"]
    components = schema["components"]["schemas"]
    assert set(components["CustomerQuote"]["properties"]) == ITEM_KEYS
    assert set(components["QuotePro"]["properties"]) == PRO_KEYS


def _keys(value: object) -> set[str]:
    """Every key anywhere in a JSON document."""
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in _keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in _keys(item)}
    return set()


def _values(value: object) -> list[str]:
    """Every scalar anywhere in a JSON document, as text."""
    if isinstance(value, dict):
        return [text for item in value.values() for text in _values(item)]
    if isinstance(value, list):
        return [text for item in value for text in _values(item)]
    return [str(value)]
