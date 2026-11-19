"""The BDC's actions on a request (#82, part 1): internal notes, mark contacted, classify,
follow-ups and the follow-ups due. Rolled-back session, the clock fixed; the two-agent race
runs on real commits (the queue tests' racers, whose audit writes are recorded)."""

import asyncio
import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.audit.models import AuditLog
from app.modules.audit.types import AuditAction
from app.modules.categories.models import Category
from app.modules.jobs.models import JobStatus
from app.modules.ops.models import RequestFollowup
from app.modules.ops.router import get_ops_clock
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.requests.queue import RequestQueueReader
from app.modules.users.types import UserRole
from app.rate_limit import get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import JobWorld, Party, headers_for, make_job
from tests.test_ops_queue_api import (
    BASE,
    HELD,
    make_request,
    request_row,
)
from tests.test_ops_queue_api import racers as racers
from tests.test_ops_queue_api import storage as storage
from tests.test_ops_queue_api import world as world

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
]


def body_of(spec: Any, world: JobWorld) -> dict[str, Any]:
    if spec == "FOLLOWUP":
        return followup_body()
    return {
        key: str(world.category_id) if value == "CATEGORY" else value for key, value in spec.items()
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


@pytest.mark.parametrize(("action", "spec"), ACTIONS)
async def test_an_actor_demoted_since_authentication_writes_nothing(
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
    assert (
        await db_session.scalars(select(AuditLog).where(AuditLog.entity_id == request_id))
    ).all() == []
    assert (
        await db_session.scalars(
            select(RequestFollowup).where(RequestFollowup.request_id == request_id)
        )
    ).all() == []


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
    clock: Clock,
) -> None:
    """Every GET route outside /v1/admin, read as the job's customer and as its pro with the
    job's own ids: the note's text appears in none of their answers."""
    job = await make_job(db_session, world, JobStatus.SCHEDULED)
    await db_session.commit()
    assert (
        await act(db_client, world.admin, job.request_id, "notes", body=NOTE)
    ).status_code == 201
    params = {"request_id": job.request_id, "job_id": job.id, "quote_id": job.quote_id}
    read = 0
    for route, operations in app.openapi()["paths"].items():
        if "get" not in operations:
            continue
        if not route.startswith("/v1/") or route.startswith("/v1/admin"):
            continue
        names = re.findall(r"{(\w+)}", route)
        if any(name not in params for name in names):
            continue
        url = route.format(**{name: params[name] for name in names})
        for party in (world.customer, world.pro):
            response = await db_client.get(url, headers=party.headers)
            read += 1
            assert NOTE not in response.text, url
    assert read > 10


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
        assert refused.status_code == 422
        unknown = await act(
            db_client, world.agent, request_id, "classify", category_id=str(uuid.uuid4())
        )
        assert unknown.status_code == 422
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
    assert agent_gives.status_code == 403
    assert admin_gives.status_code == 201
    assert admin_gives.json()["assigned_to"]["id"] == str(world.agent.id)
    assert to_a_customer.status_code == 422
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
