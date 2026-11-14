"""Idempotency-Key on POST /v1/support/tickets (#380): a retry answers the ticket the first
call wrote and writes nothing; the same key with another body is a 409; two creates racing
with one key write one ticket; a retry takes no rate-limit slot."""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.modules.auth import security
from app.modules.support.errors import InvalidTicketInputError
from app.modules.support.models import SupportTicket, TicketStatus, TicketTopic
from app.modules.support.repository import SupportTicketRepository
from app.modules.support.schemas import SupportTicketIn
from app.modules.support.service import _fingerprint
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.audit_helpers import audit_rows
from tests.conftest import (
    TEST_JWT_SECRET,
    Committed,
    InMemoryRateLimiter,
    backend_pid,
    make_settings,
    wait_until_blocked,
)
from tests.job_world import JobWorld, Party, make_job
from tests.test_chat_originals import _app, _client
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads
from tests.test_support_tickets_api import (
    BASE,
    MESSAGE,
    MINE,
    NOW,
    RATE_LIMITED,
    STAFF,
    TEXT_LEAKS,
    VALIDATION_ERROR,
    VERSION,
    body,
    rows,
    sentry_transport,
    world,
)

# Fixtures, used by name.
__all__ = ["sentry_transport", "world"]

# Not the default (24 h), so the tests prove the window comes from settings.
WINDOW = timedelta(hours=2)
REUSED = {
    "error": {
        "code": "idempotency_key_reused",
        "message": "This Idempotency-Key was already used with a different ticket.",
    }
}
CREATED_KEYS = {"id", "status", "created_at"}
LONE_SURROGATE = chr(0xD800)  # valid in JSON text, with no UTF-8 form


@pytest.fixture
def settings() -> Settings:
    # A limit no test here reaches, but for the one that tests it with its own.
    return make_settings(
        support_ticket_idempotency_window_seconds=int(WINDOW.total_seconds()),
        support_ticket_create_limit=50,
    )


async def post(
    client: httpx.AsyncClient, party: Party, key: str | None, **overrides: Any
) -> httpx.Response:
    headers = dict(party.headers)
    if key is not None:
        headers["Idempotency-Key"] = key
    return await client.post(BASE, json=body(**overrides), headers=headers)


async def raw_post(
    client: httpx.AsyncClient, party: Party, key: str | None, content: bytes
) -> httpx.Response:
    """Sends the bytes as they are: httpx refuses lone surrogates in `json=`, a raw client
    does not."""
    headers = {**party.headers, "Content-Type": "application/json"}
    if key is not None:
        headers["Idempotency-Key"] = key
    return await client.post(BASE, content=content, headers=headers)


# Criterion 1: the first create 201, a retry 200 with the same ticket, and nothing again


async def test_a_retry_answers_the_first_ticket_and_writes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    key = str(uuid.uuid4())
    job = await make_job(db_session, world)
    fields = {"topic": "job", "job_id": str(job.id), "app_version": VERSION, "platform": "ios"}

    created = await post(db_client, world.customer, key, **fields)
    stored = [(t.id, t.message, t.job_id, t.app_version) for t in await rows(db_session)]
    retries = [await post(db_client, world.customer, key, **fields) for _ in range(3)]

    assert created.status_code == 201, created.text
    assert [r.status_code for r in retries] == [200, 200, 200]
    assert all(r.json() == created.json() for r in retries)
    assert set(created.json()) == CREATED_KEYS
    [ticket] = await rows(db_session)
    assert [(ticket.id, ticket.message, ticket.job_id, ticket.app_version)] == stored
    assert (str(ticket.id), ticket.idempotency_key) == (created.json()["id"], uuid.UUID(key))
    assert await audit_rows(db_session) == []
    mine = await db_client.get(MINE, headers=world.customer.headers)
    assert [item["id"] for item in mine.json()["items"]] == [created.json()["id"]]


async def test_a_replay_answers_the_current_status(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    key = str(uuid.uuid4())
    created = (await post(db_client, world.customer, key)).json()
    changed = await db_client.patch(
        f"{STAFF}/{created['id']}", json={"status": "in_progress"}, headers=world.agent.headers
    )
    audited = await audit_rows(db_session)

    replayed = await post(db_client, world.customer, key)

    assert changed.status_code == 200, changed.text
    assert replayed.status_code == 200
    assert replayed.json() == {**created, "status": "in_progress"}
    assert await audit_rows(db_session) == audited  # the status change's row, and no other


async def test_the_same_body_laid_out_differently_is_a_retry(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    key = str(uuid.uuid4())
    created = await post(db_client, world.pro, key, message=MESSAGE, platform="android")
    # Trimmed the same, the keys in another order, the defaults spelled out.
    layout = {
        "platform": "android",
        "job_id": None,
        "app_version": None,
        "message": f"\n  {MESSAGE}  ",
        "topic": "payment",
    }

    retry = await raw_post(db_client, world.pro, key, json.dumps(layout).encode())

    assert (created.status_code, retry.status_code) == (201, 200)
    assert retry.json() == created.json()
    assert len(await rows(db_session)) == 1


async def test_without_a_key_every_create_writes_a_ticket(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    responses = [await post(db_client, world.customer, None) for _ in range(2)]

    assert [r.status_code for r in responses] == [201, 201]
    tickets = await rows(db_session)
    assert len({t.id for t in tickets}) == 2
    assert {(t.idempotency_key, t.idempotency_fingerprint) for t in tickets} == {(None, None)}


@pytest.mark.parametrize("key", ["not-a-uuid", "", "3f1c-x", f"{uuid.uuid4()}x"])
async def test_a_key_that_is_not_a_uuid_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, key: str
) -> None:
    response = await post(db_client, world.customer, key)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await rows(db_session) == []


async def test_a_retry_takes_no_rate_limit_slot(db_session: AsyncSession, world: JobWorld) -> None:
    app = _app(
        make_settings(
            support_ticket_create_limit=3,
            support_ticket_create_window_seconds=3_600,
            support_ticket_idempotency_window_seconds=int(WINDOW.total_seconds()),
        ),
        db_session,
    )
    limiter = InMemoryRateLimiter(lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    key, fresh = str(uuid.uuid4()), str(uuid.uuid4())
    async with _client(app) as client:
        first = await post(client, world.customer, key)  # slot 1
        malformed = await post(client, world.customer, "not-a-uuid")  # slot 2: refused, counted
        # A client retrying after timeouts, then a bug that reuses the key: no slot.
        retries = [await post(client, world.customer, key) for _ in range(4)]
        reused = await post(client, world.customer, key, topic="other")
        unkeyed = await post(client, world.customer, None)  # slot 3, the last one
        # At the limit, a retry still answers its ticket; anything new is refused.
        late_retry = await post(client, world.customer, key)
        new_key = await post(client, world.customer, fresh)
        no_key = await post(client, world.customer, None)

    assert (first.status_code, malformed.status_code, unkeyed.status_code) == (201, 422, 201)
    assert [r.status_code for r in retries] == [200] * 4
    assert (reused.status_code, reused.json()) == (409, REUSED)
    assert (late_retry.status_code, late_retry.json()) == (200, first.json())
    assert (new_key.status_code, new_key.json()) == (429, RATE_LIMITED)
    assert (no_key.status_code, no_key.json()) == (429, RATE_LIMITED)
    assert len(await rows(db_session)) == 2


# Criterion 2: the same key with another body is a 409; keys are per user


@pytest.mark.parametrize(
    "change",
    [
        {"topic": "other"},
        {"message": f"{MESSAGE} Also the receipt."},
        {"job_id": "job"},
        {"platform": "android"},
        {"app_version": "9.8.8 (655)"},
        {"platform": None},
    ],
    ids=lambda change: next(iter(change)),
)
async def test_the_same_key_with_another_body_is_409_and_changes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    change: dict[str, Any],
) -> None:
    key = str(uuid.uuid4())
    if change.get("job_id") == "job":
        change = {"job_id": str((await make_job(db_session, world)).id)}
    created = await post(db_client, world.customer, key, platform="ios", app_version=VERSION)
    before = [
        (t.id, t.topic, t.message, t.job_id, t.platform, t.app_version, t.updated_at)
        for t in await rows(db_session)
    ]

    reused = await post(
        db_client, world.customer, key, **{"platform": "ios", "app_version": VERSION, **change}
    )

    assert created.status_code == 201
    assert (reused.status_code, reused.json()) == (409, REUSED)
    after = [
        (t.id, t.topic, t.message, t.job_id, t.platform, t.app_version, t.updated_at)
        for t in await rows(db_session)
    ]
    assert after == before
    # The key still answers its own body.
    retry = await post(db_client, world.customer, key, platform="ios", app_version=VERSION)
    assert (retry.status_code, retry.json()) == (200, created.json())


async def test_another_users_key_is_their_own(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    key = str(uuid.uuid4())

    ana = await post(db_client, world.customer, key)
    # Another body under the same key: no 409, so nothing tells one user of another's key.
    bob = await post(db_client, world.other_customer, key, topic="other", message="Hi")
    pro = await post(db_client, world.pro, key)

    assert [r.status_code for r in (ana, bob, pro)] == [201, 201, 201]
    assert len({r.json()["id"] for r in (ana, bob, pro)}) == 3
    for party, first in ((world.customer, ana), (world.pro, pro)):
        retry = await post(db_client, party, key)
        assert (retry.status_code, retry.json()) == (200, first.json())
    by_user = {t.user_id: str(t.id) for t in await rows(db_session)}
    assert by_user == {
        world.customer.id: ana.json()["id"],
        world.other_customer.id: bob.json()["id"],
        world.pro.id: pro.json()["id"],
    }


# Criterion 4: malformed input is refused before anything, and the key stays unused


@pytest.mark.parametrize(
    ("content", "status"),
    [
        (json.dumps(body(message=f"Leak{LONE_SURROGATE}")).encode(), 422),
        (json.dumps(body(app_version=f"1.0{LONE_SURROGATE}")).encode(), 422),
        (json.dumps(body(topic=f"payment{LONE_SURROGATE}")).encode(), 422),
        (json.dumps(body(message="nul \x00 byte")).encode(), 422),
        (b'{"topic": "payment", "message": "bad \xff\xfe bytes"}', 400),
        (b'{"topic": "payment", "message": ', 422),
    ],
    ids=["message", "app_version", "topic", "nul", "not_utf8", "not_json"],
)
async def test_malformed_input_answers_as_without_a_key_and_leaves_the_key_unused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    content: bytes,
    status: int,
) -> None:
    key = str(uuid.uuid4())

    unkeyed = await raw_post(db_client, world.customer, None, content)
    keyed = await raw_post(db_client, world.customer, key, content)

    assert keyed.status_code == unkeyed.status_code == status
    assert keyed.json() == unkeyed.json()
    assert await rows(db_session) == []
    # The refused attempt did not take the key: a valid body with it writes the ticket.
    created = await post(db_client, world.customer, key)
    retry = await post(db_client, world.customer, key)
    assert (created.status_code, retry.status_code) == (201, 200)
    [ticket] = await rows(db_session)
    assert str(ticket.id) == created.json()["id"] == retry.json()["id"]


def test_text_with_no_utf8_form_is_the_validation_error_before_the_key_is_looked_up() -> None:
    # The schema refuses it on every field today; a field added later that lets it through
    # must still be the 422, not a 500, and the key stays unused (#385 r1 met exactly this).
    data = SupportTicketIn.model_construct(topic=TicketTopic.OTHER, message=f"x{LONE_SURROGATE}")

    with pytest.raises(InvalidTicketInputError):
        _fingerprint(data)


# Criterion 5: no text in the logs, Sentry, the stored fingerprint or the replay


async def test_the_key_and_the_text_never_reach_the_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    key = uuid.uuid4()

    with caplog.at_level(logging.DEBUG):
        created = (await post(db_client, world.customer, str(key), app_version=VERSION)).json()
        await post(db_client, world.customer, str(key), app_version=VERSION)  # replayed
        await post(db_client, world.customer, str(key), message="Something else")  # 409
        await post(db_client, world.customer, f"{key}x")  # 422

    formatter = JsonFormatter()
    output = "\n".join(formatter.format(r) + r.getMessage() for r in caplog.records)
    for secret in (str(key), key.hex, "Something else", *TEXT_LEAKS):
        assert secret not in output
    events = [
        (record.getMessage(), json.loads(formatter.format(record)))
        for record in caplog.records
        if record.name == "app.modules.support.service"
    ]
    assert [event for event, _ in events] == [
        "support_ticket_created",
        "support_ticket_replayed",
        "support_ticket_idempotency_key_reused",
    ]
    fields = {"timestamp", "level", "logger", "message", "request_id"}
    assert set(events[1][1]) - fields == {"ticket_id", "user_id"}
    assert events[1][1]["ticket_id"] == created["id"]
    assert set(events[2][1]) - fields == {"user_id"}


async def test_the_fingerprint_and_the_replay_hold_no_text(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    key = str(uuid.uuid4())
    await post(db_client, world.customer, key, app_version=VERSION)

    replay = await post(db_client, world.customer, key, app_version=VERSION)

    [ticket] = await rows(db_session)
    fingerprint = ticket.idempotency_fingerprint or ""
    assert len(fingerprint) == 64
    assert set(fingerprint) <= set("0123456789abcdef")  # SHA-256, hex
    assert set(replay.json()) == CREATED_KEYS
    for leak in TEXT_LEAKS:
        assert leak not in fingerprint
        assert leak not in replay.text


async def test_a_failed_keyed_write_sends_no_text_to_sentry(
    db_session: AsyncSession,
    world: JobWorld,
    sentry_transport: MemoryTransport,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = _app(make_settings(sentry_dsn=TEST_DSN), db_session)
    key = str(uuid.uuid4())

    async def fail(self: SupportTicketRepository, ticket: SupportTicket) -> SupportTicket:
        raise RuntimeError("probe failure")

    monkeypatch.setattr(SupportTicketRepository, "add", fail)
    async with _client(app) as client:
        response = await post(client, world.customer, key, app_version=VERSION)
    sentry_sdk.flush()

    assert response.status_code == 500
    payloads = _payloads(sentry_transport)
    assert any('"exception"' in p for p in payloads), "no event was captured"
    wire = "\n".join(payloads)
    # The Idempotency-Key header itself may go with the event's request headers, as every
    # header but the credentials does (observability.before_send): a random UUID, per user.
    for leak in TEXT_LEAKS:
        assert leak not in wire


# Criterion 6: the window, from settings; the contract


async def test_a_key_older_than_the_window_writes_a_new_ticket(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    key = str(uuid.uuid4())
    first = (await post(db_client, world.customer, key)).json()

    async def made(ago: timedelta) -> None:
        await db_session.execute(
            update(SupportTicket)
            .where(SupportTicket.id == uuid.UUID(first["id"]))
            .values(created_at=func.now() - ago)
        )

    # A minute inside the window (2 h here, not the default 24 h): still the first ticket.
    await made(WINDOW - timedelta(minutes=1))
    inside = await post(db_client, world.customer, key)
    assert (inside.status_code, inside.json()["id"]) == (200, first["id"])

    # A minute past it: a new ticket, which takes the key; the old one keeps no key.
    await made(WINDOW + timedelta(minutes=1))
    past = await post(db_client, world.customer, key, message="The app froze again.")
    retry = await post(db_client, world.customer, key, message="The app froze again.")

    assert (past.status_code, retry.status_code) == (201, 200)
    assert past.json()["id"] != first["id"]
    assert retry.json() == past.json()
    old, new = await rows(db_session)
    assert (str(old.id), old.idempotency_key, old.idempotency_fingerprint) == (
        first["id"],
        None,
        None,
    )
    assert (str(new.id), new.idempotency_key) == (past.json()["id"], uuid.UUID(key))
    assert old.message == MESSAGE  # nothing else of the old ticket changed


def test_openapi_documents_the_key_and_both_answers(app: FastAPI) -> None:
    operation = app.openapi()["paths"][BASE]["post"]

    # One header: the rate limit's own read of it is not part of the contract.
    [header] = [p for p in operation["parameters"] if p["in"] == "header"]
    assert header["name"] == "Idempotency-Key"
    assert header.get("required", False) is False
    schema = header["schema"]
    assert {"type": "string", "format": "uuid"} in schema.get("anyOf", [schema])
    assert {"200", "201", "409", "422", "429"} <= set(operation["responses"])
    ok = operation["responses"]["200"]["content"]["application/json"]["schema"]
    created = operation["responses"]["201"]["content"]["application/json"]["schema"]
    assert ok == created
    assert "idempotency_key_reused" in operation["responses"]["409"]["description"]


# Criterion 3: concurrency, on real commits (two connections)


@dataclass(frozen=True)
class CommittedWriter:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    party: Party


@pytest.fixture
async def writer(app: FastAPI, committed: Committed) -> AsyncIterator[CommittedWriter]:
    """A customer, committed; their tickets are deleted afterwards (the `committed` fixture
    deletes the user)."""
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    async with committed.sessions() as session:
        user = User(email=committed.email, password_hash="x", role=UserRole.CUSTOMER)
        session.add(user)
        await session.commit()
    token = security.create_access_token(
        user_id=user.id,
        role=UserRole.CUSTOMER,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    party = Party(id=user.id, headers={"Authorization": f"Bearer {token}"})
    try:
        yield CommittedWriter(committed.client, committed.sessions, party)
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(SupportTicket).where(SupportTicket.user_id == user.id))
            await session.commit()


async def committed_rows(writer: CommittedWriter) -> Sequence[SupportTicket]:
    async with writer.sessions() as session:
        statement = select(SupportTicket).where(SupportTicket.user_id == writer.party.id)
        return list((await session.scalars(statement)).all())


async def test_a_retry_while_the_first_is_in_flight_answers_its_ticket(
    writer: CommittedWriter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first create has inserted its ticket and not committed yet. The retry finds no
    ticket and inserts too: the unique index makes it wait, as Postgres reports, until the
    first commits; then it answers the first's ticket."""
    key = str(uuid.uuid4())
    pids: list[int] = []
    both_inserting, first_inserted, go = asyncio.Event(), asyncio.Event(), asyncio.Event()
    add = SupportTicketRepository.add

    async def held_add(repo: SupportTicketRepository, ticket: SupportTicket) -> SupportTicket:
        pids.append(await backend_pid(repo._session))
        if len(pids) == 2:
            both_inserting.set()
        added = await add(repo, ticket)
        if not first_inserted.is_set():
            first_inserted.set()
            await go.wait()
        return added

    monkeypatch.setattr(SupportTicketRepository, "add", held_add)
    first = asyncio.create_task(post(writer.client, writer.party, key))
    retry: asyncio.Task[httpx.Response] | None = None
    try:
        async with asyncio.timeout(5):
            await first_inserted.wait()
            retry = asyncio.create_task(post(writer.client, writer.party, key))
            await both_inserting.wait()
        await wait_until_blocked(writer.sessions, waiter=pids[1], holder=pids[0])
        go.set()
        async with asyncio.timeout(10):
            created, replayed = await first, await retry
    finally:
        go.set()
        for task in (first, retry):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(t for t in (first, retry) if t is not None), return_exceptions=True)

    assert (created.status_code, replayed.status_code) == (201, 200)
    assert replayed.json() == created.json()
    [row] = await committed_rows(writer)
    assert str(row.id) == created.json()["id"]


async def test_simultaneous_creates_with_one_key_write_one_ticket(
    writer: CommittedWriter,
) -> None:
    key = str(uuid.uuid4())

    async with asyncio.timeout(10):
        responses = await asyncio.gather(
            *(post(writer.client, writer.party, key) for _ in range(5))
        )

    assert sorted(r.status_code for r in responses) == [200, 200, 200, 200, 201]
    assert len({json.dumps(r.json(), sort_keys=True) for r in responses}) == 1
    [row] = await committed_rows(writer)
    assert str(row.id) == responses[0].json()["id"]
    assert row.status == TicketStatus.OPEN
