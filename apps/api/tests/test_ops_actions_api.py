"""The BDC's actions on a request (#82, part 1): internal notes, mark contacted, classify,
follow-ups and the follow-ups due. Rolled-back session, the clock fixed; the two-agent race
runs on real commits (the queue tests' racers, whose audit writes are recorded)."""

import asyncio
import logging
import re
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.addresses.models import Address
from app.modules.audit.models import AuditLog
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction
from app.modules.categories.models import Category
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.dispatch.tasks import redispatch_for_pro, sweep_stalled
from app.modules.jobs.models import JobStatus
from app.modules.ops.actions import ActionsConfig, OpsActions
from app.modules.ops.errors import QueueRequestNotFoundError
from app.modules.ops.models import RequestFollowup, RequestNote
from app.modules.ops.router import get_ops_clock
from app.modules.pros.models import (
    ProCategory,
    ProProfile,
    ProServiceArea,
    ProVerificationStatus,
)
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.requests.queue import RequestQueueReader
from app.modules.reviews.models import Review, ReviewAuthorRole
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.modules.users.types import UserRole, UserStatus
from app.rate_limit import get_rate_limiter
from tests.conftest import Committed, InMemoryRateLimiter, make_settings
from tests.helpers import letter_tag
from tests.job_world import (
    PRO_EMAIL,
    PRO_PHONE,
    JobWorld,
    Party,
    Pro,
    headers_for,
    make_job,
    record_pushes,
)
from tests.ratings_seed import confirmed_job, rate
from tests.test_dispatch import sessions_of
from tests.test_ops_queue_api import (
    BASE,
    HELD,
    make_request,
    request_row,
)
from tests.test_ops_queue_api import racers as racers
from tests.test_ops_queue_api import storage as storage
from tests.test_ops_queue_api import world as world
from tests.test_pros_profile_api import FakeStorage
from tests.test_redispatch import memory_history, sweep_ctx
from tests.test_requests_api import RecordingQueue

# 10:00 EST, 9 March 2031: New York moves to EDT at 02:00 that day (the day is 23 hours).
NOW: Final = datetime(2031, 3, 9, 15, 0, tzinfo=UTC)
# The end of that day in New York: 00:00 EDT on 10 March.
END_OF_DAY: Final = datetime(2031, 3, 10, 4, 0, tzinfo=UTC)
NOTE: Final = "zq82 note-sentinel: called twice, voicemail"
FOLLOWUPS: Final = "/v1/admin/followups"
MAX_DAYS: Final = 30


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        ops_followup_max_days=MAX_DAYS,
        business_time_zone="America/New_York",
        request_list_default_limit=2,
    )


@pytest.fixture
def clock(app: FastAPI) -> Clock:
    fixed = Clock()
    app.dependency_overrides[get_ops_clock] = lambda: fixed
    return fixed


def path(request_id: uuid.UUID, action: str) -> str:
    return f"{BASE}/{request_id}/{action}"


async def act(
    client: httpx.AsyncClient, party: Party, request_id: uuid.UUID, action: str, **body: Any
) -> httpx.Response:
    return await client.post(path(request_id, action), json=body or None, headers=party.headers)


def followup_body(due: timedelta = timedelta(hours=3), **extra: Any) -> dict[str, Any]:
    return {"due_at": (NOW + due).isoformat(), "note": "Call back after 2 pm", **extra}


async def audits(session: AsyncSession, request_id: uuid.UUID, action: AuditAction) -> list[Any]:
    statement = select(AuditLog).where(
        AuditLog.entity_id == request_id, AuditLog.action == action.value
    )
    return list((await session.scalars(statement)).all())


async def staff(session: AsyncSession, role: UserRole) -> Party:
    from app.modules.users.models import User

    user = User(email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role)
    session.add(user)
    await session.flush()
    return Party(user.id, headers_for(user.id, role))


ACTIONS: Final = [
    ("notes", {"body": "x"}),
    ("contacted", {}),
    ("classify", {"category_id": "CATEGORY"}),
    ("followups", "FOLLOWUP"),
    ("more-info", {"question": "x"}),
    ("resume", {}),
]
# A status change cannot be made twice (the holder's, then the admin's): its roles have their
# own test; the demoted actor's is in the table.
STATUS_CHANGE: Final = ("status", {"to": "cancelled", "reason": "x"})
# An assignment needs a pro who can take the request (its roles have their own test); the
# demoted actor is refused before the pro is looked at.
ASSIGNMENT: Final = ("assign", {"pro_id": "PRO"})
_FROM_THE_WORLD: Final = {
    "CATEGORY": lambda world: str(world.category_id),
    "PRO": lambda world: str(world.pro.profile_id),
}


def body_of(spec: Any, world: JobWorld) -> dict[str, Any]:
    if spec == "FOLLOWUP":
        return followup_body()
    return {
        key: _FROM_THE_WORLD[value](world) if value in _FROM_THE_WORLD else value
        for key, value in spec.items()
    }


# --- Who --------------------------------------------------------------------------------------


@pytest.mark.parametrize(("action", "spec"), ACTIONS)
async def test_only_staff_act_and_a_held_request_needs_its_holder_or_an_admin(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    action: str,
    spec: Any,
) -> None:
    request = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    request_id = request.id
    other_agent = await staff(db_session, UserRole.AGENT)
    await db_session.commit()
    body = body_of(spec, world)

    anonymous = await db_client.post(path(request_id, action), json=body or None)
    customer = await act(db_client, world.customer, request_id, action, **body)
    pro = await act(db_client, world.pro, request_id, action, **body)
    held = await act(db_client, other_agent, request_id, action, **body)
    holder = await act(db_client, world.agent, request_id, action, **body)
    admin = await act(db_client, world.admin, request_id, action, **body)

    assert (anonymous.status_code, customer.status_code, pro.status_code) == (401, 403, 403)
    assert (held.status_code, held.json()) == (409, HELD)
    assert holder.status_code in (200, 201), holder.text
    assert admin.status_code in (200, 201), admin.text
    for response in (anonymous, customer, held, holder):
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(("action", "spec"), [*ACTIONS, STATUS_CHANGE, ASSIGNMENT])
async def test_an_actor_demoted_since_authentication_writes_nothing(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    action: str,
    spec: Any,
) -> None:
    """Checked again in the writing transaction, as last committed: an agent demoted after
    their token was read is refused and nothing is written."""
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()
    pushes = record_pushes(app)  # an assignment's route takes the queue
    original = RequestQueueReader.lock

    async def demote_then_lock(self: RequestQueueReader, request_id: uuid.UUID) -> Any:
        await db_session.execute(
            text("UPDATE users SET role = 'customer' WHERE id = :id"), {"id": world.agent.id}
        )
        return await original(self, request_id)

    monkeypatch.setattr(RequestQueueReader, "lock", demote_then_lock)

    response = await act(db_client, world.agent, request_id, action, **body_of(spec, world))

    assert response.status_code == 403, response.text
    row = await request_row(db_session, request_id)
    assert row.first_contact_at is None
    assert (row.status, row.info_requested_at) == (RequestStatus.RECEIVED, None)
    assert (
        await db_session.scalars(select(RequestNote).where(RequestNote.request_id == request_id))
    ).all() == []
    assert (
        await db_session.scalars(select(AuditLog).where(AuditLog.entity_id == request_id))
    ).all() == []
    assert (
        await db_session.scalars(
            select(RequestFollowup).where(RequestFollowup.request_id == request_id)
        )
    ).all() == []
    assert (
        await db_session.scalars(
            select(RequestDispatch).where(RequestDispatch.request_id == request_id)
        )
    ).all() == []
    assert pushes.jobs == {}


# --- Notes ------------------------------------------------------------------------------------


async def test_a_note_is_kept_as_written_shown_on_the_card_and_audited_without_its_text(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    added = await act(db_client, world.agent, request_id, "notes", body=f"  {NOTE}  ")

    assert added.status_code == 201, added.text
    assert (added.json()["body"], added.json()["author"]["id"]) == (NOTE, str(world.agent.id))
    card = (await db_client.get(f"{BASE}/{request_id}", headers=world.admin.headers)).json()
    assert [note["body"] for note in card["notes"]] == [NOTE]
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_NOTE_ADD)
    assert (audit.actor_user_id, audit.after) == (
        world.agent.id,
        {"note_id": added.json()["id"], "length": len(NOTE)},
    )
    assert NOTE not in caplog.text + "".join(str(r.__dict__) for r in caplog.records)


@pytest.mark.parametrize(
    "body", ["", "   ", "x" * 2001, "a\x00b"], ids=["empty", "blank", "long", "nul"]
)
async def test_a_note_is_plain_text_of_1_to_2000_characters(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, body: str
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    response = await act(db_client, world.agent, request_id, "notes", body=body)

    assert response.status_code == 422


async def test_notes_never_reach_a_customer_or_pro_answer(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    storage: FakeStorage,
    clock: Clock,
) -> None:
    """Every GET route outside /v1/admin, read as the job's customer and as its pro with the
    job's own ids: the note's text appears in none of their answers. Every answer is a real
    one: never an internal error, which would hide a leak (the routes that presign media
    need the storage, some the queue), and the views of the note's own request and job
    answer their owners."""
    app.dependency_overrides[get_storage] = lambda: storage
    record_pushes(app)
    job = await make_job(db_session, world, JobStatus.SCHEDULED)
    await db_session.commit()
    assert (
        await act(db_client, world.admin, job.request_id, "notes", body=NOTE)
    ).status_code == 201
    params = {"request_id": job.request_id, "job_id": job.id, "quote_id": job.quote_id}
    answered: dict[tuple[str, str], int] = {}
    for route, operations in app.openapi()["paths"].items():
        if "get" not in operations:
            continue
        if not route.startswith("/v1/") or route.startswith("/v1/admin"):
            continue
        names = re.findall(r"{(\w+)}", route)
        if any(name not in params for name in names):
            continue
        url = route.format(**{name: params[name] for name in names})
        for name, party in (("customer", world.customer), ("pro", world.pro)):
            response = await db_client.get(url, headers=party.headers)
            answered[(name, route)] = response.status_code
            assert response.status_code != 500, (name, url, response.text)
            assert NOTE not in response.text, (name, url)
    assert len(answered) > 10
    for owner in [
        ("customer", "/v1/requests"),
        ("customer", "/v1/requests/{request_id}"),
        ("customer", "/v1/requests/{request_id}/quotes"),
        ("customer", "/v1/requests/{request_id}/job"),
        ("pro", "/v1/pros/me/jobs"),
        ("pro", "/v1/pros/me/jobs/{job_id}"),
        ("pro", "/v1/pros/me/opportunities"),
    ]:
        assert answered[owner] == 200, owner


# --- Mark contacted ---------------------------------------------------------------------------


async def test_mark_contacted_sets_the_first_contact_once(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    first = await act(db_client, world.agent, request_id, "contacted")
    clock.now = NOW + timedelta(minutes=5)
    again = await act(db_client, world.admin, request_id, "contacted")

    assert (first.status_code, again.status_code) == (200, 200)
    assert first.json()["first_contact_at"] == again.json()["first_contact_at"]
    assert datetime.fromisoformat(first.json()["first_contact_at"]) == NOW
    assert (await request_row(db_session, request_id)).first_contact_at == NOW
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_MARK_CONTACTED)
    assert audit.actor_user_id == world.agent.id


async def test_two_agents_marking_contacted_at_once_write_it_once(racers: Any) -> None:
    contacted = f"{BASE}/{racers.request_id}/contacted"

    async with asyncio.timeout(15):
        responses = await asyncio.gather(
            *(racers.client.post(contacted, headers=agent.headers) for agent in racers.agents)
        )

    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json()["first_contact_at"] == responses[1].json()["first_contact_at"]
    assert [action for _, action in racers.audited] == [AuditAction.REQUEST_MARK_CONTACTED]


# --- Classify ---------------------------------------------------------------------------------


@pytest.mark.parametrize("status", list(RequestStatus))
async def test_classify_only_before_dispatch_and_to_an_active_category(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    status: RequestStatus,
) -> None:
    request = await make_request(db_session, world, status, category_id=None)
    request_id = request.id
    other = Category(slug=f"zq82-{uuid.uuid4().hex[:6]}", names={"en": "Roofing", "es": "Techos"})
    retired = Category(
        slug=f"zq82r-{uuid.uuid4().hex[:6]}", names={"en": "Old", "es": "Viejo"}, active=False
    )
    db_session.add_all([other, retired])
    await db_session.commit()

    response = await act(db_client, world.agent, request_id, "classify", category_id=str(other.id))

    if status in (RequestStatus.RECEIVED, RequestStatus.REVIEWING):
        assert response.status_code == 200, response.text
        assert (await request_row(db_session, request_id)).category_id == other.id
        [audit] = await audits(db_session, request_id, AuditAction.REQUEST_CLASSIFY)
        assert audit.after == {"category_id": str(other.id), "status": status.value}
        refused = await act(
            db_client, world.agent, request_id, "classify", category_id=str(retired.id)
        )
        assert (refused.status_code, refused.json()["error"]["code"]) == (
            422,
            "category_inactive",
        )
        unknown = await act(
            db_client, world.agent, request_id, "classify", category_id=str(uuid.uuid4())
        )
        assert (unknown.status_code, unknown.json()["error"]["code"]) == (
            422,
            "category_inactive",
        )
    else:
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "request_not_classifiable"
        assert (await request_row(db_session, request_id)).category_id is None
        assert await audits(db_session, request_id, AuditAction.REQUEST_CLASSIFY) == []


# --- Follow-ups -------------------------------------------------------------------------------


async def test_a_followup_is_due_ahead_and_given_to_staff_only_by_an_admin(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    mine = await act(db_client, world.agent, request_id, "followups", **followup_body())
    past = await act(
        db_client, world.agent, request_id, "followups", **followup_body(-timedelta(minutes=1))
    )
    far = await act(
        db_client,
        world.agent,
        request_id,
        "followups",
        **followup_body(timedelta(days=MAX_DAYS, minutes=1)),
    )
    agent_gives = await act(
        db_client,
        world.agent,
        request_id,
        "followups",
        **followup_body(assigned_to=str(world.admin.id)),
    )
    admin_gives = await act(
        db_client,
        world.admin,
        request_id,
        "followups",
        **followup_body(assigned_to=str(world.agent.id)),
    )
    to_a_customer = await act(
        db_client,
        world.admin,
        request_id,
        "followups",
        **followup_body(assigned_to=str(world.customer.id)),
    )

    assert mine.status_code == 201, mine.text
    assert mine.json()["assigned_to"]["id"] == str(world.agent.id)
    assert (past.status_code, far.status_code) == (422, 422)
    assert {past.json()["error"]["code"], far.json()["error"]["code"]} == {
        "followup_due_out_of_range"
    }
    assert agent_gives.status_code == 403
    assert admin_gives.status_code == 201
    assert admin_gives.json()["assigned_to"]["id"] == str(world.agent.id)
    assert (to_a_customer.status_code, to_a_customer.json()["error"]["code"]) == (
        422,
        "assignee_not_staff",
    )
    rows = await audits(db_session, request_id, AuditAction.REQUEST_FOLLOWUP_SCHEDULE)
    assert sorted(str(row.actor_user_id) for row in rows) == sorted(
        [str(world.agent.id), str(world.admin.id)]
    )
    assert all("note" not in row.after for row in rows)


async def test_a_followup_is_done_once_by_its_assignee_or_an_admin(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    other_agent = await staff(db_session, UserRole.AGENT)
    await db_session.commit()
    first = (await act(db_client, world.agent, request_id, "followups", **followup_body())).json()
    second = (await act(db_client, world.agent, request_id, "followups", **followup_body())).json()
    done = f"followups/{first['id']}/done"

    stranger = await act(db_client, other_agent, request_id, done)
    clock.now = NOW + timedelta(hours=1)
    by_assignee = await act(db_client, world.agent, request_id, done)
    again = await act(db_client, world.agent, request_id, done)
    by_admin = await act(db_client, world.admin, request_id, f"followups/{second['id']}/done")
    elsewhere = await act(db_client, world.agent, (await make_request(db_session, world)).id, done)

    assert stranger.status_code == 403
    assert (by_assignee.status_code, again.status_code, by_admin.status_code) == (200, 200, 200)
    assert by_assignee.json()["done_at"] == again.json()["done_at"]
    assert elsewhere.status_code == 404
    rows = await audits(db_session, request_id, AuditAction.REQUEST_FOLLOWUP_DONE)
    assert len(rows) == 2


async def _followup(
    session: AsyncSession, world: JobWorld, request: ServiceRequest, due_at: datetime, **fields: Any
) -> RequestFollowup:
    followup = RequestFollowup(
        request_id=request.id,
        assigned_to=fields.pop("assigned_to", world.agent.id),
        created_by=world.agent.id,
        due_at=due_at,
        note="zq82",
        **fields,
    )
    session.add(followup)
    await session.flush()
    return followup


async def test_due_today_ends_at_the_business_day_s_midnight_across_a_dst_change(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    public_code = request.public_code
    overdue = await _followup(db_session, world, request, NOW - timedelta(days=2))
    last_minute = await _followup(db_session, world, request, END_OF_DAY - timedelta(seconds=1))
    await _followup(db_session, world, request, END_OF_DAY)  # tomorrow, 00:00 EDT
    await _followup(
        db_session, world, request, NOW - timedelta(hours=1), done_at=NOW, done_by=world.agent.id
    )
    await _followup(db_session, world, request, NOW, assigned_to=world.admin.id)
    expected = [str(overdue.id), str(last_minute.id)]
    await db_session.commit()

    first = (await db_client.get(FOLLOWUPS, headers=world.agent.headers)).json()
    everything = (
        await db_client.get(
            FOLLOWUPS, params={"due": "all", "limit": 10}, headers=world.agent.headers
        )
    ).json()

    # Overdue first, then due the last second of the 23-hour day; none of tomorrow's.
    assert [item["id"] for item in first["items"]] == expected
    assert first["next_cursor"] is None
    assert len(everything["items"]) == 3
    item = first["items"][0]
    assert (item["public_code"], item["request_status"]) == (public_code, "received")
    assert "phone" not in str(first)
    assert "email" not in str(first)


async def test_followups_page_stably_and_only_an_admin_reads_another_s(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    same = sorted([str((await _followup(db_session, world, request, NOW)).id) for _ in range(3)])
    await db_session.commit()

    pages: list[str] = []
    cursor = None
    while True:
        params: dict[str, str] = {"cursor": cursor} if cursor else {}
        page = (await db_client.get(FOLLOWUPS, params=params, headers=world.agent.headers)).json()
        pages += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    by_admin = await db_client.get(
        FOLLOWUPS, params={"assignee": str(world.agent.id)}, headers=world.admin.headers
    )
    by_agent = await db_client.get(
        FOLLOWUPS, params={"assignee": str(world.admin.id)}, headers=world.agent.headers
    )
    bad = await db_client.get(FOLLOWUPS, params={"cursor": "%%"}, headers=world.agent.headers)

    assert pages == same
    assert by_admin.status_code == 200
    assert len(by_admin.json()["items"]) == 2
    assert (by_agent.status_code, bad.status_code) == (403, 422)
    assert (await db_client.get(FOLLOWUPS, headers=world.customer.headers)).status_code == 403


@pytest.mark.parametrize("settings", [make_settings(ops_action_limit=2)])
async def test_actions_are_limited_per_staff_member(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # One fixed window for the whole test: on the real clock a slow run could cross its end.
    limiter = InMemoryRateLimiter(clock=lambda: NOW.timestamp())
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    answers = [
        (await act(db_client, world.agent, request_id, "notes", body=f"n{n}")).status_code
        for n in range(3)
    ]
    other = await act(db_client, world.admin, request_id, "notes", body="n")

    assert answers == [201, 201, 429]
    assert other.status_code == 201


# --- The panel's additions (82-web-plan.md section 5, agreed with the Foreman) -------------------


async def queued_request(session: AsyncSession, world: JobWorld) -> uuid.UUID:
    request = await make_request(session, world)
    request_id = request.id
    await session.commit()
    return request_id


async def test_the_staff_list_names_active_agents_and_admins_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """For the assignee pickers: id, first name, role; never a contact, never a customer, a pro
    or a suspended account. Staff only."""
    suspended = await staff(db_session, UserRole.AGENT)
    await db_session.execute(
        update(User).where(User.id == suspended.id).values(status=UserStatus.SUSPENDED)
    )
    await db_session.commit()

    listed = await db_client.get("/v1/admin/staff", headers=world.agent.headers)
    refused = [
        await db_client.get("/v1/admin/staff", headers=party.headers)
        for party in (world.customer, world.pro)
    ]

    assert listed.status_code == 200, listed.text
    members = {member["id"]: member for member in listed.json()["staff"]}
    assert members[str(world.agent.id)]["role"] == "agent"
    assert members[str(world.admin.id)]["role"] == "admin"
    assert str(suspended.id) not in members
    assert str(world.customer.id) not in members
    assert all(set(member) == {"id", "first_name", "role"} for member in members.values())
    assert [response.status_code for response in refused] == [403, 403]


async def test_the_badge_counts_my_open_followups_due_by_tonight_overdue_included(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    """The summary equals the default list: due today or overdue, not done, the caller's own."""
    request_id = await queued_request(db_session, world)
    for hours in (1, 2):
        created = await act(
            db_client, world.agent, request_id, "followups", **followup_body(timedelta(hours=hours))
        )
        assert created.status_code == 201, created.text
    tomorrow = await act(
        db_client, world.agent, request_id, "followups", **followup_body(timedelta(days=2))
    )
    others = await act(
        db_client, world.admin, request_id, "followups", **followup_body(timedelta(hours=1))
    )
    assert (tomorrow.status_code, others.status_code) == (201, 201)
    done = await act(
        db_client, world.agent, request_id, "followups", **followup_body(timedelta(hours=3))
    )
    finished = await db_client.post(
        f"/v1/admin/requests/{request_id}/followups/{done.json()['id']}/done",
        headers=world.agent.headers,
    )
    assert finished.status_code == 200, finished.text
    # Hours later the first ones are overdue: still counted.
    clock.now += timedelta(hours=2, minutes=30)

    summary = await db_client.get("/v1/admin/followups/summary", headers=world.agent.headers)
    listed = await db_client.get("/v1/admin/followups", headers=world.agent.headers)

    assert summary.status_code == 200, summary.text
    assert summary.json() == {"due_today": 2}
    assert len(listed.json()["items"]) == summary.json()["due_today"]
    customer = await db_client.get("/v1/admin/followups/summary", headers=world.customer.headers)
    assert customer.status_code == 403


async def test_the_card_says_whether_the_caller_may_act(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """Unassigned: anyone on staff; held: its holder and admins, not another agent."""
    request_id = await queued_request(db_session, world)
    other = await staff(db_session, UserRole.AGENT)
    card = f"/v1/admin/requests/{request_id}"

    open_card = await db_client.get(card, headers=other.headers)
    claimed = await db_client.post(f"{card}/claim", headers=world.agent.headers)
    held = {
        name: (await db_client.get(card, headers=party.headers)).json()["actions_allowed"]
        for name, party in (("holder", world.agent), ("other", other), ("admin", world.admin))
    }

    assert open_card.json()["actions_allowed"] is True
    assert claimed.status_code == 200, claimed.text
    assert held == {"holder": True, "other": False, "admin": True}


# --- More info, resume, status (part 2) ---------------------------------------------------------

QUESTION: Final = "zq82 question-sentinel: which floor is the leak on?"
REASON: Final = "zq82 reason-sentinel: the customer called to cancel"
INVALID_TRANSITION = {
    "error": {
        "code": "invalid_transition",
        "message": "The request cannot move to that status from its current one.",
    }
}
# What a status change accepts from each status (the card's allowed_status_changes): the state
# machine's staff edges, never into finding_pro (dispatch owns it), nothing out of accepted
# (the payment and its cancellation own it).
MOVES: Final = {
    RequestStatus.RECEIVED: ["reviewing", "cancelled"],
    RequestStatus.REVIEWING: ["cancelled"],
    RequestStatus.FINDING_PRO: ["reviewing", "cancelled"],
    RequestStatus.QUOTE_READY: ["cancelled"],
    RequestStatus.ACCEPTED: [],
    RequestStatus.EXPIRED: [],
    RequestStatus.CANCELLED: [],
}


async def card_of(client: httpx.AsyncClient, party: Party, request_id: uuid.UUID) -> Any:
    response = await client.get(f"{BASE}/{request_id}", headers=party.headers)
    assert response.status_code == 200, response.text
    return response.json()


async def notes_of(session: AsyncSession, request_id: uuid.UUID) -> list[str]:
    statement = select(RequestNote.body).where(RequestNote.request_id == request_id)
    return list((await session.scalars(statement)).all())


@pytest.mark.parametrize(
    "start", [RequestStatus.RECEIVED, RequestStatus.REVIEWING, RequestStatus.FINDING_PRO]
)
async def test_asking_for_more_info_holds_the_request_in_reviewing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
    start: RequestStatus,
) -> None:
    """The question is a note, the request is in reviewing (moved by the state machine, or
    already there) and on hold; nobody messages the customer, and the answer says so."""
    caplog.set_level(logging.INFO)
    request = await make_request(db_session, world, start)
    request_id = request.id
    await db_session.commit()

    asked = await act(db_client, world.agent, request_id, "more-info", question=QUESTION)

    assert asked.status_code == 200, asked.text
    answer = asked.json()
    assert (answer["status"], answer["customer_notified"], answer["note"]["body"]) == (
        "reviewing",
        False,
        QUESTION,
    )
    assert datetime.fromisoformat(answer["info_requested_at"]) == NOW
    row = await request_row(db_session, request_id)
    assert (row.status, row.info_requested_at) == (RequestStatus.REVIEWING, NOW)
    card = await card_of(db_client, world.agent, request_id)
    assert datetime.fromisoformat(card["info_requested_at"]) == NOW
    assert [note["body"] for note in card["notes"]] == [QUESTION]
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_ASK_INFO)
    assert (audit.actor_user_id, audit.before, audit.after) == (
        world.agent.id,
        {"status": start.value, "info_requested_at": None},
        {
            "status": "reviewing",
            "info_requested_at": NOW.isoformat(),
            "note_id": answer["note"]["id"],
            "customer_notified": False,
        },
    )
    assert QUESTION not in caplog.text + "".join(str(r.__dict__) for r in caplog.records)


@pytest.mark.parametrize(
    "start",
    [
        RequestStatus.QUOTE_READY,
        RequestStatus.ACCEPTED,
        RequestStatus.EXPIRED,
        RequestStatus.CANCELLED,
    ],
)
async def test_more_info_is_asked_only_where_reviewing_can_be_reached(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    start: RequestStatus,
) -> None:
    request = await make_request(db_session, world, start)
    request_id = request.id
    await db_session.commit()

    asked = await act(db_client, world.agent, request_id, "more-info", question=QUESTION)

    assert (asked.status_code, asked.json()) == (409, INVALID_TRANSITION)
    row = await request_row(db_session, request_id)
    assert (row.status, row.info_requested_at) == (start, None)
    assert await notes_of(db_session, request_id) == []
    assert await audits(db_session, request_id, AuditAction.REQUEST_ASK_INFO) == []


async def cover(session: AsyncSession, world: JobWorld) -> None:
    """The world's pro takes requests in its category and at its address's ZIP: what the
    re-dispatch's kick looks for (#478)."""
    zip_code = await session.scalar(select(Address.zip_code).where(Address.id == world.address_id))
    assert zip_code is not None
    area = await session.scalar(select(ServiceArea).where(ServiceArea.zip_code == zip_code[:5]))
    if area is None:
        area = ServiceArea(region="Test", city="Orlando", state="FL", zip_code=zip_code[:5])
        session.add(area)
    area.active = True
    await session.flush()
    session.add_all(
        [
            ProCategory(pro_id=world.pro.profile_id, category_id=world.category_id),
            ProServiceArea(pro_id=world.pro.profile_id, service_area_id=area.id),
        ]
    )
    await session.flush()


async def test_a_held_request_is_never_swept_or_kicked_and_a_resumed_one_is(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    """Asked for more info: the re-dispatch's sweep and the kick for an eligible pro both
    leave the request alone. Resumed: both queue its dispatch again."""
    await cover(db_session, world)
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    async def swept_and_kicked() -> tuple[bool, bool]:
        sweep, kick = RecordingQueue(), RecordingQueue()
        # A fresh history each time: the hold, not the sweep's retry window, decides here.
        await sweep_stalled(sweep_ctx(sessions_of(db_session), sweep), memory_history())
        await redispatch_for_pro(
            sweep_ctx(sessions_of(db_session), kick), str(world.pro.profile_id)
        )
        job = f"dispatch:{request_id}"
        return job in sweep.jobs, job in kick.jobs

    assert await swept_and_kicked() == (True, True)  # control: both take it before the hold
    asked = await act(db_client, world.agent, request_id, "more-info", question=QUESTION)
    assert asked.status_code == 200, asked.text

    assert await swept_and_kicked() == (False, False)

    resumed = await act(db_client, world.agent, request_id, "resume")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json() == {
        "id": str(request_id),
        "status": "reviewing",
        "info_requested_at": None,
    }
    assert (await request_row(db_session, request_id)).info_requested_at is None
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_RESUME)
    assert (audit.before, audit.after) == (
        {"info_requested_at": NOW.isoformat()},
        {"info_requested_at": None},
    )
    assert await swept_and_kicked() == (True, True)
    # Again: not on hold, nothing written.
    again = await act(db_client, world.agent, request_id, "resume")
    assert again.status_code == 200
    assert len(await audits(db_session, request_id, AuditAction.REQUEST_RESUME)) == 1


@pytest.mark.parametrize("start", list(MOVES))
async def test_a_status_changes_only_along_the_card_s_allowed_moves(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    start: RequestStatus,
) -> None:
    """The card lists the moves; every other target is 409 invalid_transition and writes
    nothing; each listed one goes through the state machine with the reason as a note."""
    refused = [status for status in RequestStatus if status.value not in MOVES[start]]
    request = await make_request(db_session, world, start)
    request_id = request.id
    await db_session.commit()

    card = await card_of(db_client, world.agent, request_id)
    assert card["allowed_status_changes"] == MOVES[start]
    for target in refused:
        response = await act(
            db_client, world.agent, request_id, "status", to=target.value, reason=REASON
        )
        assert (response.status_code, response.json()) == (409, INVALID_TRANSITION), target
    assert (await request_row(db_session, request_id)).status is start
    assert await notes_of(db_session, request_id) == []
    for allowed in MOVES[start]:
        fresh = await make_request(db_session, world, start)
        fresh_id = fresh.id
        await db_session.commit()
        moved = await act(db_client, world.agent, fresh_id, "status", to=allowed, reason=REASON)
        assert moved.status_code == 200, moved.text
        assert (moved.json()["status"], moved.json()["note"]["body"]) == (allowed, REASON)
        assert (await request_row(db_session, fresh_id)).status.value == allowed
        assert await notes_of(db_session, fresh_id) == [REASON]
        [audit] = await audits(db_session, fresh_id, AuditAction.REQUEST_CHANGE_STATUS)
        assert (audit.before["status"], audit.after["status"]) == (start.value, allowed)


async def test_a_status_change_releases_the_hold(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()
    assert (
        await act(db_client, world.agent, request_id, "more-info", question=QUESTION)
    ).status_code == 200

    moved = await act(db_client, world.agent, request_id, "status", to="cancelled", reason=REASON)

    assert moved.status_code == 200, moved.text
    row = await request_row(db_session, request_id)
    assert (row.status, row.info_requested_at) == (RequestStatus.CANCELLED, None)
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_CHANGE_STATUS)
    assert (audit.before["info_requested_at"], audit.after["info_requested_at"]) == (
        NOW.isoformat(),
        None,
    )


async def test_only_staff_change_a_status_and_a_held_request_needs_its_holder_or_an_admin(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    held = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    other = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    held_id, other_id = held.id, other.id
    other_agent = await staff(db_session, UserRole.AGENT)
    await db_session.commit()
    body = {"to": "cancelled", "reason": REASON}

    anonymous = await db_client.post(path(held_id, "status"), json=body)
    customer = await act(db_client, world.customer, held_id, "status", **body)
    pro = await act(db_client, world.pro, held_id, "status", **body)
    by_other = await act(db_client, other_agent, held_id, "status", **body)
    holder = await act(db_client, world.agent, held_id, "status", **body)
    admin = await act(db_client, world.admin, other_id, "status", **body)

    assert (anonymous.status_code, customer.status_code, pro.status_code) == (401, 403, 403)
    assert (by_other.status_code, by_other.json()) == (409, HELD)
    assert (holder.status_code, admin.status_code) == (200, 200)
    assert holder.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("field", ["question", "reason"])
async def test_the_question_and_the_reason_are_plain_text_of_1_to_2000_characters(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    field: str,
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()
    action, extra = ("more-info", {}) if field == "question" else ("status", {"to": "cancelled"})

    for bad in ["", "   ", "x" * 2001, "a\x00b"]:
        response = await act(db_client, world.agent, request_id, action, **{field: bad}, **extra)
        assert response.status_code == 422, (bad[:5], response.text)
    assert (await request_row(db_session, request_id)).status is RequestStatus.RECEIVED


# --- Assign a pro by hand (part 2) ---------------------------------------------------------


def refusal(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


PRO_NOT_FOUND: Final = refusal("pro_not_found", "Pro not found.")
ALREADY_OFFERED: Final = refusal("pro_already_offered", "This pro already has this request.")
# What a manual assignment leaves a request in: finding a pro once it has an offer, else where
# it was. Accepted, expired and cancelled requests take none.
ASSIGNED_FROM: Final = {
    RequestStatus.RECEIVED: "finding_pro",
    RequestStatus.REVIEWING: "finding_pro",
    RequestStatus.FINDING_PRO: "finding_pro",
    RequestStatus.QUOTE_READY: "quote_ready",
}


async def cover_with(session: AsyncSession, world: JobWorld, pro: Pro) -> None:
    """`pro` takes requests in the world's category and at its address's ZIP."""
    zip_code = await session.scalar(select(Address.zip_code).where(Address.id == world.address_id))
    assert zip_code is not None
    area = await session.scalar(select(ServiceArea).where(ServiceArea.zip_code == zip_code[:5]))
    if area is None:
        area = ServiceArea(region="Test", city="Orlando", state="FL", zip_code=zip_code[:5])
        session.add(area)
    area.active = True
    await session.flush()
    session.add_all(
        [
            ProCategory(pro_id=pro.profile_id, category_id=world.category_id),
            ProServiceArea(pro_id=pro.profile_id, service_area_id=area.id),
        ]
    )
    await session.flush()


async def offers(session: AsyncSession, request_id: uuid.UUID) -> list[RequestDispatch]:
    statement = select(RequestDispatch).where(RequestDispatch.request_id == request_id)
    return list((await session.scalars(statement)).all())


async def assign(
    client: httpx.AsyncClient, party: Party, request_id: uuid.UUID, pro: Pro | uuid.UUID
) -> httpx.Response:
    pro_id = pro.profile_id if isinstance(pro, Pro) else pro
    return await act(client, party, request_id, "assign", pro_id=str(pro_id))


@pytest.mark.parametrize("start", list(ASSIGNED_FROM))
async def test_an_assignment_offers_the_request_to_the_pro_and_tells_them(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    storage: FakeStorage,
    start: RequestStatus,
) -> None:
    """One offer for the chosen pro, made by dispatch; a request not yet with pros moves to
    finding_pro (the state machine, as the agent's move); the pro gets the new request push
    once it is committed; one audit row with ids and statuses."""
    await cover_with(db_session, world, world.pro)
    pushes = record_pushes(app)
    app.dependency_overrides[get_storage] = lambda: storage  # the pro's feed signs media
    request = await make_request(db_session, world, start)
    request_id, code = request.id, request.public_code
    await db_session.commit()

    response = await assign(db_client, world.agent, request_id, world.pro)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": str(request_id),
        "status": ASSIGNED_FROM[start],
        "pro_id": str(world.pro.profile_id),
        "info_requested_at": None,
    }
    assert response.headers["cache-control"] == "no-store"
    [offer] = await offers(db_session, request_id)
    assert (offer.pro_id, offer.status) == (world.pro.profile_id, DispatchStatus.SENT)
    assert (await request_row(db_session, request_id)).status.value == ASSIGNED_FROM[start]
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_ASSIGN_PRO)
    assert audit.actor_user_id == world.agent.id
    assert (audit.before, audit.after) == (
        {"status": start.value, "info_requested_at": None},
        {
            "status": ASSIGNED_FROM[start],
            "info_requested_at": None,
            "pro_id": str(world.pro.profile_id),
            "dispatch_id": str(offer.id),
        },
    )
    assert pushes.jobs == {
        f"push:dispatch:{offer.id}": (
            "send_push",
            (
                str(world.pro.id),
                f"dispatch:{offer.id}",
                "push.new_request.title",
                "push.new_request.body",
                {"public_code": code},
                f"/opportunities/{offer.id}",
            ),
        )
    }
    # The pro finds it among their opportunities, like any request dispatch sent them.
    feed = await db_client.get("/v1/pros/me/opportunities", headers=world.pro.headers)
    assert [item["dispatch_id"] for item in feed.json()["items"]] == [str(offer.id)]


async def test_an_assignment_releases_the_hold(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
) -> None:
    await cover_with(db_session, world, world.pro)
    record_pushes(app)
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()
    asked = await act(db_client, world.agent, request_id, "more-info", question=QUESTION)
    assert asked.status_code == 200, asked.text

    response = await assign(db_client, world.agent, request_id, world.pro)

    assert response.status_code == 200, response.text
    row = await request_row(db_session, request_id)
    assert (row.status, row.info_requested_at) == (RequestStatus.FINDING_PRO, None)
    [audit] = await audits(db_session, request_id, AuditAction.REQUEST_ASSIGN_PRO)
    assert audit.before == {"status": "reviewing", "info_requested_at": NOW.isoformat()}
    assert audit.after["info_requested_at"] is None


async def _not_approved(session: AsyncSession, world: JobWorld) -> None:
    await session.execute(
        update(ProProfile)
        .where(ProProfile.id == world.pro.profile_id)
        .values(verification_status=ProVerificationStatus.PENDING)
    )


async def _payouts_disabled(session: AsyncSession, world: JobWorld) -> None:
    await session.execute(
        update(ProProfile)
        .where(ProProfile.id == world.pro.profile_id)
        .values(payouts_enabled=False)
    )


async def _another_category(session: AsyncSession, world: JobWorld) -> None:
    await session.execute(
        text("DELETE FROM pro_categories WHERE pro_id = :pro"), {"pro": world.pro.profile_id}
    )


async def _another_area(session: AsyncSession, world: JobWorld) -> None:
    await session.execute(
        text("DELETE FROM pro_service_areas WHERE pro_id = :pro"), {"pro": world.pro.profile_id}
    )


async def _area_switched_off(session: AsyncSession, world: JobWorld) -> None:
    await session.execute(update(ServiceArea).values(active=False))


async def _suspended(session: AsyncSession, world: JobWorld) -> None:
    await session.execute(
        update(User).where(User.id == world.pro.id).values(status=UserStatus.SUSPENDED)
    )


@pytest.mark.parametrize(
    ("spoil", "status", "expected"),
    [
        (_not_approved, 409, refusal("pro_not_approved", "This pro is not approved.")),
        (
            _payouts_disabled,
            409,
            refusal("pro_payouts_disabled", "This pro's payouts are not enabled."),
        ),
        (
            _another_category,
            409,
            refusal("pro_category_mismatch", "This pro does not take this category."),
        ),
        (_another_area, 409, refusal("pro_out_of_area", "This pro does not serve this area.")),
        (
            _area_switched_off,
            409,
            refusal("pro_out_of_area", "This pro does not serve this area."),
        ),
        (_suspended, 404, PRO_NOT_FOUND),
    ],
)
async def test_each_reason_a_pro_cannot_take_a_request_is_its_own_refusal(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    spoil: Any,
    status: int,
    expected: dict[str, Any],
) -> None:
    """What the automatic dispatch asks of a pro, the manual one asks too, one condition at a
    time: approved, payouts enabled, the category, an active area with the ZIP, an active pro
    account. A refusal writes nothing and tells nobody."""
    await cover_with(db_session, world, world.pro)
    pushes = record_pushes(app)
    request = await make_request(db_session, world)
    request_id = request.id
    await spoil(db_session, world)
    await db_session.commit()

    response = await assign(db_client, world.agent, request_id, world.pro)

    assert (response.status_code, response.json()) == (status, expected), response.text
    assert await offers(db_session, request_id) == []
    assert (await request_row(db_session, request_id)).status is RequestStatus.RECEIVED
    assert await audits(db_session, request_id, AuditAction.REQUEST_ASSIGN_PRO) == []
    assert pushes.jobs == {}


async def test_a_pro_is_never_given_the_same_request_twice_nor_an_unknown_pro_any(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
) -> None:
    await cover_with(db_session, world, world.pro)
    pushes = record_pushes(app)
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()

    unknown = await assign(db_client, world.agent, request_id, uuid.uuid4())
    # A user's id is not a profile's.
    by_user_id = await assign(db_client, world.agent, request_id, world.pro.id)
    first = await assign(db_client, world.agent, request_id, world.pro)
    again = await assign(db_client, world.admin, request_id, world.pro)

    assert (unknown.status_code, unknown.json()) == (404, PRO_NOT_FOUND)
    assert (by_user_id.status_code, by_user_id.json()) == (404, PRO_NOT_FOUND)
    assert first.status_code == 200, first.text
    assert (again.status_code, again.json()) == (409, ALREADY_OFFERED)
    assert len(await offers(db_session, request_id)) == 1
    assert len(await audits(db_session, request_id, AuditAction.REQUEST_ASSIGN_PRO)) == 1
    assert len(pushes.jobs) == 1


@pytest.mark.parametrize(
    "status", [RequestStatus.ACCEPTED, RequestStatus.EXPIRED, RequestStatus.CANCELLED]
)
async def test_a_request_past_quoting_takes_no_assignment(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    status: RequestStatus,
) -> None:
    await cover_with(db_session, world, world.pro)
    record_pushes(app)
    request = await make_request(db_session, world, status)
    request_id = request.id
    await db_session.commit()

    response = await assign(db_client, world.agent, request_id, world.pro)
    listed = await db_client.get(path(request_id, "eligible-pros"), headers=world.agent.headers)

    assert (response.status_code, response.json()) == (409, INVALID_TRANSITION)
    assert await offers(db_session, request_id) == []
    assert (listed.status_code, listed.json()) == (200, {"items": [], "more": False})


async def test_a_request_with_no_category_is_classified_before_it_is_assigned(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
) -> None:
    await cover_with(db_session, world, world.pro)
    record_pushes(app)
    request = await make_request(db_session, world, RequestStatus.REVIEWING, category_id=None)
    request_id = request.id
    await db_session.commit()

    response = await assign(db_client, world.agent, request_id, world.pro)
    listed = await db_client.get(path(request_id, "eligible-pros"), headers=world.agent.headers)

    assert (response.status_code, response.json()) == (
        409,
        refusal("request_not_classified", "Classify the request before assigning a pro."),
    )
    assert await offers(db_session, request_id) == []
    assert (listed.status_code, listed.json()) == (200, {"items": [], "more": False})


async def test_only_staff_assign_and_a_held_request_needs_its_holder_or_an_admin(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
) -> None:
    await cover_with(db_session, world, world.pro)
    await cover_with(db_session, world, world.other_pro)
    record_pushes(app)
    request = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    request_id = request.id
    other_agent = await staff(db_session, UserRole.AGENT)
    await db_session.commit()
    body = {"pro_id": str(world.pro.profile_id)}

    anonymous = await db_client.post(path(request_id, "assign"), json=body)
    customer = await assign(db_client, world.customer, request_id, world.pro)
    pro = await assign(db_client, world.pro, request_id, world.pro)
    held = await assign(db_client, other_agent, request_id, world.pro)
    holder = await assign(db_client, world.agent, request_id, world.pro)
    admin = await assign(db_client, world.admin, request_id, world.other_pro)

    assert (anonymous.status_code, customer.status_code, pro.status_code) == (401, 403, 403)
    assert (held.status_code, held.json()) == (409, HELD)
    assert holder.status_code == 200, holder.text
    assert admin.status_code == 200, admin.text
    assert {offer.pro_id for offer in await offers(db_session, request_id)} == {
        world.pro.profile_id,
        world.other_pro.profile_id,
    }
    malformed = await act(db_client, world.agent, request_id, "assign", pro_id="not-a-uuid")
    extra = await act(
        db_client, world.agent, request_id, "assign", pro_id=str(uuid.uuid4()), note="x"
    )
    assert (malformed.status_code, extra.status_code) == (422, 422)


async def test_the_eligible_list_names_who_may_be_assigned_best_ranked_first(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
) -> None:
    """Approved pros in the request's category and area, with an active account: the rated one
    first, each with whether payouts are enabled and whether they have the request. First name
    and last initial, the active categories, and nothing else about them."""
    record_pushes(app)
    await cover_with(db_session, world, world.pro)
    await cover_with(db_session, world, world.other_pro)
    # A published review (#78: the rating is computed from the reviews, never read from the
    # profile's rating_avg column), so world.pro ranks first.
    await rate(db_session, world.pro.profile_id, 5)
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == world.other_pro.profile_id)
        .values(payouts_enabled=False)
    )
    # Left out: not approved, and an approved pro of this area in another category.
    pending = await staff(db_session, UserRole.PRO)
    elsewhere = await staff(db_session, UserRole.PRO)
    other_category = Category(slug="test-zqother", names={"en": "Other", "es": "Otra"})
    db_session.add(other_category)
    await db_session.flush()
    for user, state in (
        (pending, ProVerificationStatus.PENDING),
        (elsewhere, ProVerificationStatus.APPROVED),
    ):
        profile = ProProfile(user_id=user.id, verification_status=state, payouts_enabled=True)
        db_session.add(profile)
        await db_session.flush()
        left_out = Pro(user.id, user.headers, profile.id)
        await cover_with(db_session, world, left_out)
        if user is elsewhere:
            await db_session.execute(
                update(ProCategory)
                .where(ProCategory.pro_id == profile.id)
                .values(category_id=other_category.id)
            )
    request = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    request_id = request.id
    other_agent = await staff(db_session, UserRole.AGENT)
    await db_session.commit()
    url = path(request_id, "eligible-pros")

    anonymous = await db_client.get(url)
    customer = await db_client.get(url, headers=world.customer.headers)
    pro = await db_client.get(url, headers=world.pro.headers)
    # A read: a request another agent holds is still read.
    listed = await db_client.get(url, headers=other_agent.headers)

    assert (anonymous.status_code, customer.status_code, pro.status_code) == (401, 403, 403)
    assert listed.status_code == 200, listed.text
    assert listed.headers["cache-control"] == "no-store"
    category = await db_session.get(Category, world.category_id)
    assert category is not None
    summary = {"id": str(category.id), "slug": category.slug, "names": category.names}
    assert listed.json() == {
        "items": [
            {
                "id": str(world.pro.profile_id),
                "name": "María P.",
                "categories": [summary],
                "payouts_enabled": True,
                "already_offered": False,
            },
            {
                "id": str(world.other_pro.profile_id),
                "name": None,
                "categories": [summary],
                "payouts_enabled": False,
                "already_offered": False,
            },
        ],
        "more": False,
    }
    for private in (PRO_EMAIL, PRO_PHONE, "Pérez"):
        assert private not in listed.text

    assigned = await assign(db_client, world.agent, request_id, world.pro)
    assert assigned.status_code == 200, assigned.text
    after = await db_client.get(url, headers=world.agent.headers)
    assert [item["already_offered"] for item in after.json()["items"]] == [True, False]
    # The list writes nothing.
    assert len((await db_session.scalars(select(AuditLog))).all()) == 1

    unknown = await db_client.get(path(uuid.uuid4(), "eligible-pros"), headers=world.agent.headers)
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "request_not_found"


# REVIEW_PUBLISH_AFTER_DAYS at 2, not its default (14): the ranking must read the setting.
SHORT_WINDOW_DAYS: Final = 2


async def review_of(
    session: AsyncSession, pro: Pro, overall: int, confirmed_days_ago: float
) -> None:
    """A customer's review of `pro` on a job confirmed `confirmed_days_ago`; the pro has not
    answered, so it counts once that job's publication window has passed."""
    job_id, customer_id = await confirmed_job(
        session, pro.profile_id, confirmed_at=datetime.now(UTC) - timedelta(days=confirmed_days_ago)
    )
    session.add(
        Review(
            job_id=job_id,
            author_id=customer_id,
            target_id=pro.id,
            author_role=ReviewAuthorRole.CUSTOMER,
            overall=overall,
        )
    )
    await session.flush()


@pytest.mark.parametrize(
    "settings",
    [
        make_settings(
            ops_followup_max_days=MAX_DAYS,
            business_time_zone="America/New_York",
            request_list_default_limit=2,
            review_publish_after_days=SHORT_WINDOW_DAYS,
        )
    ],
)
async def test_the_eligible_list_ranks_by_the_reviews_published_in_the_set_window(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """#556 (the Gatekeeper's follow-up): a manual assignment ranks pros by the reviews
    published under REVIEW_PUBLISH_AFTER_DAYS, the setting's value. With no review the two pros
    rank in some order; then the second gets a 4 published (its job confirmed 3 days ago, past
    the 2-day window) and the first a 5 not yet published (1 day ago, inside it). Only that
    window puts the second first: with a longer one (the default 14 days, or none at all) both
    are unrated and the first stays first; with no window the first's 5 wins."""
    for pro in (world.pro, world.other_pro):
        await cover_with(db_session, world, pro)
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id.in_([world.pro.profile_id, world.other_pro.profile_id]))
        .values(payouts_enabled=True)
    )
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()
    url = path(request_id, "eligible-pros")
    pros = {str(pro.profile_id): pro for pro in (world.pro, world.other_pro)}

    unrated = await db_client.get(url, headers=world.agent.headers)
    assert unrated.status_code == 200, unrated.text
    first, second = (pros[item["id"]] for item in unrated.json()["items"])
    await review_of(db_session, second, 4, confirmed_days_ago=SHORT_WINDOW_DAYS + 1)
    await review_of(db_session, first, 5, confirmed_days_ago=SHORT_WINDOW_DAYS - 1)
    await db_session.commit()
    rated = await db_client.get(url, headers=world.agent.headers)

    assert rated.status_code == 200, rated.text
    assert [item["id"] for item in rated.json()["items"]] == [
        str(second.profile_id),
        str(first.profile_id),
    ]


async def test_the_eligible_list_is_cut_at_the_setting_and_says_so(
    db_session: AsyncSession, world: JobWorld, settings: Settings
) -> None:
    await cover_with(db_session, world, world.pro)
    await cover_with(db_session, world, world.other_pro)
    request = await make_request(db_session, world)
    request_id = request.id
    await db_session.commit()
    one = replace(ActionsConfig.from_settings(settings), eligible_pros_limit=1)

    cut = await OpsActions(db_session, one).eligible_pros(request_id)
    whole = await OpsActions(db_session, replace(one, eligible_pros_limit=2)).eligible_pros(
        request_id
    )

    assert (len(cut.items), cut.more) == (1, True)
    assert (len(whole.items), whole.more) == (2, False)
    with pytest.raises(QueueRequestNotFoundError):
        await OpsActions(db_session, one).eligible_pros(uuid.uuid4())


async def test_two_agents_assigning_one_pro_at_once_make_one_offer(
    app: FastAPI, committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On real commits: the request's row lock makes the two assignments take turns, and the
    second finds the first's offer. One offer, one push, one audit row asked for; the rows
    are deleted afterwards (audit_log is append-only, so its write is recorded instead)."""
    audited: list[AuditAction] = []

    async def no_row(self: AuditService, actor_id: uuid.UUID, action: AuditAction, *_: Any) -> None:
        audited.append(action)

    monkeypatch.setattr(AuditService, "record_staff_action", no_row)
    pushes = record_pushes(app)
    tag = letter_tag()
    # A ZIP nothing else in the test database uses.
    zip_code = f"9{uuid.uuid4().int % 10_000:04d}"
    async with committed.sessions() as session:
        customer = User(email=committed.email, password_hash="x", role=UserRole.CUSTOMER)
        agents = [
            User(email=f"assign-{tag}-{n}@x.com", password_hash="x", role=UserRole.AGENT)
            for n in range(2)
        ]
        pro_user = User(email=f"assign-{tag}-pro@x.com", password_hash="x", role=UserRole.PRO)
        category = Category(slug=f"test-{tag}", names={"en": "Race", "es": "Carrera"})
        area = ServiceArea(region="Test", city="Orlando", state="FL", zip_code=zip_code)
        session.add_all([customer, *agents, pro_user, category, area])
        await session.flush()
        profile = ProProfile(
            user_id=pro_user.id,
            verification_status=ProVerificationStatus.APPROVED,
            payouts_enabled=True,
        )
        address = Address(
            user_id=customer.id, line1="1 Race Road", city="Orlando", state="FL", zip_code=zip_code
        )
        session.add_all([profile, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            category_id=category.id,
            description="race",
            origin=RequestOrigin.APP,
        )
        session.add_all(
            [
                request,
                ProCategory(pro_id=profile.id, category_id=category.id),
                ProServiceArea(pro_id=profile.id, service_area_id=area.id),
            ]
        )
        await session.commit()
    url = path(request.id, "assign")
    body = {"pro_id": str(profile.id)}
    try:
        async with asyncio.timeout(15):
            responses = await asyncio.gather(
                *(
                    committed.client.post(url, json=body, headers=headers_for(a.id, UserRole.AGENT))
                    for a in agents
                )
            )

        assert sorted(r.status_code for r in responses) == [200, 409]
        [lost] = [r for r in responses if r.status_code == 409]
        assert lost.json() == ALREADY_OFFERED
        async with committed.sessions() as session:
            assert len(await offers(session, request.id)) == 1
            assert (await request_row(session, request.id)).status is RequestStatus.FINDING_PRO
        assert audited == [AuditAction.REQUEST_ASSIGN_PRO]
        assert len(pushes.jobs) == 1
    finally:
        async with committed.sessions() as session:
            for statement in (
                delete(RequestDispatch).where(RequestDispatch.request_id == request.id),
                delete(ServiceRequest).where(ServiceRequest.id == request.id),
                delete(Address).where(Address.id == address.id),
                delete(ProCategory).where(ProCategory.pro_id == profile.id),
                delete(ProServiceArea).where(ProServiceArea.pro_id == profile.id),
                delete(ProProfile).where(ProProfile.id == profile.id),
                delete(ServiceArea).where(ServiceArea.id == area.id),
                delete(Category).where(Category.id == category.id),
                delete(User).where(User.id.in_([pro_user.id, *(a.id for a in agents)])),
            ):
                await session.execute(statement)
            await session.commit()
