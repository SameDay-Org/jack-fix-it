"""GET /v1/requests/{request_id}/quotes/{quote_id}/pro: the customer reads the public profile of
a pro who quoted their request (D10.2, #53)."""

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.models import Category
from app.modules.pros.models import (
    ProCategory,
    ProDocument,
    ProDocumentType,
    ProProfile,
    ProServiceArea,
    ProVerificationStatus,
)
from app.modules.quotes.models import QuoteStatus
from app.modules.quotes.schemas import ProPublicProfile
from app.modules.requests.models import RequestStatus
from app.modules.service_areas.models import ServiceArea
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.test_opportunities_api import EMAIL, NOT_FOUND, PHONE, World, build_world, make_request
from tests.test_quote_list_api import (
    FORBIDDEN,
    INVALID_TOKEN,
    PHOTO_KEY,
    PRO_KEYS,
    PRO_PHONE,
    STRIPE_ID,
    QuotingPro,
    add_quote,
    counted_statements,
    customer,
    headers_for,
    listed_ids,
    quoting_pro,
)
from tests.test_requests_api import RecordingQueue, make_caller

PROFILE_KEYS = PRO_KEYS | {"bio", "categories", "member_since"}
CATEGORY_KEYS = {"id", "slug", "names"}
DOCUMENT_KEY = "u/probe-doc-owner/pro_document/probe53"


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """QuoteService takes the new quote push's queue (#55): recorded, never Redis."""
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


def profile_path(request_id: uuid.UUID, quote_id: uuid.UUID) -> str:
    return f"/v1/requests/{request_id}/quotes/{quote_id}/pro"


async def profile_of(
    client: httpx.AsyncClient, world: World, request_id: uuid.UUID, quote_id: uuid.UUID
) -> httpx.Response:
    return await client.get(profile_path(request_id, quote_id), headers=customer(world))


async def edit_profile(session: AsyncSession, pro: QuotingPro, **fields: object) -> None:
    profile = await session.get(ProProfile, pro.profile_id)
    assert profile is not None
    for name, value in fields.items():
        setattr(profile, name, value)
    await session.flush()


async def make_category(session: AsyncSession, slug: str, *, active: bool = True) -> uuid.UUID:
    """`slug` leads the stored slug, so it sets the order; the suffix keeps it unique."""
    category = Category(
        slug=f"{slug}-{uuid.uuid4().hex[:8]}",
        names={"en": f"{slug} en", "es": f"{slug} es"},
        active=active,
    )
    session.add(category)
    await session.flush()
    return category.id


async def give_categories(
    session: AsyncSession, pro: QuotingPro, category_ids: list[uuid.UUID]
) -> None:
    session.add_all(ProCategory(pro_id=pro.profile_id, category_id=i) for i in category_ids)
    await session.flush()


# What the customer sees


async def test_customer_sees_the_profile_of_a_pro_who_quoted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session, rating="4.8", jobs_count=12, years=9)
    # The last minute of March in UTC: the month is March, never the day.
    await edit_profile(
        db_session,
        pro,
        bio="Licensed plumber, water heaters and leaks.",
        created_at=datetime(2025, 3, 31, 23, 59, tzinfo=UTC),
    )
    plumbing = await make_category(db_session, "b53-plumbing")
    electrical = await make_category(db_session, "a53-electrical")
    retired = await make_category(db_session, "c53-retired", active=False)
    # Inserted against the slug order: only the slug orders them.
    await give_categories(db_session, pro, [plumbing, retired, electrical])
    quote_id = await add_quote(db_session, request_id, pro)

    response = await profile_of(db_client, world, request_id, quote_id)

    assert response.status_code == 200, response.text
    body = response.json()
    [first, second] = body.pop("categories")
    assert (first["id"], second["id"]) == (str(electrical), str(plumbing))
    assert first["names"] == {"en": "a53-electrical en", "es": "a53-electrical es"}
    assert first["slug"].startswith("a53-electrical-")
    assert body == {
        "id": str(pro.profile_id),
        "name": "María P.",
        "rating_avg": "4.80",
        "jobs_count": 12,
        "years_of_experience": 9,
        "verified": True,
        "bio": "Licensed plumber, water heaters and leaks.",
        "member_since": "2025-03-01",
    }


async def test_profile_card_fields_match_the_list(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """The QuotePro fields mean the same here as on the quote card (#188)."""
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session, last_name=None, rating="3.5", jobs_count=1)
    quote_id = await add_quote(db_session, request_id, pro)
    [item] = (
        await db_client.get(f"/v1/requests/{request_id}/quotes", headers=customer(world))
    ).json()["items"]

    profile = (await profile_of(db_client, world, request_id, quote_id)).json()

    assert {key: profile[key] for key in PRO_KEYS} == item["pro"]
    assert profile["name"] is None
    assert profile["categories"] == []


async def test_profile_bio_hides_the_pros_own_contacts_and_contact_patterns(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """A bare handle and a phone grouped as "30 55 55 01 99" are no pattern (app.redaction
    known gaps): only the known-value pass masks them, with the pro's own email and phone."""
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session, email="handle.bio53@x.com")  # first pro: PRO_PHONE
    bio = (
        "Licensed plumber, 12 years. Write handle.bio53 or text 30 55 55 01 99, my partner "
        "786-555-0100, photos at https://pipes.example.com/me for you."
    )
    await edit_profile(db_session, pro, bio=bio)
    quote_id = await add_quote(db_session, request_id, pro, amount=1_000)
    silent = await quoting_pro(db_session)
    await edit_profile(db_session, silent, bio=None)
    silent_quote = await add_quote(db_session, request_id, silent, amount=2_000)

    shown = (await profile_of(db_client, world, request_id, quote_id)).json()["bio"]
    none = (await profile_of(db_client, world, request_id, silent_quote)).json()["bio"]

    assert shown == (
        "Licensed plumber, 12 years. Write ••• or text •••, my partner •••, photos at ••• for you."
    )
    assert none is None
    stored = await db_session.scalar(
        select(ProProfile.bio)
        .where(ProProfile.id == pro.profile_id)
        .execution_options(populate_existing=True)
    )
    assert stored == bio


async def test_profile_bio_known_values_are_this_pros_not_another_pros(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    one = await quoting_pro(db_session, email="handle.one53@x.com")
    two = await quoting_pro(db_session, email="handle.two53@x.com")
    bio = "Find me as handle.one53 or handle.two53"
    await edit_profile(db_session, one, bio=bio)
    await edit_profile(db_session, two, bio=bio)
    quote_one = await add_quote(db_session, request_id, one, amount=1_000)
    quote_two = await add_quote(db_session, request_id, two, amount=2_000)

    shown = [
        (await profile_of(db_client, world, request_id, quote_id)).json()["bio"]
        for quote_id in (quote_one, quote_two)
    ]

    assert shown == ["Find me as ••• or handle.two53", "Find me as handle.one53 or •••"]


async def test_profile_never_exposes_private_fields(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """quoting_pro fills the photo, the Stripe account, payouts and the names; a document and a
    service area are added, so a leak of any of them would show."""
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session, rating="4.5", jobs_count=3, years=7)
    await edit_profile(db_session, pro, bio="Clean work")
    area_id = await db_session.scalar(select(ServiceArea.id).where(ServiceArea.zip_code == "32801"))
    assert area_id is not None
    db_session.add_all(
        [
            ProDocument(
                pro_id=pro.profile_id, doc_type=ProDocumentType.LICENSE, file_key=DOCUMENT_KEY
            ),
            ProServiceArea(pro_id=pro.profile_id, service_area_id=area_id),
        ]
    )
    await give_categories(db_session, pro, [world.category_id])
    quote_id = await add_quote(db_session, request_id, pro)

    response = await profile_of(db_client, world, request_id, quote_id)

    assert response.status_code == 200
    document = response.json()
    assert set(document) == PROFILE_KEYS
    assert [set(category) for category in document["categories"]] == [CATEGORY_KEYS]
    assert document["rating_avg"] == "4.50"  # a string, never the raw decimal
    assert document["member_since"].endswith("-01")
    secrets = (
        pro.email,
        PRO_PHONE,
        PRO_PHONE.removeprefix("+1"),
        str(pro.user_id),
        pro.user_id.hex,
        STRIPE_ID,
        PHOTO_KEY,
        DOCUMENT_KEY,
        "32801",  # the service area's ZIP
        "Orlando",
        "Pérez",  # the full last name: only its initial is public
        "approved",  # verification_status beyond `verified`
        str(quote_id),
        str(request_id),
        EMAIL,  # nor the customer's own details
        PHONE,
        str(world.customer_id),
    )
    for secret in secrets:
        assert secret not in response.text, secret


def test_profile_model_forbids_extra_fields() -> None:
    document: dict[str, object] = {
        "id": str(uuid.uuid4()),
        "name": None,
        "rating_avg": None,
        "jobs_count": 0,
        "years_of_experience": None,
        "verified": True,
        "bio": None,
        "categories": [],
        "member_since": "2026-10-01",
    }
    ProPublicProfile.model_validate(document)
    for extra in (
        "photo",
        "photo_key",
        "documents",
        "payouts_enabled",
        "stripe_account_id",
        "user_id",
        "email",
        "phone",
        "service_areas",
        "verification_status",
        "created_at",
    ):
        with pytest.raises(ValueError, match="Extra inputs are not permitted"):
            ProPublicProfile.model_validate({**document, extra: "x"})


# When the profile is shown: exactly while the list shows the quote


Case = Callable[[AsyncSession, World], Awaitable[tuple[dict[str, str], uuid.UUID, uuid.UUID]]]


async def _another_customers_request(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    quote_id = await add_quote(session, request_id, await quoting_pro(session))
    stranger = await make_caller(session, UserRole.CUSTOMER)
    return stranger.headers, request_id, quote_id


async def _a_foreign_quote_id(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    """A shown quote of the customer's other request, asked for on this one."""
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    other = await make_request(session, world, RequestStatus.QUOTE_READY)
    await add_quote(session, request_id, await quoting_pro(session))
    foreign = await add_quote(session, other, await quoting_pro(session))
    return customer(world), request_id, foreign


async def _an_unknown_quote_id(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    await add_quote(session, request_id, await quoting_pro(session))
    return customer(world), request_id, uuid.uuid4()


async def _a_quote_of_status(
    status: QuoteStatus, session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    quote_id = await add_quote(session, request_id, await quoting_pro(session), status=status)
    return customer(world), request_id, quote_id


async def _an_expired_quote(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    return await _a_quote_of_status(QuoteStatus.EXPIRED, session, world)


async def _a_withdrawn_quote(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    return await _a_quote_of_status(QuoteStatus.WITHDRAWN, session, world)


async def _a_rejected_quote(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    return await _a_quote_of_status(QuoteStatus.REJECTED, session, world)


async def _a_pending_quote_past_its_expiry(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    """Not marked by the expiry worker yet: its expires_at is what counts."""
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    quote_id = await add_quote(
        session, request_id, await quoting_pro(session), expires_in=-timedelta(seconds=1)
    )
    return customer(world), request_id, quote_id


async def _a_request_off_the_quote_screen(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    """A live pending quote left on a cancelled request: the quote screen is gone."""
    request_id = await make_request(session, world, RequestStatus.CANCELLED)
    quote_id = await add_quote(session, request_id, await quoting_pro(session))
    return customer(world), request_id, quote_id


async def _a_pro_who_lost_approval(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(session, verification=ProVerificationStatus.REJECTED)
    return customer(world), request_id, await add_quote(session, request_id, pro)


async def _a_pro_back_to_pending_review(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(session, verification=ProVerificationStatus.PENDING)
    return customer(world), request_id, await add_quote(session, request_id, pro)


async def _a_pro_who_lost_payouts(
    session: AsyncSession, world: World
) -> tuple[dict[str, str], uuid.UUID, uuid.UUID]:
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(session, payouts_enabled=False)
    return customer(world), request_id, await add_quote(session, request_id, pro)


@pytest.mark.parametrize(
    "case",
    [
        _another_customers_request,
        _a_foreign_quote_id,
        _an_unknown_quote_id,
        _an_expired_quote,
        _a_withdrawn_quote,
        _a_rejected_quote,
        _a_pending_quote_past_its_expiry,
        _a_request_off_the_quote_screen,
        _a_pro_who_lost_approval,
        _a_pro_back_to_pending_review,
        _a_pro_who_lost_payouts,
    ],
    ids=lambda case: case.__name__.strip("_"),
)
async def test_profile_is_404_wherever_the_list_would_hide_the_quote(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, case: Case
) -> None:
    headers, request_id, quote_id = await case(db_session, world)
    unknown_request = await db_client.get(
        profile_path(uuid.uuid4(), quote_id), headers=customer(world)
    )

    response = await db_client.get(profile_path(request_id, quote_id), headers=headers)

    assert response.status_code == 404
    assert response.json() == NOT_FOUND
    assert response.content == unknown_request.content  # an id reveals nothing
    listed = await db_client.get(f"/v1/requests/{request_id}/quotes", headers=headers)
    # The list hides it too: a 404 for a stranger, else a list without it. Any other answer
    # (an error, say) fails here rather than passing for not naming the quote.
    if case is _another_customers_request:
        assert listed.status_code == 404
        assert listed.json() == NOT_FOUND
    else:
        assert listed.status_code == 200, listed.text
        assert str(quote_id) not in {item["id"] for item in listed.json()["items"]}


async def test_every_listed_quote_has_a_profile(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """The other side of the mirror: each quote the list shows opens, on both screens."""
    for status in (RequestStatus.QUOTE_READY, RequestStatus.ACCEPTED):
        request_id = await make_request(db_session, world, status)
        await add_quote(
            db_session, request_id, await quoting_pro(db_session), status=QuoteStatus.ACCEPTED
        )
        await add_quote(db_session, request_id, await quoting_pro(db_session), amount=1)
        listed = await listed_ids(db_client, world, request_id)
        assert len(listed) == 2

        for quote_id in listed:
            response = await profile_of(db_client, world, request_id, quote_id)
            assert response.status_code == 200, (status, response.text)


async def test_profile_of_the_accepted_quote_follows_the_replay_rule(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """AC2: the accepted quote is shown while the payment is pending, past its expires_at too.
    The list does not apply #189's replay rule (its accept repeat answers with an ineligible
    pro, the list never lists one), so the profile follows the list: once the pro can no
    longer be hired, the list drops the quote and the profile is 404."""
    request_id = await make_request(db_session, world, RequestStatus.ACCEPTED)
    pro = await quoting_pro(db_session)
    quote_id = await add_quote(
        db_session,
        request_id,
        pro,
        status=QuoteStatus.ACCEPTED,
        expires_in=-timedelta(hours=1),
    )

    shown = await profile_of(db_client, world, request_id, quote_id)
    assert shown.status_code == 200
    assert shown.json()["id"] == str(pro.profile_id)

    await edit_profile(db_session, pro, payouts_enabled=False)
    replay = await db_client.post(
        f"/v1/requests/{request_id}/quotes/{quote_id}/accept", headers=customer(world)
    )
    hidden = await profile_of(db_client, world, request_id, quote_id)

    assert replay.status_code == 200  # the acceptance's replay still answers (#189)
    assert await listed_ids(db_client, world, request_id) == []
    assert hidden.status_code == 404
    assert hidden.json() == NOT_FOUND


# Who may read


async def test_profile_requires_a_customer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session)
    quote_id = await add_quote(db_session, request_id, pro)
    url = profile_path(request_id, quote_id)
    admin = await make_caller(db_session, UserRole.ADMIN)

    for headers in ({}, {"Authorization": "Bearer not-a-token"}):
        response = await db_client.get(url, headers=headers)
        assert response.status_code == 401
        assert response.json() == INVALID_TOKEN
    for headers in (
        headers_for(pro.user_id, UserRole.PRO),  # even the pro who quoted
        headers_for(world.agent_id, UserRole.AGENT),
        admin.headers,
    ):
        response = await db_client.get(url, headers=headers)
        assert response.status_code == 403
        assert response.json() == FORBIDDEN


async def test_malformed_ids_422(db_client: httpx.AsyncClient, world: World) -> None:
    for url in (
        f"/v1/requests/not-a-uuid/quotes/{uuid.uuid4()}/pro",
        f"/v1/requests/{uuid.uuid4()}/quotes/not-a-uuid/pro",
    ):
        response = await db_client.get(url, headers=customer(world))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


# Logs and cost


async def test_profile_logs_carry_no_pro_details(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    pro = await quoting_pro(db_session)
    await edit_profile(db_session, pro, bio="probe-bio-53 call 786-555-0100")
    quote_id = await add_quote(db_session, request_id, pro)
    caplog.set_level(logging.DEBUG)

    response = await profile_of(db_client, world, request_id, quote_id)

    assert response.status_code == 200
    formatter = JsonFormatter()
    # Decoded: the formatter escapes non-ASCII, so "María" would never match the raw lines.
    logged = "\n".join(
        json.dumps(json.loads(formatter.format(record)), ensure_ascii=False)
        for record in caplog.records
    )
    assert caplog.records  # the access log at least: the search has something to search
    for secret in ("probe-bio-53", "786-555-0100", "María", "Pérez", pro.email, PRO_PHONE):
        assert secret not in logged, secret


async def test_profile_query_count_is_constant(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    small = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    large = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    plain = await quoting_pro(db_session)
    await give_categories(db_session, plain, [await make_category(db_session, "x53")])
    plain_quote = await add_quote(db_session, small, plain)
    rich = await quoting_pro(db_session, rating="4.9", jobs_count=40, years=20)
    await edit_profile(db_session, rich, bio="Water heaters. " * 50)
    await give_categories(
        db_session, rich, [await make_category(db_session, f"y53-{n}") for n in range(5)]
    )
    rich_quote = await add_quote(db_session, large, rich, amount=1)
    for n in range(4):
        await add_quote(db_session, large, await quoting_pro(db_session), amount=1_000 + n)

    counts: list[int] = []
    for request_id, quote_id, categories in ((small, plain_quote, 1), (large, rich_quote, 5)):
        db_session.expunge_all()  # nothing served from the identity map
        with counted_statements(db_session) as statements:
            response = await profile_of(db_client, world, request_id, quote_id)
        assert len(response.json()["categories"]) == categories
        counts.append(len(statements))

    # The caller's account, the request, its quotes, the pros who can still be hired, their
    # names, the pro's bio with their category ids, the categories, their contacts.
    assert counts == [8, 8]


async def test_profile_denials_do_equal_sql_work(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """Vault round 1: whatever hides the asked-for quote, the denial does the list's reads and
    nothing more, so the work reveals nothing about the id (a hidden pro's quote once cost one
    read more than an unknown id). The shown quote on the same request opens."""
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    other = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    shown = await add_quote(db_session, request_id, await quoting_pro(db_session))
    lost_approval = await quoting_pro(db_session, verification=ProVerificationStatus.REJECTED)
    lost_payouts = await quoting_pro(db_session, payouts_enabled=False)
    candidates = {
        "unknown": uuid.uuid4(),
        "foreign": await add_quote(db_session, other, await quoting_pro(db_session)),
        "expired": await add_quote(
            db_session, request_id, await quoting_pro(db_session), status=QuoteStatus.EXPIRED
        ),
        "withdrawn": await add_quote(
            db_session, request_id, await quoting_pro(db_session), status=QuoteStatus.WITHDRAWN
        ),
        "lost_approval": await add_quote(db_session, request_id, lost_approval),
        "lost_payouts": await add_quote(db_session, request_id, lost_payouts),
    }
    db_session.expunge_all()
    with counted_statements(db_session) as list_statements:
        listed = await db_client.get(f"/v1/requests/{request_id}/quotes", headers=customer(world))
    assert [item["id"] for item in listed.json()["items"]] == [str(shown)]

    counts: dict[str, int] = {}
    bodies: set[bytes] = set()
    for name, quote_id in candidates.items():
        db_session.expunge_all()  # nothing served from the identity map
        with counted_statements(db_session) as statements:
            response = await profile_of(db_client, world, request_id, quote_id)
        assert response.status_code == 404, name
        assert response.json() == NOT_FOUND, name
        bodies.add(response.content)
        counts[name] = len(statements)
        # Nothing the list does not read: no bio, no categories, no contact points.
        assert set(statements) <= set(list_statements), name

    assert len(bodies) == 1
    # The caller's account, the request, its quotes, the pros who can still be hired, their
    # names: the list's reads before its contact points, for every candidate alike.
    assert counts == dict.fromkeys(candidates, 5)
    assert (await profile_of(db_client, world, request_id, shown)).status_code == 200


# The contract


def test_openapi_documents_the_route(app: FastAPI) -> None:
    schema = app.openapi()
    operation = schema["paths"]["/v1/requests/{request_id}/quotes/{quote_id}/pro"]["get"]

    assert operation["summary"]
    assert operation["description"]
    assert operation["tags"] == ["quotes"]
    assert {"200", "401", "403", "404"} <= set(operation["responses"])
    assert "invalid_token" in operation["responses"]["401"]["description"]
    assert "forbidden" in operation["responses"]["403"]["description"]
    assert "not_found" in operation["responses"]["404"]["description"]
    ok = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert ok == {"$ref": "#/components/schemas/ProPublicProfile"}
    component = schema["components"]["schemas"]["ProPublicProfile"]
    assert component["additionalProperties"] is False
    properties = component["properties"]
    assert set(properties) == PROFILE_KEYS
    assert "masked" in properties["bio"]["description"]
    assert "month precision" in properties["member_since"]["description"]
    assert properties["member_since"]["format"] == "date"
    assert "active categories" in properties["categories"]["description"]
