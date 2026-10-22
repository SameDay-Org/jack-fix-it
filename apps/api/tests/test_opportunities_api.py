"""GET /v1/pros/me/opportunities and /{dispatch_id}: a pro's dispatched requests (D9.2, #49)."""

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.dispatch.schemas import OpportunityDetail, OpportunityPage, OpportunitySummary
from app.modules.pros.models import ProProfile
from app.modules.requests.models import (
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    RequestStatus,
    ServiceRequest,
)
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import make_settings
from tests.test_requests_api import Caller, FakeStorage, make_caller

EXCERPT = 12
LIST_DEFAULT = 2
LIST_MAX = 10
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
DESCRIPTION = "Water leaks under the kitchen sink, probe-description"
LINE1, LINE2 = "742 Evergreen Terrace", "Apt probe-line2"
EMAIL, PHONE = "probe.customer@example.com", "+15555550199"
UTM = "probe-utm-campaign"
NEXT_ACTION = "probe-next-action"
BASE = "/v1/pros/me/opportunities"
T0 = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        opportunity_excerpt_chars=EXCERPT,
        request_list_default_limit=LIST_DEFAULT,
        request_list_max_limit=LIST_MAX,
    )


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@dataclass(frozen=True)
class Pro:
    caller: Caller
    profile_id: uuid.UUID


@dataclass(frozen=True)
class World:
    me: Pro
    other: Pro
    customer_id: uuid.UUID
    agent_id: uuid.UUID
    address_id: uuid.UUID
    category_id: uuid.UUID


async def make_pro(session: AsyncSession) -> Pro:
    caller = await make_caller(session, UserRole.PRO)
    profile = ProProfile(user_id=caller.id)
    session.add(profile)
    await session.flush()
    return Pro(caller, profile.id)


async def build_world(db_session: AsyncSession) -> World:
    """Two pros, a customer and an agent, a category and the customer's address."""
    me, other = await make_pro(db_session), await make_pro(db_session)
    customer = User(email=EMAIL, password_hash="x", role=UserRole.CUSTOMER, phone=PHONE)
    agent = User(
        email=f"agent-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.AGENT
    )
    category = Category(
        slug=f"test-{uuid.uuid4().hex[:8]}", names={"en": "Plumbing", "es": "Plomería"}
    )
    db_session.add_all([customer, agent, category])
    await db_session.flush()
    address = Address(
        user_id=customer.id,
        line1=LINE1,
        line2=LINE2,
        city="Orlando",
        state="FL",
        zip_code="32801-1234",
    )
    db_session.add(address)
    await db_session.flush()
    return World(me, other, customer.id, agent.id, address.id, category.id)


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


async def make_request(
    session: AsyncSession, world: World, status: RequestStatus = RequestStatus.FINDING_PRO
) -> uuid.UUID:
    # Every field a pro must never see is filled, so a leak would show.
    request = ServiceRequest(
        customer_id=world.customer_id,
        address_id=world.address_id,
        category_id=world.category_id,
        description=DESCRIPTION,
        intake_answers={"rooms": 2},
        preferred_date=date(2026, 11, 3),
        origin=RequestOrigin.APP,
        status=status,
        utm={"campaign": UTM},
        assigned_agent_id=world.agent_id,
        next_action=NEXT_ACTION,
        first_contact_at=T0,
    )
    session.add(request)
    await session.flush()
    return request.id


async def dispatch(
    session: AsyncSession,
    request_id: uuid.UUID,
    pro: Pro,
    *,
    status: DispatchStatus = DispatchStatus.SENT,
    sent_at: datetime = T0,
) -> uuid.UUID:
    row = RequestDispatch(
        request_id=request_id, pro_id=pro.profile_id, status=status, sent_at=sent_at
    )
    session.add(row)
    await session.flush()
    return row.id


async def dispatch_row(session: AsyncSession, dispatch_id: uuid.UUID) -> RequestDispatch:
    statement = (
        select(RequestDispatch)
        .where(RequestDispatch.id == dispatch_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def listed(client: httpx.AsyncClient, pro: Pro, **params: str | int) -> httpx.Response:
    return await client.get(BASE, params=params, headers=pro.caller.headers)


async def test_lists_only_callers_active_dispatches(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    finding = await make_request(db_session, world)
    quoted = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    sent = await dispatch(db_session, finding, world.me, sent_at=T0)
    viewed = await dispatch(
        db_session, quoted, world.me, status=DispatchStatus.VIEWED, sent_at=T0 + timedelta(hours=1)
    )
    # Not listed: another pro's, declined, expired, quoted, and requests no longer open.
    await dispatch(db_session, finding, world.other)
    for status in (DispatchStatus.DECLINED, DispatchStatus.EXPIRED, DispatchStatus.QUOTED):
        await dispatch(db_session, await make_request(db_session, world), world.me, status=status)
    for closed in (RequestStatus.ACCEPTED, RequestStatus.EXPIRED, RequestStatus.CANCELLED):
        await dispatch(db_session, await make_request(db_session, world, closed), world.me)

    # Newest of all: dispatches on closed requests. They are filtered in the query, so a page
    # of one still holds the newest open opportunity.
    for closed in (RequestStatus.ACCEPTED, RequestStatus.CANCELLED):
        request_id = await make_request(db_session, world, closed)
        await dispatch(db_session, request_id, world.me, sent_at=T0 + timedelta(days=1))
    [newest] = (await listed(db_client, world.me, limit=1)).json()["items"]
    assert newest["dispatch_id"] == str(viewed)

    response = await listed(db_client, world.me, limit=LIST_MAX)

    assert response.status_code == 200
    body = response.json()
    assert [item["dispatch_id"] for item in body["items"]] == [str(viewed), str(sent)]
    assert body["next_cursor"] is None
    first = body["items"][1]
    assert first["description_excerpt"] == DESCRIPTION[:EXCERPT]
    assert first["location"] == {"zip_code": "32801-1234", "city": "Orlando"}
    assert first["category"]["names"] == {"en": "Plumbing", "es": "Plomería"}
    assert first["viewed"] is False
    assert body["items"][0]["viewed"] is True
    assert set(first) == {
        "dispatch_id",
        "public_code",
        "category",
        "description_excerpt",
        "location",
        "preferred_date",
        "sent_at",
        "viewed",
    }


async def test_detail_marks_viewed_once_and_sets_viewed_at(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    first = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)
    row = await dispatch_row(db_session, dispatch_id)
    second = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)

    assert first.status_code == second.status_code == 200
    assert row.status is DispatchStatus.VIEWED
    assert row.viewed_at is not None
    assert row.responded_at == row.viewed_at  # seeing it is the pro's first answer
    assert first.json()["viewed_at"] == second.json()["viewed_at"] is not None
    assert (await dispatch_row(db_session, dispatch_id)).viewed_at == row.viewed_at
    detail = first.json()
    assert detail["description"] == DESCRIPTION
    assert detail["intake_answers"] == {"rooms": 2}
    assert detail["location"] == {"zip_code": "32801-1234", "city": "Orlando"}
    [item] = (await listed(db_client, world.me)).json()["items"]
    assert item["viewed"] is True


async def test_other_pros_or_unknown_or_closed_dispatch_404_same_body(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    request_id = await make_request(db_session, world)
    others = await dispatch(db_session, request_id, world.other)
    declined = await dispatch(
        db_session, await make_request(db_session, world), world.me, status=DispatchStatus.DECLINED
    )
    expired = await dispatch(
        db_session, await make_request(db_session, world), world.me, status=DispatchStatus.EXPIRED
    )
    closed = await dispatch(
        db_session, await make_request(db_session, world, RequestStatus.CANCELLED), world.me
    )

    for dispatch_id in (others, declined, expired, closed, uuid.uuid4()):
        response = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)
        assert response.status_code == 404
        assert response.json() == NOT_FOUND
    # Trying another pro's dispatch did not mark it viewed.
    assert (await dispatch_row(db_session, others)).status is DispatchStatus.SENT


async def test_a_pro_without_a_profile_gets_404_on_both_routes(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    newcomer = await make_caller(db_session, UserRole.PRO)
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    listing = await db_client.get(BASE, headers=newcomer.headers)
    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=newcomer.headers)

    # The same status and body on both routes (AC5: 403 or 404, as the detail did already).
    for response in (listing, detail):
        assert response.status_code == 404
        assert response.json() == NOT_FOUND


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.AGENT, UserRole.ADMIN])
async def test_customer_agent_admin_403(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    role: UserRole,
) -> None:
    caller = await make_caller(db_session, role)
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    for path in (BASE, f"{BASE}/{dispatch_id}"):
        response = await db_client.get(path, headers=caller.headers)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"


async def test_unauthenticated_401(db_client: httpx.AsyncClient, storage: FakeStorage) -> None:
    for path in (BASE, f"{BASE}/{uuid.uuid4()}"):
        assert (await db_client.get(path)).status_code == 401


async def test_response_never_contains_customer_contact_or_street(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    # Real media attached: their keys hold the customer's id (u/<customer id>/...), and pros get
    # no media until #173 serves sanitized copies.
    request_id = await make_request(db_session, world)
    db_session.add_all(
        RequestMedia(
            request_id=request_id,
            kind=kind,
            file_key=f"u/{world.customer_id}/request_media/probe-{n}{extension}",
        )
        for n, (kind, extension) in enumerate(
            [(RequestMediaKind.PHOTO, ".jpg"), (RequestMediaKind.VIDEO, ".mp4")]
        )
    )
    await db_session.flush()
    dispatch_id = await dispatch(db_session, request_id, world.me)

    listing = await listed(db_client, world.me)
    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)

    for response in (listing, detail):
        assert response.status_code == 200
        text = response.text
        for secret in (
            EMAIL,
            PHONE,
            LINE1,
            LINE2,
            UTM,
            NEXT_ACTION,
            str(world.customer_id),
            world.customer_id.hex,
            str(world.agent_id),
            "request_media",
            "probe-0",
        ):
            assert secret not in text, secret
        keys = _keys(response.json())
        for key in ("customer_id", "email", "phone", "line1", "line2", "lat", "lng", "utm"):
            assert key not in keys, key
        for key in ("assigned_agent_id", "next_action", "first_contact_at", "last_contact_at"):
            assert key not in keys, key
        for key in ("media", "media_count", "url", "file_key"):
            assert key not in keys, key
    assert storage.gets == []  # nothing was signed for the pro
    assert set(detail.json()) == {
        "dispatch_id",
        "public_code",
        "category",
        "description",
        "intake_answers",
        "location",
        "preferred_date",
        "sent_at",
        "viewed_at",
    }


def _keys(value: object) -> set[str]:
    """Every key anywhere in a JSON document."""
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in _keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in _keys(item)}
    return set()


CATEGORY = {"id": str(uuid.UUID(int=7)), "slug": "plumbing", "names": {"en": "Plumbing"}}
LOCATION = {"zip_code": "32801", "city": "Orlando"}
SUMMARY = {
    "dispatch_id": str(uuid.UUID(int=8)),
    "public_code": "JF-000124",
    "category": CATEGORY,
    "description_excerpt": "Water leaks",
    "location": LOCATION,
    "preferred_date": None,
    "sent_at": T0.isoformat(),
    "viewed": False,
}
DETAIL = {
    "dispatch_id": str(uuid.UUID(int=8)),
    "public_code": "JF-000124",
    "category": CATEGORY,
    "description": "Water leaks under the sink",
    "intake_answers": {},
    "location": LOCATION,
    "preferred_date": None,
    "sent_at": T0.isoformat(),
    "viewed_at": None,
}


def _with_extra(document: dict[str, object], path: tuple[str | int, ...]) -> dict[str, object]:
    """A deep copy of `document` with a `customer_id` added at `path` (a nested object)."""
    copy: dict[str, Any] = json.loads(json.dumps(document))
    target: Any = copy
    for step in path:
        target = target[step]
    assert isinstance(target, dict)
    target["customer_id"] = str(uuid.uuid4())
    return copy


@pytest.mark.parametrize(
    ("model", "document", "path"),
    [
        (OpportunitySummary, SUMMARY, ()),
        (OpportunitySummary, SUMMARY, ("category",)),
        (OpportunitySummary, SUMMARY, ("location",)),
        (OpportunityPage, {"items": [SUMMARY], "next_cursor": None}, ()),
        (OpportunityPage, {"items": [SUMMARY], "next_cursor": None}, ("items", 0)),
        (OpportunityPage, {"items": [SUMMARY], "next_cursor": None}, ("items", 0, "category")),
        (OpportunityPage, {"items": [SUMMARY], "next_cursor": None}, ("items", 0, "location")),
        (OpportunityDetail, DETAIL, ()),
        (OpportunityDetail, DETAIL, ("category",)),
        (OpportunityDetail, DETAIL, ("location",)),
    ],
    ids=lambda value: "/".join(map(str, value)) if isinstance(value, tuple) else None,
)
def test_nested_response_models_forbid_extra_fields(
    model: type[BaseModel], document: dict[str, object], path: tuple[str | int, ...]
) -> None:
    model.model_validate(document)  # the fixture itself is valid

    with pytest.raises(ValidationError) as refused:
        model.model_validate(_with_extra(document, path))

    [error] = refused.value.errors()
    assert error["type"] == "extra_forbidden"
    assert error["loc"] == (*path, "customer_id")


async def test_pagination_cursor_stable(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    # Five dispatches; newest first, the second and third were sent at the same moment, so the
    # first page (two items) ends inside the tie: only the id can tell where to resume.
    times = [
        T0 - timedelta(minutes=1),
        T0,
        T0 + timedelta(minutes=1),
        T0 + timedelta(minutes=1),
        T0 + timedelta(minutes=2),
    ]
    rows = [
        (
            sent_at,
            await dispatch(
                db_session, await make_request(db_session, world), world.me, sent_at=sent_at
            ),
        )
        for sent_at in times
    ]
    expected = [
        str(dispatch_id)
        for _, dispatch_id in sorted(rows, key=lambda r: (r[0], r[1]), reverse=True)
    ]

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, str] = {"cursor": cursor} if cursor else {}
        body = (await listed(db_client, world.me, **params)).json()
        assert len(body["items"]) <= LIST_DEFAULT
        seen += [item["dispatch_id"] for item in body["items"]]
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == expected
    assert pages == 3
    bad = await listed(db_client, world.me, cursor="not-a-cursor")
    assert bad.status_code == 422


async def test_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world)
    key = f"u/{world.customer_id}/request_media/probe-key.jpg"
    db_session.add(RequestMedia(request_id=request_id, kind=RequestMediaKind.PHOTO, file_key=key))
    await db_session.flush()
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.DEBUG):
        await listed(db_client, world.me)
        await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)

    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for secret in ("probe-description", "probe-key", LINE1, "32801", "Orlando", EMAIL, '"rooms"'):
        assert secret not in output, secret
    [opened] = [r for r in caplog.records if r.message == "opportunity_opened"]
    assert opened.__dict__["dispatch_id"] == str(dispatch_id)
    assert opened.__dict__["service_request_id"] == str(request_id)
    assert opened.__dict__["pro_id"] == str(world.me.profile_id)
    assert opened.__dict__["first_view"] is True
    assert json.loads(JsonFormatter().format(opened))["message"] == "opportunity_opened"


def test_openapi_documents_both_routes(app: FastAPI) -> None:
    paths = app.openapi()["paths"]

    assert {"200", "401", "403", "404", "422"} <= set(paths[BASE]["get"]["responses"])
    assert {"200", "401", "403", "404"} <= set(paths[f"{BASE}/{{dispatch_id}}"]["get"]["responses"])
