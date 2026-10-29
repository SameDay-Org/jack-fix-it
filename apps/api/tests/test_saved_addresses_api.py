"""GET, POST, PATCH and DELETE /v1/addresses: the customer's saved addresses (D8.2, #214)."""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.storage import get_storage
from app.modules.addresses.models import Address, SavedAddress
from app.modules.addresses.repository import SavedAddressRepository
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.pros.models import ProProfile
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.service_areas.models import ServiceArea
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter, window_position
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    Committed,
    InMemoryRateLimiter,
    backend_pid,
    make_app,
    make_settings,
)
from tests.helpers import as_status_writer
from tests.test_auth_api import register as register_account
from tests.test_devices_api import caller, wait_until_blocking
from tests.test_requests_api import FakeStorage, RecordingQueue

BASE = "/v1/addresses"
MAX = 4
SERVED_ZIP, UNSERVED_ZIP = "32801", "32999"
HOME = {
    "label": "Home",
    "line1": "742 Evergreen Terrace",
    "city": "Orlando",
    "state": "FL",
    "zip_code": SERVED_ZIP,
}
T0 = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)

NOT_FOUND = {"error": {"code": "address_not_found", "message": "Saved address not found."}}
LIMIT_REACHED = {
    "error": {
        "code": "address_limit_reached",
        "message": "You have reached the maximum number of saved addresses.",
    }
}
LABEL_TAKEN = {
    "error": {
        "code": "address_label_taken",
        "message": "You already have an address with this label.",
    }
}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
WRITE_LIMIT, WRITE_WINDOW = 5, 600
NOW = 1_800_000_000.0  # a fixed clock, so no test straddles two rate-limit windows


@pytest.fixture
def settings() -> Settings:
    return make_settings(saved_addresses_max_per_user=MAX)


@pytest.fixture
async def served(db_session: AsyncSession) -> None:
    """The fixture address's ZIP as an active service area; UNSERVED_ZIP has none."""
    db_session.add(
        ServiceArea(region="Test Region", city="Orlando", state="FL", zip_code=SERVED_ZIP)
    )
    await db_session.flush()


def body(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = dict(HOME)
    values.update(overrides)
    return values


async def create(
    client: httpx.AsyncClient, headers: dict[str, str], **overrides: Any
) -> httpx.Response:
    return await client.post(BASE, json=body(**overrides), headers=headers)


async def patch(
    client: httpx.AsyncClient, headers: dict[str, str], address_id: object, **fields: Any
) -> httpx.Response:
    return await client.patch(f"{BASE}/{address_id}", json=fields, headers=headers)


async def listed(client: httpx.AsyncClient, headers: dict[str, str]) -> list[dict[str, Any]]:
    response = await client.get(BASE, headers=headers)
    assert response.status_code == 200
    items: list[dict[str, Any]] = response.json()["items"]
    return items


async def rows(session: AsyncSession, user_id: uuid.UUID) -> list[SavedAddress]:
    statement = (
        select(SavedAddress)
        .where(SavedAddress.user_id == user_id)
        .order_by(SavedAddress.created_at, SavedAddress.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def age(session: AsyncSession, address_id: str, minutes: int) -> None:
    """Sets created_at: rows made in one test share the transaction's now(), so "oldest
    first" needs explicit times."""
    await session.execute(
        update(SavedAddress)
        .where(SavedAddress.id == uuid.UUID(address_id))
        .values(created_at=T0 + timedelta(minutes=minutes))
    )


# Create and list


async def test_first_address_becomes_default(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    _, headers = await caller(db_session)

    first = await create(db_client, headers)
    second = await create(db_client, headers, label="Work", line1="1 Main St", line2="")

    assert first.status_code == second.status_code == 201
    assert first.json() == {
        "id": first.json()["id"],
        "label": "Home",
        "line1": "742 Evergreen Terrace",
        "line2": None,
        "city": "Orlando",
        "state": "FL",
        "zip_code": SERVED_ZIP,
        "lat": None,
        "lng": None,
        "is_default": True,
        "served": True,
    }
    assert second.json()["is_default"] is False
    assert second.json()["line2"] is None  # an empty unit line is stored as none
    assert [item["id"] for item in await listed(db_client, headers)] == [
        first.json()["id"],
        second.json()["id"],
    ]


async def test_list_orders_default_first_and_flags_served(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    _, headers = await caller(db_session)
    home = (await create(db_client, headers)).json()
    beach = (await create(db_client, headers, label="Beach", zip_code=UNSERVED_ZIP)).json()
    work = (await create(db_client, headers, label="Work", zip_code=f"{SERVED_ZIP}-1234")).json()
    for n, item in enumerate((home, beach, work)):
        await age(db_session, item["id"], n)

    moved = await patch(db_client, headers, work["id"], is_default=True)
    items = await listed(db_client, headers)

    assert moved.status_code == 200
    assert [(i["label"], i["is_default"], i["served"]) for i in items] == [
        ("Work", True, True),  # the default first, ZIP+4 served by its ZIP
        ("Home", False, True),  # then the oldest first
        ("Beach", False, False),
    ]
    assert beach["served"] is False  # the create said so too; the app offers the waitlist


@contextmanager
def counted_statements(session: AsyncSession) -> Iterator[list[str]]:
    statements: list[str] = []
    engine = session.get_bind().engine

    def record(*args: Any) -> None:
        statement: str = args[2]
        # The test session's savepoint bookkeeping after a commit is not an application query.
        if not statement.startswith(("SAVEPOINT", "RELEASE SAVEPOINT", "ROLLBACK TO")):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


async def test_list_query_count_is_constant(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    _, headers = await caller(db_session)

    seen: list[list[str]] = []
    for n in range(MAX + 1):
        with counted_statements(db_session) as statements:
            items = await listed(db_client, headers)
        assert len(items) == n
        seen.append(list(statements))
        if n < MAX:
            assert (await create(db_client, headers, label=f"Place {n}")).status_code == 201

    # The caller's account, the rows, and which of their ZIPs are served: never one per row.
    assert [len(statements) for statements in seen] == [3] * (MAX + 1), seen


async def test_fifth_address_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)
    for n in range(MAX):
        assert (await create(db_client, headers, label=f"Place {n}")).status_code == 201

    fifth = await create(db_client, headers, label="One more")

    assert fifth.status_code == 409
    assert fifth.json() == LIMIT_REACHED
    assert len(await rows(db_session, user_id)) == MAX


async def test_limit_comes_from_settings(db_session: AsyncSession, served: None) -> None:
    app = make_app(make_settings(saved_addresses_max_per_user=1))

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        _, headers = await caller(db_session)
        first = await create(client, headers)
        second = await create(client, headers, label="Work")

    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json() == LIMIT_REACHED


async def test_concurrent_creates_never_exceed_four_or_two_defaults(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    account = (await register_account(committed.client, email=committed.email)).json()
    user_id = uuid.UUID(account["user"]["id"])
    headers = {"Authorization": f"Bearer {account['access_token']}"}
    async with committed.sessions() as session:
        session.add_all(
            SavedAddress(
                user_id=user_id,
                label=f"Place {n}",
                line1="742 Evergreen Terrace",
                city="Orlando",
                state="FL",
                zip_code=SERVED_ZIP,
                is_default=n == 0,
            )
            for n in range(MAX - 1)
        )
        await session.commit()
    # The first create to count keeps its transaction open until Postgres reports another
    # backend waiting on a lock it holds: the second create, at the user's lock. Without that
    # lock the second never waits; it counts three as well, and both insert: five addresses,
    # or two defaults colliding on the unique index (a 500 instead of the 409).
    holding = False
    count_for_user = SavedAddressRepository.count_for_user

    async def count_then_hold(self: SavedAddressRepository, owner_id: uuid.UUID) -> int:
        nonlocal holding
        count = await count_for_user(self, owner_id)
        if not holding:
            holding = True
            await wait_until_blocking(committed.sessions, holder=await backend_pid(self._session))
        return count

    monkeypatch.setattr(SavedAddressRepository, "count_for_user", count_then_hold)
    try:
        responses = await asyncio.gather(
            create(committed.client, headers, label="Race 1", is_default=True),
            create(committed.client, headers, label="Race 2", is_default=True),
        )

        assert sorted(r.status_code for r in responses) == [201, 409]
        [winner] = [r.json() for r in responses if r.status_code == 201]
        async with committed.sessions() as reader:
            statement = select(SavedAddress).where(SavedAddress.user_id == user_id)
            stored = list((await reader.scalars(statement)).all())
        assert len(stored) == MAX
        assert [row.label for row in stored if row.is_default] == [winner["label"]]
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(SavedAddress).where(SavedAddress.user_id == user_id))
            await session.commit()


# Labels


async def test_duplicate_label_case_insensitive_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)
    home = (await create(db_client, headers)).json()
    work = (await create(db_client, headers, label="Work")).json()

    again = await create(db_client, headers, label="  home  ")
    renamed = await patch(db_client, headers, work["id"], label="HOME")
    own_case = await patch(db_client, headers, home["id"], label="HOME")

    assert again.status_code == renamed.status_code == 409
    assert again.json() == renamed.json() == LABEL_TAKEN
    assert own_case.status_code == 200
    assert own_case.json()["label"] == "HOME"  # its own label, in another case
    assert sorted(row.label for row in await rows(db_session, user_id)) == ["HOME", "Work"]


@pytest.mark.parametrize(
    ("label", "status", "stored"),
    [
        ("", 422, None),
        ("   ", 422, None),
        ("a" * 31, 422, None),
        ("Home\tOffice", 422, None),
        ("Home\nOffice", 422, None),
        ("​Home", 422, None),
        ("Home\x00", 422, None),
        ("me@example.com", 422, None),
        ("305-555-0199", 422, None),
        ("www.example.com", 422, None),
        ("contact at example dot com", 422, None),
        ("Mom's", 201, "Mom's"),
        ("Mom's house", 201, "Mom's house"),
        ("Casa 2", 201, "Casa 2"),
        ("Casa da praia", 201, "Casa da praia"),
        ("Trabajo", 201, "Trabajo"),
        ("Apt 4B", 422, None),  # a unit is masked by the redactor, as on develop (#224 r2)
        ("Office #2", 422, None),
        ("a" * 30, 201, "a" * 30),
        ("  Casa   de   mamá ", 201, "Casa de mamá"),
    ],
    ids=[
        "empty",
        "spaces_only",
        "too_long",
        "tab",
        "newline",
        "zero_width_space",
        "nul",
        "email",
        "phone",
        "url",
        "spelled_email",
        "apostrophe",
        "apostrophe_words",
        "digit",
        "portuguese",
        "spanish",
        "unit",
        "unit_hash",
        "max_length",
        "collapsed_spaces",
    ],
)
async def test_label_rules(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    served: None,
    label: str,
    status: int,
    stored: str | None,
) -> None:
    user_id, headers = await caller(db_session)

    response = await create(db_client, headers, label=label)

    assert response.status_code == status
    if stored is None:
        assert response.json() == VALIDATION_ERROR
        assert await rows(db_session, user_id) == []
    else:
        assert response.json()["label"] == stored
        [row] = await rows(db_session, user_id)
        assert row.label == stored


# Coordinates


async def test_coordinates_both_or_neither_and_in_range(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)

    refused = [
        await create(db_client, headers, lat=25.761681),
        await create(db_client, headers, lng=-80.191788),
        await create(db_client, headers, lat=90.000001, lng=0),
        await create(db_client, headers, lat=0, lng=-180.000001),
        await create(db_client, headers, lat="north", lng=0),
    ]
    both = await create(db_client, headers, lat=25.7616811234, lng=-80.191788)
    edge = await create(db_client, headers, label="Edge", lat=-90, lng=180)

    assert [r.status_code for r in refused] == [422] * len(refused)
    assert all(r.json() == VALIDATION_ERROR for r in refused)
    assert both.status_code == edge.status_code == 201
    assert (both.json()["lat"], both.json()["lng"]) == (25.761681, -80.191788)  # six decimals
    assert (edge.json()["lat"], edge.json()["lng"]) == (-90.0, 180.0)
    stored = {row.label: (row.lat, row.lng) for row in await rows(db_session, user_id)}
    assert stored["Home"] == (Decimal("25.761681"), Decimal("-80.191788"))

    half = await patch(db_client, headers, both.json()["id"], lat=1.0)
    one_null = await patch(db_client, headers, both.json()["id"], lat=None, lng=2.0)
    moved = await patch(db_client, headers, both.json()["id"], lat=1.5, lng=2.5)
    cleared = await patch(db_client, headers, both.json()["id"], lat=None, lng=None)

    assert half.status_code == one_null.status_code == 422
    assert moved.status_code == cleared.status_code == 200
    assert (moved.json()["lat"], moved.json()["lng"]) == (1.5, 2.5)
    assert (cleared.json()["lat"], cleared.json()["lng"]) == (None, None)
    stored = {row.label: (row.lat, row.lng) for row in await rows(db_session, user_id)}
    assert stored["Home"] == (None, None)


# The default


async def test_make_default_moves_it_atomically(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)
    home = (await create(db_client, headers)).json()
    work = (await create(db_client, headers, label="Work")).json()

    moved = await patch(db_client, headers, work["id"], is_default=True)
    again = await patch(db_client, headers, work["id"], is_default=True)  # already: no change
    created = await create(db_client, headers, label="Beach", is_default=True)
    unset = await patch(db_client, headers, work["id"], is_default=False)
    nulled = await patch(db_client, headers, work["id"], is_default=None)

    assert moved.status_code == again.status_code == 200
    assert moved.json()["is_default"] is again.json()["is_default"] is True
    assert created.status_code == 201
    assert created.json()["is_default"] is True
    assert unset.status_code == 422
    assert unset.json() == VALIDATION_ERROR
    assert nulled.status_code == 200  # null is "not sent"
    assert nulled.json()["is_default"] is False
    defaults = {row.label: row.is_default for row in await rows(db_session, user_id)}
    assert defaults == {"Home": False, "Work": False, "Beach": True}
    first, *_ = await listed(db_client, headers)
    assert first["label"] == "Beach"
    assert home["is_default"] is True  # it was, when created


async def test_patch_updates_any_subset_and_keeps_the_rest(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)
    home = (await create(db_client, headers, line2="Apt 2", lat=1.0, lng=2.0)).json()

    empty = await patch(db_client, headers, home["id"])
    some = await patch(db_client, headers, home["id"], city="Miami", zip_code=UNSERVED_ZIP)
    unit_gone = await patch(db_client, headers, home["id"], line2=None)
    refused = [
        await patch(db_client, headers, home["id"], label=None),
        await patch(db_client, headers, home["id"], line1=None),
        await patch(db_client, headers, home["id"], state="fl"),
        await patch(db_client, headers, home["id"], zip_code="3280"),
        await patch(db_client, headers, home["id"], user_id=str(uuid.uuid4())),
    ]
    not_a_uuid = await patch(db_client, headers, "not-a-uuid", city="Miami")

    assert empty.status_code == 200
    assert empty.json() == home
    assert some.status_code == 200
    assert some.json() == {**home, "city": "Miami", "zip_code": UNSERVED_ZIP, "served": False}
    assert unit_gone.status_code == 200
    assert unit_gone.json()["line2"] is None
    assert [r.status_code for r in [*refused, not_a_uuid]] == [422] * (len(refused) + 1)
    assert all(r.json() == VALIDATION_ERROR for r in [*refused, not_a_uuid])
    [row] = await rows(db_session, user_id)
    assert (row.label, row.line1, row.line2, row.city, row.state, row.zip_code) == (
        "Home",
        "742 Evergreen Terrace",
        None,
        "Miami",
        "FL",
        UNSERVED_ZIP,
    )
    assert (row.lat, row.lng, row.is_default) == (Decimal("1.000000"), Decimal("2.000000"), True)


async def test_patch_and_delete_other_users_address_is_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    ana_id, ana = await caller(db_session)
    _, bruno = await caller(db_session)
    home = (await create(db_client, ana)).json()
    unknown = uuid.uuid4()

    responses = [
        await patch(db_client, bruno, home["id"], label="Mine"),
        await patch(db_client, ana, unknown, label="Mine"),
        await db_client.delete(f"{BASE}/{home['id']}", headers=bruno),
        await db_client.delete(f"{BASE}/{unknown}", headers=ana),
    ]

    assert [r.status_code for r in responses] == [404] * 4
    assert all(r.json() == NOT_FOUND for r in responses)  # the same body for both cases
    [row] = await rows(db_session, ana_id)
    assert row.label == "Home"
    assert await listed(db_client, bruno) == []


# Delete


async def test_deleting_default_promotes_the_oldest(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)
    home = (await create(db_client, headers)).json()
    work = (await create(db_client, headers, label="Work")).json()
    beach = (await create(db_client, headers, label="Beach")).json()
    park = (await create(db_client, headers, label="Park")).json()
    for n, item in enumerate((home, work, beach, park)):
        await age(db_session, item["id"], n)

    not_default = await db_client.delete(f"{BASE}/{park['id']}", headers=headers)
    after_park = await listed(db_client, headers)
    first = await db_client.delete(f"{BASE}/{home['id']}", headers=headers)
    after_home = await listed(db_client, headers)
    second = await db_client.delete(f"{BASE}/{work['id']}", headers=headers)
    after_work = await listed(db_client, headers)
    last = await db_client.delete(f"{BASE}/{beach['id']}", headers=headers)
    gone = await db_client.delete(f"{BASE}/{beach['id']}", headers=headers)

    assert [r.status_code for r in (not_default, first, second, last)] == [204] * 4
    assert first.content == b""
    assert gone.status_code == 404
    assert [(i["label"], i["is_default"]) for i in after_park] == [
        ("Home", True),  # deleting another address leaves the default alone
        ("Work", False),
        ("Beach", False),
    ]
    assert [(i["label"], i["is_default"]) for i in after_home] == [("Work", True), ("Beach", False)]
    assert [(i["label"], i["is_default"]) for i in after_work] == [("Beach", True)]
    assert await listed(db_client, headers) == []
    assert await rows(db_session, user_id) == []


# Requests keep their own address


async def test_editing_or_deleting_a_saved_address_never_changes_a_request(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    app.dependency_overrides[get_storage] = lambda: FakeStorage()
    app.dependency_overrides[get_job_queue] = lambda: RecordingQueue()
    user_id, headers = await caller(db_session)
    saved = (await create(db_client, headers)).json()
    address = {name: saved[name] for name in ("line1", "line2", "city", "state", "zip_code")}
    request = await db_client.post(
        "/v1/requests",
        json={"description": "Water leaks under the kitchen sink", "address": address},
        headers=headers,
    )
    assert request.status_code == 201
    request_id = request.json()["id"]
    # Dispatched (the worker's move, #48) and sent to a pro, who sees its area (#49).
    async with as_status_writer(db_session):  # the database guard (#163)
        await db_session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == uuid.UUID(request_id))
            .values(status=RequestStatus.FINDING_PRO)
        )
    pro_user_id, pro = await caller(db_session, UserRole.PRO)
    profile = ProProfile(user_id=pro_user_id)
    db_session.add(profile)
    await db_session.flush()
    dispatch = RequestDispatch(
        request_id=uuid.UUID(request_id),
        pro_id=profile.id,
        status=DispatchStatus.SENT,
        sent_at=T0,
    )
    db_session.add(dispatch)
    await db_session.flush()
    opportunity = f"/v1/pros/me/opportunities/{dispatch.id}"
    before = (await db_client.get(f"/v1/requests/{request_id}", headers=headers)).json()
    seen = await db_client.get(opportunity, headers=pro)
    assert seen.status_code == 200, seen.json()
    seen_before = seen.json()

    edited = await patch(
        db_client,
        headers,
        saved["id"],
        label="Old home",
        line1="1 Other Street",
        line2="Unit 9",
        city="Miami",
        zip_code="33101",
    )
    removed = await db_client.delete(f"{BASE}/{saved['id']}", headers=headers)

    assert edited.status_code == 200
    assert removed.status_code == 204
    after = (await db_client.get(f"/v1/requests/{request_id}", headers=headers)).json()
    seen_after = (await db_client.get(opportunity, headers=pro)).json()
    assert after["address"] == before["address"] == address
    assert (
        seen_after["location"]
        == seen_before["location"]
        == {"zip_code": SERVED_ZIP, "city": "Orlando"}
    )
    # The request's own addresses row is untouched, and no saved address remains.
    [snapshot] = list(
        (await db_session.scalars(select(Address).where(Address.user_id == user_id))).all()
    )
    assert (snapshot.line1, snapshot.city, snapshot.zip_code) == (
        "742 Evergreen Terrace",
        "Orlando",
        SERVED_ZIP,
    )
    assert await rows(db_session, user_id) == []


# Access


@pytest.mark.parametrize("role", [UserRole.PRO, UserRole.AGENT, UserRole.ADMIN])
async def test_non_customers_get_403(
    db_client: httpx.AsyncClient, db_session: AsyncSession, role: UserRole
) -> None:
    _, headers = await caller(db_session, role)
    some_id = uuid.uuid4()

    responses = [
        await db_client.get(BASE, headers=headers),
        await create(db_client, headers),
        await patch(db_client, headers, some_id, label="Mine"),
        await db_client.delete(f"{BASE}/{some_id}", headers=headers),
    ]

    assert [r.status_code for r in responses] == [403] * 4
    assert all(r.json() == FORBIDDEN for r in responses)


async def test_unauthenticated_401(db_client: httpx.AsyncClient) -> None:
    some_id = uuid.uuid4()
    for response in (
        await db_client.get(BASE),
        await db_client.post(BASE, json=body()),
        await db_client.patch(f"{BASE}/{some_id}", json={"label": "Mine"}),
        await db_client.delete(f"{BASE}/{some_id}"),
    ):
        assert response.status_code == 401


# Privacy


async def test_no_address_text_in_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    served: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _, headers = await caller(db_session)
    probe = {
        "label": "Probe label",
        "line1": "742 Probe Terrace",
        "line2": "Apt probe-2",
        "city": "Probeville",
        "state": "FL",
        "zip_code": "32801-9876",
        "lat": 25.761681,
        "lng": -80.191788,
    }

    with caplog.at_level(logging.DEBUG):
        created = await create(db_client, headers, **probe)
        address_id = created.json()["id"]
        edited = await patch(db_client, headers, address_id, label="Probe two", city="Probetown")
        await listed(db_client, headers)
        removed = await db_client.delete(f"{BASE}/{address_id}", headers=headers)

    assert (created.status_code, edited.status_code, removed.status_code) == (201, 200, 204)
    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for piece in (
        "Probe label",
        "Probe two",
        "742 Probe",
        "Apt probe-2",
        "Probeville",
        "Probetown",
        "32801-9876",
        "25.761681",
        "80.191788",
    ):
        assert piece not in output
    events = {
        record.message: json.loads(JsonFormatter().format(record))
        for record in caplog.records
        if record.message.startswith("saved_address_")
    }
    standard = {"timestamp", "level", "logger", "message", "request_id"}
    assert set(events["saved_address_created"]) - standard == {
        "user_id",
        "address_id",
        "count",
        "is_default",
    }
    assert set(events["saved_address_updated"]) - standard == {
        "user_id",
        "address_id",
        "changed",
        "made_default",
    }
    assert set(events["saved_address_deleted"]) - standard == {
        "user_id",
        "address_id",
        "promoted_id",
    }
    assert events["saved_address_created"]["address_id"] == address_id


# Contract


def test_openapi_documents_every_error_code(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    item = f"{BASE}/{{address_id}}"

    def responses(path: str, method: str) -> dict[str, Any]:
        documented: dict[str, Any] = paths[path][method]["responses"]
        return documented

    assert set(responses(BASE, "get")) == {"200", "401", "403", "422"}
    assert set(responses(BASE, "post")) == {"201", "401", "403", "409", "422", "429"}
    assert set(responses(item, "patch")) == {"200", "401", "403", "404", "409", "422", "429"}
    assert set(responses(item, "delete")) == {"204", "401", "403", "404", "422", "429"}
    conflict = responses(BASE, "post")["409"]["description"]
    assert "address_limit_reached" in conflict
    assert "address_label_taken" in conflict
    assert "address_label_taken" in responses(item, "patch")["409"]["description"]
    for method in ("patch", "delete"):
        assert "address_not_found" in responses(item, method)["404"]["description"]
    for path, method in ((BASE, "post"), (item, "patch"), (item, "delete")):
        limited = responses(path, method)["429"]
        assert "rate_limited" in limited["description"]
        assert limited["headers"]["Retry-After"]["schema"] == {"type": "integer"}
        for status in ("401", "403", "404", "409", "422", "429"):
            documented = responses(path, method).get(status)
            if documented is not None:
                schema = documented["content"]["application/json"]["schema"]
                assert schema == {"$ref": "#/components/schemas/ErrorResponse"}


# Review round 1 (#224): contact handles, invisible fillers, the write limit, and races


CONTACT_LABELS = [
    "\uff04testperson",  # FULLWIDTH DOLLAR SIGN: a cashtag
    "\ufe69testperson",  # SMALL DOLLAR SIGN
    "$name",
    "\uff20name",  # FULLWIDTH COMMERCIAL AT
    "@name.com",
    "@home.fixit",
    "@home_fixit",
    "@home-fixit",
    "@work.fixit",
    "@5pm.fixit",
    "@home" + chr(0x0335) + "fixit",  # a combining mark glued to the exempt word
    # Round 2: a run of separators, and separators in a compatibility form.
    "@home--fixit",
    "@home..fixit",
    "@home._fixit",
    "@home" + chr(0xFF3F) + "fixit",  # FULLWIDTH LOW LINE: "_" under NFKC
    "@home" + chr(0xFE4D) + "fixit",  # DASHED LOW LINE: "_" under NFKC
    "@home" + chr(0x2010) + "fixit",  # HYPHEN
    "@home" + chr(0x2024) + "fixit",  # ONE DOT LEADER: "." under NFKC
    # #229: marks outside the Latin blocks, a spacing mark (Mc) and a mark beyond the BMP.
    "@home" + chr(0x0483) + "fixit",  # COMBINING CYRILLIC TITLO
    "@home" + chr(0x05B0) + "fixit",  # HEBREW POINT SHEVA
    "@home" + chr(0x093F) + "fixit",  # DEVANAGARI VOWEL SIGN I (Mc)
    "@home" + chr(0x1D167) + "fixit",  # MUSICAL SYMBOL COMBINING TREMOLO-1
    # #236: Unicode letters in the handle body, and a mark inside a cashtag.
    "@mañana.fixit",
    "@josé_silva",
    "$bob" + chr(0x0483) + "smith",
    # Round 2: a phone glued to a unit marker, which the skipped unit step used to catch.
    "APT3055550199",
    "UNIT3055550199",
    "SUITE3055550199",
    "PO BOX3055550199",
]


@pytest.mark.parametrize("method", ["post", "patch"])
@pytest.mark.parametrize(
    "label",
    CONTACT_LABELS,
    ids=[
        "fullwidth_dollar",
        "small_dollar",
        "dollar",
        "fullwidth_at",
        "at_domain",
        "at_home_dot",
        "at_home_underscore",
        "at_home_dash",
        "at_work_dot",
        "at_time_dot",
        "at_home_mark",
        "at_home_two_dashes",
        "at_home_two_dots",
        "at_home_dot_underscore",
        "at_home_fullwidth_low_line",
        "at_home_dashed_low_line",
        "at_home_hyphen",
        "at_home_dot_leader",
        "at_home_cyrillic_mark",
        "at_home_hebrew_mark",
        "at_home_devanagari_mark",
        "at_home_musical_mark",
        "at_enye_dot",
        "at_accented_underscore",
        "cashtag_cyrillic_mark",
        "apt_phone",
        "unit_phone",
        "suite_phone",
        "po_box_phone",
    ],
)
async def test_label_rejects_contacts(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    served: None,
    method: str,
    label: str,
) -> None:
    user_id, headers = await caller(db_session)
    if method == "post":
        response = await create(db_client, headers, label=label)
    else:
        home = (await create(db_client, headers)).json()
        response = await patch(db_client, headers, home["id"], label=label)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    labels = [row.label for row in await rows(db_session, user_id)]
    assert labels == ([] if method == "post" else ["Home"])


async def test_label_invisible_fillers(
    db_client: httpx.AsyncClient, db_session: AsyncSession, served: None
) -> None:
    user_id, headers = await caller(db_session)

    home = await create(db_client, headers)  # "Home"
    joiner = await create(db_client, headers, label="Home\u034f")
    selector = await create(db_client, headers, label="Home\ufe0f")
    supplement = await create(db_client, headers, label="Ho\U000e0100me")
    blank = [
        await create(db_client, headers, label=filler)
        for filler in ("\u3164", "\u2800", "\u115f\u1160", " \u034f ", "\u0301\u0301")
    ]
    cafe = await create(db_client, headers, label="Cafe" + chr(0x0301))  # NFD: e + acute
    cafe_again = await create(db_client, headers, label="Caf" + chr(0x00E9))  # NFC
    # A filler between the "e" and its accent (#224 round 2): removed before composition, so
    # the label composes and collides with "Café".
    split = [
        await create(db_client, headers, label="Cafe" + filler + chr(0x0301))
        for filler in (chr(0x034F), chr(0xFE0F), chr(0x3164))
    ]
    moved = await patch(db_client, headers, cafe.json()["id"], label="Home" + chr(0xFE0F))
    moved_split = await patch(
        db_client, headers, home.json()["id"], label="Cafe" + chr(0x034F) + chr(0x0301)
    )
    jose = await create(db_client, headers, label="Jose" + chr(0xFE0F) + chr(0x0301))

    assert home.status_code == 201
    assert [r.status_code for r in (joiner, selector, supplement)] == [409] * 3
    assert joiner.json() == LABEL_TAKEN
    assert [r.status_code for r in blank] == [422] * 5
    assert blank[0].json() == VALIDATION_ERROR
    assert cafe.status_code == 201
    assert cafe.json()["label"] == "Caf" + chr(0x00E9)
    assert cafe_again.status_code == 409
    assert [r.status_code for r in split] == [409] * 3
    assert split[0].json() == LABEL_TAKEN
    assert moved.status_code == 409
    assert moved_split.status_code == 409
    assert jose.status_code == 201
    assert jose.json()["label"] == "Jos" + chr(0x00E9)  # stored composed
    assert sorted(row.label for row in await rows(db_session, user_id)) == [
        "Caf" + chr(0x00E9),
        "Home",
        "Jos" + chr(0x00E9),
    ]


async def test_saved_address_writes_rate_limited(db_session: AsyncSession, served: None) -> None:
    app = make_app(
        make_settings(
            saved_addresses_max_per_user=MAX,
            saved_address_write_limit=WRITE_LIMIT,
            saved_address_write_window_seconds=WRITE_WINDOW,
        )
    )
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        ana_id, ana = await caller(db_session)
        bruno_id, bruno = await caller(db_session)
        home = await create(client, ana)
        renamed = await patch(client, ana, home.json()["id"], label="Casa")
        work = await create(client, ana, label="Work")
        deleted = await client.delete(f"{BASE}/{work.json()['id']}", headers=ana)
        again = await create(client, ana, label="Work")  # the fifth write: the limit
        limited_patch = await patch(client, ana, home.json()["id"], label="Home")
        limited_post = await create(client, ana, label="Beach")
        limited_delete = await client.delete(f"{BASE}/{again.json()['id']}", headers=ana)
        reads = await client.get(BASE, headers=ana)
        other = await create(client, bruno)

    statuses = [r.status_code for r in (home, renamed, work, deleted, again)]
    assert statuses == [201, 200, 201, 204, 201]
    for limited in (limited_patch, limited_post, limited_delete):
        assert limited.status_code == 429
        assert limited.json() == RATE_LIMITED
        assert int(limited.headers["Retry-After"]) >= 1
    assert reads.status_code == 200  # reads are not limited
    assert [item["label"] for item in reads.json()["items"]] == ["Casa", "Work"]
    assert other.status_code == 201  # another customer has their own budget
    index, _ = window_position(NOW, WRITE_WINDOW)
    assert limiter.counts == {  # the key is the user id only
        f"saved_address_write:{ana_id}:{index}": WRITE_LIMIT + 3,
        f"saved_address_write:{bruno_id}:{index}": 1,
    }


async def committed_customer(
    committed: Committed, labels: list[str]
) -> tuple[uuid.UUID, dict[str, str], dict[str, str]]:
    """A registered customer with `labels` as committed addresses, the first the default and
    the oldest: the user id, the auth headers and each label's address id."""
    account = (await register_account(committed.client, email=committed.email)).json()
    user_id = uuid.UUID(account["user"]["id"])
    headers = {"Authorization": f"Bearer {account['access_token']}"}
    ids: dict[str, str] = {}
    async with committed.sessions() as session:
        for n, label in enumerate(labels):
            row = SavedAddress(
                user_id=user_id,
                label=label,
                line1="742 Evergreen Terrace",
                city="Orlando",
                state="FL",
                zip_code=SERVED_ZIP,
                is_default=n == 0,
            )
            session.add(row)
            await session.flush()
            await age(session, str(row.id), n)
            ids[label] = str(row.id)
        await session.commit()
    return user_id, headers, ids


async def purge(committed: Committed, user_id: uuid.UUID) -> None:
    async with committed.sessions() as session:
        await session.execute(delete(SavedAddress).where(SavedAddress.user_id == user_id))
        await session.commit()


def hold_first_get_own(committed: Committed, monkeypatch: pytest.MonkeyPatch) -> list[uuid.UUID]:
    """SavedAddressRepository.get_own holds the first caller's transaction, its user lock
    taken, until Postgres reports another backend waiting on that lock. Returns the list that
    receives the held caller's address id. Without the lock the second caller never waits and
    both read the same state."""
    held: list[uuid.UUID] = []
    get_own = SavedAddressRepository.get_own

    async def get_own_then_hold(
        self: SavedAddressRepository, owner_id: uuid.UUID, address_id: uuid.UUID
    ) -> SavedAddress | None:
        row = await get_own(self, owner_id, address_id)
        if not held:
            held.append(address_id)
            await wait_until_blocking(committed.sessions, holder=await backend_pid(self._session))
        return row

    monkeypatch.setattr(SavedAddressRepository, "get_own", get_own_then_hold)
    return held


async def test_concurrent_default_moves_leave_one_default(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    user_id, headers, ids = await committed_customer(committed, ["Home", "Work", "Beach"])
    held = hold_first_get_own(committed, monkeypatch)
    try:
        responses = await asyncio.gather(
            patch(committed.client, headers, ids["Work"], is_default=True),
            patch(committed.client, headers, ids["Beach"], is_default=True),
        )

        assert [r.status_code for r in responses] == [200, 200]
        assert [r.json()["is_default"] for r in responses] == [True, True]
        async with committed.sessions() as reader:
            defaults = {row.label: row.is_default for row in await rows(reader, user_id)}
        # The holder commits first; the move that waited on the lock commits last and wins.
        [first] = held
        last = "Beach" if str(first) == ids["Work"] else "Work"
        assert defaults == {"Home": False, "Work": last == "Work", "Beach": last == "Beach"}
    finally:
        await purge(committed, user_id)


async def test_deleting_the_default_racing_a_default_move(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    user_id, headers, ids = await committed_customer(committed, ["Home", "Work"])
    held = hold_first_get_own(committed, monkeypatch)
    try:
        deleted, moved = await asyncio.gather(
            committed.client.delete(f"{BASE}/{ids['Home']}", headers=headers),
            patch(committed.client, headers, ids["Work"], is_default=True),
        )

        # Either order ends the same: Work is the one address and the default, whether the
        # delete promoted it or the move made it so before the delete found nothing to promote.
        assert (deleted.status_code, moved.status_code) == (204, 200)
        assert moved.json()["is_default"] is True
        assert len(held) == 1
        async with committed.sessions() as reader:
            stored = await rows(reader, user_id)
        assert [(row.label, row.is_default) for row in stored] == [("Work", True)]
    finally:
        await purge(committed, user_id)


ADVISORY_LOCKS = text(
    "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'"
    " AND database = (SELECT oid FROM pg_database WHERE datname = current_database())"
)


@pytest.mark.parametrize("write", ["create", "update"])
async def test_rollback_after_a_flushed_write_releases_the_lock(
    committed: Committed, monkeypatch: pytest.MonkeyPatch, write: str
) -> None:
    user_id, headers, ids = await committed_customer(committed, ["Home"])
    failed_once: list[bool] = []
    is_served = ServiceAreaService.is_served

    async def fail_after_flush(self: ServiceAreaService, zip_code: str) -> bool:
        # The service asks whether the ZIP is served after the row was flushed, before the
        # commit: the first write fails there, once.
        if not failed_once:
            failed_once.append(True)
            raise RuntimeError("storage failed after the flush")
        return await is_served(self, zip_code)

    monkeypatch.setattr(ServiceAreaService, "is_served", fail_after_flush)
    try:
        if write == "create":
            failed = await create(committed.client, headers, label="Work")
        else:
            failed = await patch(committed.client, headers, ids["Home"], label="Casa")

        assert failed.status_code == 500
        async with committed.sessions() as reader:
            stored = await rows(reader, user_id)
            advisory = await reader.scalar(ADVISORY_LOCKS)
        assert [(row.label, row.is_default) for row in stored] == [("Home", True)]
        assert advisory == 0  # the user's lock went with the rollback
        # So the next write by the same customer goes through without waiting.
        retried = await asyncio.wait_for(
            create(committed.client, headers, label="Work"), LOCK_WAIT_DEADLINE_SECONDS
        )
        assert retried.status_code == 201
    finally:
        await purge(committed, user_id)
