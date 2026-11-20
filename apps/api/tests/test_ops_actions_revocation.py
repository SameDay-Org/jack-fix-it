"""#499 Vault round 1: what a staff member may do and read follows their account as the action's
own transaction reads it, never the role they were authenticated with.

B1 and B3 run on real commits, on separate connections: the request is authenticated, then a
demotion or a suspension is COMMITTED by another connection, then the action's transaction
reads the actor (AuditService.current_staff). B2 (who reads a follow-up) runs on the rolled-back
session. The audit writes of the committed tests are recorded instead of written: audit_log is
append-only, so a committed row could never be cleaned up (the racers' way, test_ops_queue_api).
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.addresses.models import Address
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction
from app.modules.ops.models import RequestFollowup, RequestNote
from app.modules.requests.models import RequestOrigin, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from tests.conftest import Committed
from tests.job_world import JobWorld, Party, headers_for
from tests.test_ops_actions_api import FOLLOWUPS, NOW, Clock, _followup, clock, staff
from tests.test_ops_queue_api import BASE, FORBIDDEN, HELD, make_request, storage, world

__all__ = ["clock", "storage", "world"]  # fixtures, used by name

SECRET: Final = "zq499 follow-up sentinel: the customer's back door code"


@dataclass
class Staff:
    """Committed staff, a customer and a request, deleted afterwards. `audited` records the
    audit writes asked for (none is written)."""

    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    request_id: uuid.UUID
    agent: Party
    other_agent: Party
    admin: Party
    audited: list[tuple[uuid.UUID, AuditAction]] = field(default_factory=list)


@pytest.fixture
async def team(committed: Committed, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Staff]:
    audited: list[tuple[uuid.UUID, AuditAction]] = []

    async def no_row(
        self: AuditService, actor_id: uuid.UUID, action: AuditAction, *args: Any, **kwargs: Any
    ) -> None:
        audited.append((actor_id, action))

    monkeypatch.setattr(AuditService, "record_staff_action", no_row)
    monkeypatch.setattr(AuditService, "record_read", no_row)
    tag = uuid.uuid4().hex[:8]
    async with committed.sessions() as session:
        customer = User(email=committed.email, password_hash="x", role=UserRole.CUSTOMER)
        members = [
            User(email=f"r499-{tag}-{role.value}-{n}@x.com", password_hash="x", role=role)
            for n, role in enumerate((UserRole.AGENT, UserRole.AGENT, UserRole.ADMIN))
        ]
        session.add_all([customer, *members])
        await session.flush()
        address = Address(
            user_id=customer.id, line1="1 Revoke Road", city="Orlando", state="FL", zip_code="32801"
        )
        session.add(address)
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            description="revocation",
            origin=RequestOrigin.APP,
            # Held by the first agent: the holder rule applies to everyone else.
            assigned_agent_id=members[0].id,
        )
        session.add(request)
        await session.commit()
    agent, other, admin = (Party(m.id, headers_for(m.id, m.role)) for m in members)
    try:
        yield Staff(committed.client, committed.sessions, request.id, agent, other, admin, audited)
    finally:
        async with committed.sessions() as session:
            await session.execute(
                delete(RequestFollowup).where(RequestFollowup.request_id == request.id)
            )
            await session.execute(delete(RequestNote).where(RequestNote.request_id == request.id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request.id))
            await session.execute(delete(Address).where(Address.id == address.id))
            await session.execute(delete(User).where(User.id.in_([m.id for m in members])))
            await session.commit()


async def committed_followup(team: Staff, assignee: Party, *, done: bool = False) -> uuid.UUID:
    async with team.sessions() as session:
        followup = RequestFollowup(
            request_id=team.request_id,
            assigned_to=assignee.id,
            created_by=assignee.id,
            due_at=datetime.now(UTC) + timedelta(hours=3),
            note=SECRET,
            done_at=datetime.now(UTC) if done else None,
            done_by=assignee.id if done else None,
        )
        session.add(followup)
        await session.commit()
        return followup.id


def revoke_on_check(
    team: Staff, monkeypatch: pytest.MonkeyPatch, user: Party, values: dict[str, str]
) -> list[str]:
    """Commits `values` on `user` from another connection the first time an action checks its
    actor, after the request was authenticated: the role or status it was authenticated with is
    then stale. Returns the record of when it happened."""
    happened: list[str] = []
    original = AuditService.current_staff

    async def revoke_then_check(self: AuditService, user_id: uuid.UUID) -> UserAccount | None:
        if user_id == user.id and not happened:
            async with team.sessions() as other:
                await other.execute(update(User).where(User.id == user.id).values(**values))
                await other.commit()
            happened.append("committed")
        return await original(self, user_id)

    monkeypatch.setattr(AuditService, "current_staff", revoke_then_check)
    return happened


async def notes_of(team: Staff) -> list[RequestNote]:
    async with team.sessions() as session:
        statement = select(RequestNote).where(RequestNote.request_id == team.request_id)
        return list((await session.scalars(statement)).all())


async def followups_of(team: Staff) -> list[RequestFollowup]:
    async with team.sessions() as session:
        statement = select(RequestFollowup).where(RequestFollowup.request_id == team.request_id)
        return list((await session.scalars(statement)).all())


def followup_in(assignee: Party) -> dict[str, str]:
    return {
        "due_at": (datetime.now(UTC) + timedelta(hours=3)).isoformat(),
        "note": "Call back after 2 pm",
        "assigned_to": str(assignee.id),
    }


# --- B1: an admin demoted to agent since authentication is an agent ---------------------------


async def request_state(team: Staff) -> tuple[Any, Any]:
    async with team.sessions() as session:
        row = (
            await session.execute(
                select(ServiceRequest.first_contact_at, ServiceRequest.category_id).where(
                    ServiceRequest.id == team.request_id
                )
            )
        ).one()
    return row.first_contact_at, row.category_id


@pytest.mark.parametrize(
    ("action", "body"),
    [
        ("notes", {"body": "admin note"}),
        ("contacted", None),
        # Refused by the holder rule before the category is looked at.
        ("classify", {"category_id": str(uuid.uuid4())}),
    ],
)
@pytest.mark.parametrize("demoted", [True, False], ids=["demoted", "still_admin"])
async def test_an_action_on_another_agent_s_held_request(
    team: Staff,
    monkeypatch: pytest.MonkeyPatch,
    demoted: bool,
    action: str,
    body: dict[str, str] | None,
) -> None:
    """The request is held by another agent: only an admin may act on it. One demoted to agent
    after authentication (the Gatekeeper's fourth probe: mark contacted) writes nothing."""
    happened = revoke_on_check(team, monkeypatch, team.admin, {"role": "agent"}) if demoted else []

    response = await team.client.post(
        f"{BASE}/{team.request_id}/{action}", json=body, headers=team.admin.headers
    )

    if demoted:
        assert happened == ["committed"]
        assert (response.status_code, response.json()) == (409, HELD)
        assert await notes_of(team) == []
        assert await request_state(team) == (None, None)
        assert team.audited == []
    elif action == "classify":
        # Past the holder rule: the made-up category is refused on its own merits.
        assert response.status_code == 422, response.text
    else:
        assert response.status_code in (200, 201), response.text
        assert team.audited != []


@pytest.mark.parametrize("demoted", [True, False], ids=["demoted", "still_admin"])
async def test_a_followup_given_to_another_agent(
    team: Staff, monkeypatch: pytest.MonkeyPatch, demoted: bool
) -> None:
    # A request nobody holds, so only the assignment rule decides.
    async with team.sessions() as session:
        await session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == team.request_id)
            .values(assigned_agent_id=None)
        )
        await session.commit()
    happened = revoke_on_check(team, monkeypatch, team.admin, {"role": "agent"}) if demoted else []

    response = await team.client.post(
        f"{BASE}/{team.request_id}/followups",
        json=followup_in(team.other_agent),
        headers=team.admin.headers,
    )

    if demoted:
        assert happened == ["committed"]
        assert (response.status_code, response.json()) == (403, FORBIDDEN)
        assert await followups_of(team) == []
        assert team.audited == []
    else:
        assert response.status_code == 201, response.text
        [row] = await followups_of(team)
        assert row.assigned_to == team.other_agent.id


@pytest.mark.parametrize("demoted", [True, False], ids=["demoted", "still_admin"])
async def test_another_agent_s_followup_marked_done(
    team: Staff, monkeypatch: pytest.MonkeyPatch, demoted: bool
) -> None:
    followup_id = await committed_followup(team, team.agent)
    happened = revoke_on_check(team, monkeypatch, team.admin, {"role": "agent"}) if demoted else []

    response = await team.client.post(
        f"{BASE}/{team.request_id}/followups/{followup_id}/done", headers=team.admin.headers
    )

    [row] = await followups_of(team)
    if demoted:
        assert happened == ["committed"]
        assert (response.status_code, response.json()) == (403, FORBIDDEN)
        assert SECRET not in response.text
        assert (row.done_at, row.done_by) == (None, None)
        assert team.audited == []
    else:
        assert response.status_code == 200, response.text
        assert row.done_by == team.admin.id


# --- B3: a done follow-up's replay checks the actor first -------------------------------------


@pytest.mark.parametrize(
    "revocation",
    [{"role": "customer"}, {"status": "suspended"}, None],
    ids=["demoted_to_customer", "suspended", "still_active"],
)
async def test_a_done_followup_s_replay_by_a_revoked_actor_shows_nothing(
    team: Staff, monkeypatch: pytest.MonkeyPatch, revocation: dict[str, str] | None
) -> None:
    followup_id = await committed_followup(team, team.agent, done=True)
    happened = revoke_on_check(team, monkeypatch, team.agent, revocation) if revocation else []

    response = await team.client.post(
        f"{BASE}/{team.request_id}/followups/{followup_id}/done", headers=team.agent.headers
    )

    if revocation:
        assert happened == ["committed"]
        assert (response.status_code, response.json()) == (403, FORBIDDEN)
        assert SECRET not in response.text
    else:
        # Still authorized: the replay stays idempotent, and writes nothing.
        assert response.status_code == 200, response.text
        assert response.json()["note"] == SECRET
    assert team.audited == []


# --- B2: who reads a follow-up, on the card and in the list -----------------------------------


async def card_followups(client: httpx.AsyncClient, party: Party, request_id: uuid.UUID) -> Any:
    response = await client.get(f"{BASE}/{request_id}", headers=party.headers)
    assert response.status_code == 200, response.text
    return response


async def test_an_agent_reads_only_their_own_followups_on_the_card_and_in_the_list(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    request_id = request.id
    other_agent = await staff(db_session, UserRole.AGENT)
    mine = await _followup(db_session, world, request, NOW + timedelta(hours=1))
    theirs = await _followup(
        db_session, world, request, NOW + timedelta(hours=2), assigned_to=other_agent.id
    )
    await db_session.execute(
        update(RequestFollowup).where(RequestFollowup.id == theirs.id).values(note=SECRET)
    )
    mine_id, theirs_id = str(mine.id), str(theirs.id)
    await db_session.commit()

    by_agent = await card_followups(db_client, world.agent, request_id)
    by_other = await card_followups(db_client, other_agent, request_id)
    by_admin = await card_followups(db_client, world.admin, request_id)
    agent_list = await db_client.get(FOLLOWUPS, params={"due": "all"}, headers=world.agent.headers)

    assert [f["id"] for f in by_agent.json()["followups"]] == [mine_id]
    assert SECRET not in by_agent.text
    assert theirs_id not in by_agent.text
    assert [f["id"] for f in by_other.json()["followups"]] == [theirs_id]
    assert [f["id"] for f in by_admin.json()["followups"]] == [mine_id, theirs_id]
    # The list and the card say the same.
    assert [item["id"] for item in agent_list.json()["items"]] == [mine_id]
    assert SECRET not in agent_list.text
    # Notes stay shared by all staff (none here to hide).
    assert by_agent.json()["notes"] == by_other.json()["notes"]


async def test_only_an_admin_names_an_assignee_even_their_own_id(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    request = await make_request(db_session, world)
    await _followup(db_session, world, request, NOW + timedelta(hours=1))
    await db_session.commit()

    self_named = await db_client.get(
        FOLLOWUPS, params={"assignee": str(world.agent.id)}, headers=world.agent.headers
    )
    plain = await db_client.get(FOLLOWUPS, params={"due": "all"}, headers=world.agent.headers)
    admin_named = await db_client.get(
        FOLLOWUPS,
        params={"assignee": str(world.agent.id), "due": "all"},
        headers=world.admin.headers,
    )

    assert (self_named.status_code, self_named.json()) == (403, FORBIDDEN)
    assert self_named.headers["cache-control"] == "no-store"
    assert plain.status_code == 200
    assert len(plain.json()["items"]) == 1
    assert admin_named.status_code == 200
    assert len(admin_named.json()["items"]) == 1


async def test_reads_follow_the_current_role_not_the_token_s(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    """An admin's token, but the account is an agent now: the card shows them only their own
    follow-ups, the list refuses the assignee parameter, and the card says they may not act on
    a request another agent holds."""
    request = await make_request(db_session, world, assigned_agent_id=world.agent.id)
    request_id = request.id
    await _followup(db_session, world, request, NOW + timedelta(hours=1))
    # The admin is authenticated with their token's role, then demoted in this transaction's
    # view of the account (the authentication itself reads the role too, so the demotion has
    # to come after it: done on the read the card makes).
    original = AuditService.current_staff
    demoted: list[str] = []

    async def demote_then_read(self: AuditService, user_id: uuid.UUID) -> UserAccount | None:
        if user_id == world.admin.id and not demoted:
            await db_session.execute(
                text("UPDATE users SET role = 'agent' WHERE id = :id"), {"id": world.admin.id}
            )
            demoted.append("done")
        return await original(self, user_id)

    await db_session.commit()
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(AuditService, "current_staff", demote_then_read)
        card = await db_client.get(f"{BASE}/{request_id}", headers=world.admin.headers)
    assert demoted == ["done"]
    assert card.status_code == 200, card.text
    assert card.json()["followups"] == []
    assert card.json()["actions_allowed"] is False
    named = await db_client.get(
        FOLLOWUPS, params={"assignee": str(world.agent.id)}, headers=world.admin.headers
    )
    # The token was issued to an admin; the account is an agent now: the assignee is refused.
    assert (named.status_code, named.json()) == (403, FORBIDDEN)
