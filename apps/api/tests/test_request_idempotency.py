"""Idempotency-Key on POST /v1/requests (#264): a retry after a timeout never makes a second
request, nor sends one to pros twice."""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.addresses.models import Address
from app.modules.auth import security
from app.modules.jobs.service import SYSTEM
from app.modules.requests import service as request_service
from app.modules.requests.models import RequestMedia, RequestStatus, ServiceRequest
from app.modules.requests.repository import ServiceRequestRepository
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.conftest import (
    TEST_JWT_SECRET,
    Committed,
    InMemoryRateLimiter,
    backend_pid,
    make_settings,
    wait_until_blocked,
)
from tests.test_requests_api import (
    ADDRESS,
    DESCRIPTION,
    ENQUEUE_TIMEOUT,
    NOW,
    VALIDATION_ERROR,
    Caller,
    FakeStorage,
    RecordingQueue,
    body,
    make_caller,
    make_category,
    queue,
    served,
    storage,
)

# Fixtures, used by name.
__all__ = ["queue", "served", "storage"]

# Not the default (24 h), so the tests prove the window comes from settings.
WINDOW = timedelta(hours=2)
REUSED = {
    "error": {
        "code": "idempotency_key_reused",
        "message": "This Idempotency-Key was already used with a different request.",
    }
}


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        request_idempotency_window_seconds=int(WINDOW.total_seconds()),
        job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT,
    )


async def post(
    client: httpx.AsyncClient, caller: Caller, key: str | None, **overrides: Any
) -> httpx.Response:
    headers = dict(caller.headers)
    if key is not None:
        headers["Idempotency-Key"] = key
    return await client.post("/v1/requests", json=body(**overrides), headers=headers)


async def keyed_rows(session: AsyncSession, customer_id: uuid.UUID) -> list[ServiceRequest]:
    statement = (
        select(ServiceRequest)
        .where(ServiceRequest.customer_id == customer_id)
        .order_by(ServiceRequest.created_at, ServiceRequest.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def addresses_of(session: AsyncSession, user_id: uuid.UUID) -> int:
    statement = select(func.count()).select_from(Address).where(Address.user_id == user_id)
    return (await session.scalar(statement)) or 0


# What a replay answers as it is now (#385 r1): the request's current status, and its media
# URLs signed anew. Exactly these, and nothing else of the 201's body, may differ.
VOLATILE_FIELDS = ("status", "customer_status")
VOLATILE_MEDIA_FIELDS = ("url", "expires_at")


def without_volatile(out: dict[str, Any]) -> dict[str, Any]:
    """A request's body without the volatile fields, the media kept in their order."""
    stable = {name: value for name, value in out.items() if name not in VOLATILE_FIELDS}
    stable["media"] = [
        {name: value for name, value in item.items() if name not in VOLATILE_MEDIA_FIELDS}
        for item in out["media"]
    ]
    return stable


@dataclass
class SigningStorage(FakeStorage):
    """Signs every URL anew, as the real storage does: a URL handed out again would show."""

    def presign_get(self, key: str, expires_in: int) -> str:
        super().presign_get(key, expires_in)
        return f"https://storage.example.invalid/get/{key}?sig={len(self.gets)}"


# Criterion 1: the first create 201, a retry 200 with the same request, and nothing again


async def test_retry_answers_the_first_request_and_does_nothing_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana = await make_caller(db_session)
    category_id = await make_category(db_session)
    photo = ana.media_key(".jpg")
    key = str(uuid.uuid4())
    draft: dict[str, Any] = {"category_id": str(category_id), "media_keys": [photo]}

    first = await post(db_client, ana, key, **draft)
    # What the first create checked has changed since: its ZIP is no longer served and its
    # photo is attached. The retry is not checked again, so neither matters.
    await db_session.execute(update(ServiceArea).values(active=False))
    retries = [await post(db_client, ana, key, **draft) for _ in range(3)]

    assert first.status_code == 201
    assert [retry.status_code for retry in retries] == [200, 200, 200]
    assert all(
        without_volatile(retry.json()) == without_volatile(first.json()) for retry in retries
    )
    [row] = await keyed_rows(db_session, ana.id)
    assert str(row.id) == first.json()["id"]
    assert await addresses_of(db_session, ana.id) == 1
    media = await db_session.scalar(
        select(func.count()).select_from(RequestMedia).where(RequestMedia.request_id == row.id)
    )
    assert media == 1
    # Dispatch and the media's safe copy were queued once: each enqueue call is recorded.
    assert len(queue.before) == 2
    assert {function for function, _ in queue.jobs.values()} == {
        "dispatch_request",
        "sanitize_request_media",
    }


async def test_retry_body_is_the_first_create_body(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    key = str(uuid.uuid4())

    first = await post(db_client, ana, key)
    retry = await post(db_client, ana, key)

    assert (first.status_code, retry.status_code) == (201, 200)
    assert retry.json() == first.json()
    assert retry.headers["content-type"] == first.headers["content-type"]


async def test_a_later_replay_answers_media_urls_signed_anew(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signing = SigningStorage()
    app.dependency_overrides[get_storage] = lambda: signing
    start = datetime.now(UTC).replace(microsecond=0)

    class Clock(datetime):
        """The service's clock, moved by the test."""

        at = start

        @classmethod
        def now(cls, tz: Any = None) -> "Clock":
            return cls.fromtimestamp(cls.at.timestamp(), tz)

    monkeypatch.setattr(request_service, "datetime", Clock)
    ana = await make_caller(db_session)
    photo, video = ana.media_key(".jpg"), ana.media_key(".mp4")
    key = str(uuid.uuid4())

    first = await post(db_client, ana, key, media_keys=[photo, video])
    Clock.at = start + timedelta(minutes=1)
    retry = await post(db_client, ana, key, media_keys=[photo, video])

    assert (first.status_code, retry.status_code) == (201, 200)
    assert without_volatile(retry.json()) == without_volatile(first.json())
    # The media's volatile fields differ, and are the live ones: signed again at the retry,
    # each for the configured lifetime from the retry's clock.
    seconds = settings.download_url_ttl_seconds
    ttl = timedelta(seconds=seconds)
    signed = "https://storage.example.invalid/get/{}?sig={}"

    def volatile(out: dict[str, Any]) -> list[tuple[str, datetime]]:
        return [(item["url"], datetime.fromisoformat(item["expires_at"])) for item in out["media"]]

    # The body's media order (both rows share a created_at), the same in both answers.
    files = [photo if item["kind"] == "photo" else video for item in first.json()["media"]]
    assert volatile(first.json()) == [
        (signed.format(file, n), start + ttl) for n, file in enumerate(files, start=1)
    ]
    assert volatile(retry.json()) == [
        (signed.format(file, n), Clock.at + ttl) for n, file in enumerate(files, start=3)
    ]
    assert signing.gets == [(file, seconds) for file in files] * 2


async def test_a_replay_after_a_transition_answers_the_current_status(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    key = str(uuid.uuid4())
    first = await post(db_client, ana, key)
    request_id = uuid.UUID(first.json()["id"])
    await RequestStateMachine(db_session).transition(request_id, RequestStatus.FINDING_PRO, SYSTEM)
    await db_session.commit()

    retry = await post(db_client, ana, key)
    live = await db_client.get(f"/v1/requests/{request_id}", headers=ana.headers)

    assert (first.status_code, retry.status_code, live.status_code) == (201, 200, 200)
    assert without_volatile(retry.json()) == without_volatile(first.json())
    # The status fields differ from the 201's, and are the request's live ones.
    for name in VOLATILE_FIELDS:
        assert retry.json()[name] != first.json()[name]
        assert retry.json()[name] == live.json()[name]
    assert retry.json()["status"] == RequestStatus.FINDING_PRO.value


async def test_same_body_laid_out_differently_is_a_retry(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    key = str(uuid.uuid4())
    first = await post(db_client, ana, key, description=DESCRIPTION)

    # Keys in another order, the description padded (it is stored trimmed), defaults spelled.
    layout = {
        "intake_answers": {},
        "address": dict(reversed(list(ADDRESS.items()))),
        "media_keys": [],
        "description": f"  {DESCRIPTION}  ",
    }
    retry = await db_client.post(
        "/v1/requests",
        content=json.dumps(layout, indent=4),
        headers={**ana.headers, "Idempotency-Key": key, "Content-Type": "application/json"},
    )

    assert (first.status_code, retry.status_code) == (201, 200)
    assert retry.json() == first.json()


# Criterion 2: another body is a 409; another customer's key is their own


@pytest.mark.parametrize(
    "changed",
    [
        lambda _: {"description": "Water leaks under the bathroom sink"},
        lambda _: {"address": {**ADDRESS, "line1": "744 Evergreen Terrace"}},
        lambda _: {"address": {**ADDRESS, "line2": "Apt 2"}},
        lambda _: {"preferred_date": "2099-01-01"},
        lambda _: {"utm": {"source": "flyer"}},
        lambda caller: {"media_keys": [caller.media_key(".jpg")]},
    ],
    ids=["description", "line1", "line2", "date", "utm", "media"],
)
async def test_same_key_with_another_body_is_409_and_changes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    changed: Callable[[Caller], dict[str, Any]],
) -> None:
    ana = await make_caller(db_session)
    key = str(uuid.uuid4())
    first = await post(db_client, ana, key)

    refused = await post(db_client, ana, key, **changed(ana))

    assert (refused.status_code, refused.json()) == (409, REUSED)
    [row] = await keyed_rows(db_session, ana.id)
    assert str(row.id) == first.json()["id"]
    assert (row.description, row.preferred_date, row.utm) == (DESCRIPTION, None, None)
    assert await addresses_of(db_session, ana.id) == 1
    assert len(queue.before) == 1
    # The first body still answers with its request.
    again = await post(db_client, ana, key)
    assert (again.status_code, again.json()) == (200, first.json())


async def test_another_customers_key_is_their_own(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana, bob = await make_caller(db_session), await make_caller(db_session)
    key = str(uuid.uuid4())

    anas = await post(db_client, ana, key)
    # The same key, with the same body and with another: Bob's own first create each time.
    bobs = await post(db_client, bob, key)
    bobs_retry = await post(db_client, bob, key)
    bobs_other = await post(db_client, bob, key, description="Another one")

    assert (anas.status_code, bobs.status_code, bobs_retry.status_code) == (201, 201, 200)
    assert bobs.json()["id"] != anas.json()["id"]
    assert bobs_retry.json() == bobs.json()
    assert (bobs_other.status_code, bobs_other.json()) == (409, REUSED)
    assert [row.idempotency_key for row in await keyed_rows(db_session, ana.id)] == [uuid.UUID(key)]
    assert [row.idempotency_key for row in await keyed_rows(db_session, bob.id)] == [uuid.UUID(key)]
    assert len(queue.before) == 2


# Criterion 4: no key, today's behaviour; a key must be a UUID


async def test_without_a_key_every_create_makes_a_request(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana = await make_caller(db_session)

    responses = [await post(db_client, ana, None) for _ in range(2)]

    assert [response.status_code for response in responses] == [201, 201]
    rows = await keyed_rows(db_session, ana.id)
    assert len(rows) == 2
    assert [(row.idempotency_key, row.idempotency_fingerprint) for row in rows] == [
        (None, None)
    ] * 2
    assert len(queue.before) == 2


@pytest.mark.parametrize(
    "key",
    ["", "not-a-uuid", "12345", f"{uuid.uuid4()}x", "' OR 1=1 --", "0" * 33],
    ids=["empty", "word", "number", "suffix", "quote", "33_hex"],
)
async def test_a_key_that_is_not_a_uuid_is_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    key: str,
) -> None:
    ana = await make_caller(db_session)

    response = await post(db_client, ana, key)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await keyed_rows(db_session, ana.id) == []
    assert queue.before == []


LONE_SURROGATE = "\ud800"  # valid in JSON text ("\ud800"), with no UTF-8 form


@pytest.mark.parametrize(
    "malformed",
    [
        lambda _: {"description": f"Leak{LONE_SURROGATE}"},
        lambda _: {"address": {**ADDRESS, "line1": f"742{LONE_SURROGATE}"}},
        lambda _: {"address": {**ADDRESS, "line2": f"Apt{LONE_SURROGATE}"}},
        lambda _: {"address": {**ADDRESS, "city": f"Or{LONE_SURROGATE}"}},
        lambda _: {"address": {**ADDRESS, "state": f"F{LONE_SURROGATE}"}},
        lambda _: {"address": {**ADDRESS, "zip_code": f"3280{LONE_SURROGATE}"}},
        lambda _: {"utm": {"source": f"ig{LONE_SURROGATE}"}},
        lambda _: {"utm": {"medium": f"social{LONE_SURROGATE}"}},
        lambda _: {"utm": {"campaign": f"fall{LONE_SURROGATE}"}},
        lambda _: {"utm": {"term": f"plumber{LONE_SURROGATE}"}},
        lambda _: {"utm": {"content": f"ad{LONE_SURROGATE}"}},
        lambda _: {"intake_answers": {"notes": LONE_SURROGATE}},
        lambda _: {"intake_answers": {f"no{LONE_SURROGATE}tes": "x"}},
        lambda _: {"intake_answers": {"nested": [{"deep": LONE_SURROGATE}]}},
        lambda caller: {"media_keys": [caller.media_key(f"{LONE_SURROGATE}.jpg")]},
    ],
    ids=[
        "description",
        "line1",
        "line2",
        "city",
        "state",
        "zip_code",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "intake_value",
        "intake_key",
        "intake_nested",
        "media_key",
    ],
)
async def test_text_with_no_utf8_form_is_422_with_a_key_and_leaves_the_key_unused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    malformed: Callable[[Caller], dict[str, Any]],
) -> None:
    ana = await make_caller(db_session)
    key = str(uuid.uuid4())

    # Serialized here: httpx refuses lone surrogates, a raw client does not.
    refused = await db_client.post(
        "/v1/requests",
        content=json.dumps(body(**malformed(ana))),
        headers={**ana.headers, "Idempotency-Key": key, "Content-Type": "application/json"},
    )

    assert (refused.status_code, refused.json()) == (422, VALIDATION_ERROR)
    assert await keyed_rows(db_session, ana.id) == []
    assert await addresses_of(db_session, ana.id) == 0
    assert queue.before == []
    # The refused attempt did not take the key: a valid body with it creates the request.
    created = await post(db_client, ana, key)
    retry = await post(db_client, ana, key)
    assert (created.status_code, retry.status_code) == (201, 200)
    [row] = await keyed_rows(db_session, ana.id)
    assert str(row.id) == created.json()["id"] == retry.json()["id"]
    assert len(queue.before) == 1


async def test_the_key_and_the_body_never_reach_the_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await make_caller(db_session)
    key = uuid.uuid4()

    with caplog.at_level(logging.DEBUG):
        created = (await post(db_client, ana, str(key))).json()
        await post(db_client, ana, str(key))  # replayed
        await post(db_client, ana, str(key), description="Something else")  # 409
        await post(db_client, ana, f"{key}x")  # 422

    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records) + caplog.text
    for secret in (str(key), key.hex, DESCRIPTION, "Something else", ADDRESS["line1"]):
        assert secret not in output
    events = [
        (record.message, json.loads(formatter.format(record)))
        for record in caplog.records
        if record.name == "app.modules.requests.service"
    ]
    assert [event for event, _ in events] == [
        "request_created",
        "request_replayed",
        "request_idempotency_key_reused",
    ]
    fields = {"timestamp", "level", "logger", "message", "request_id"}
    assert set(events[1][1]) - fields == {"service_request_id", "user_id"}
    assert events[1][1]["service_request_id"] == created["id"]
    assert set(events[2][1]) - fields == {"user_id"}


# Criterion 5: the window, from settings


async def test_a_key_older_than_the_window_makes_a_new_request(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana = await make_caller(db_session)
    key = str(uuid.uuid4())
    first = (await post(db_client, ana, key)).json()

    async def made(ago: timedelta) -> None:
        await db_session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == uuid.UUID(first["id"]))
            .values(created_at=datetime.now(UTC) - ago)
        )

    # A minute inside the window (2 h here, not the default 24 h): still the first request.
    await made(WINDOW - timedelta(minutes=1))
    inside = await post(db_client, ana, key)
    assert (inside.status_code, inside.json()["id"]) == (200, first["id"])

    # A minute past it: a new request, which takes the key; the old one keeps no key.
    await made(WINDOW + timedelta(minutes=1))
    past = await post(db_client, ana, key, description="The leak is back")
    retry = await post(db_client, ana, key, description="The leak is back")

    assert (past.status_code, retry.status_code) == (201, 200)
    assert past.json()["id"] != first["id"]
    assert retry.json() == past.json()
    old, new = await keyed_rows(db_session, ana.id)
    assert (str(old.id), old.idempotency_key, old.idempotency_fingerprint) == (
        first["id"],
        None,
        None,
    )
    assert (str(new.id), new.idempotency_key) == (past.json()["id"], uuid.UUID(key))
    assert old.description == DESCRIPTION  # nothing else of the old request changed
    assert len(queue.before) == 2


# Criterion 6: the contract


def test_openapi_documents_the_key_and_both_answers(app: FastAPI) -> None:
    operation = app.openapi()["paths"]["/v1/requests"]["post"]

    [header] = [p for p in operation["parameters"] if p["in"] == "header"]
    assert header["name"] == "Idempotency-Key"
    assert header.get("required", False) is False
    schema = header["schema"]
    assert {"type": "string", "format": "uuid"} in schema.get("anyOf", [schema])
    assert {"200", "201", "409", "422"} <= set(operation["responses"])
    ok = operation["responses"]["200"]["content"]["application/json"]["schema"]
    created = operation["responses"]["201"]["content"]["application/json"]["schema"]
    assert ok == created
    assert "idempotency_key_reused" in operation["responses"]["409"]["description"]


# Criterion 3: concurrency, on real commits (two connections)


@dataclass(frozen=True)
class CommittedCustomer:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    caller: Caller


@pytest.fixture
async def customer(app: FastAPI, committed: Committed) -> AsyncIterator[CommittedCustomer]:
    """A customer and the fixture ZIP as a service area, committed; their requests and
    addresses are deleted afterwards (the `committed` fixture deletes the user)."""
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    async with committed.sessions() as session:
        user = User(email=committed.email, password_hash="x", role=UserRole.CUSTOMER)
        area = ServiceArea(
            region="Idempotency", city="Orlando", state="FL", zip_code=ADDRESS["zip_code"]
        )
        session.add_all([user, area])
        await session.commit()
    token = security.create_access_token(
        user_id=user.id,
        role=UserRole.CUSTOMER,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    caller = Caller(id=user.id, headers={"Authorization": f"Bearer {token}"})
    try:
        yield CommittedCustomer(committed.client, committed.sessions, caller)
    finally:
        async with committed.sessions() as session:
            await session.execute(
                delete(ServiceRequest).where(ServiceRequest.customer_id == user.id)
            )
            await session.execute(delete(Address).where(Address.user_id == user.id))
            await session.execute(delete(ServiceArea).where(ServiceArea.id == area.id))
            await session.commit()


async def committed_rows(customer: CommittedCustomer) -> Sequence[ServiceRequest]:
    async with customer.sessions() as session:
        return await keyed_rows(session, customer.caller.id)


async def test_a_retry_while_the_first_is_in_flight_answers_its_request(
    customer: CommittedCustomer, queue: RecordingQueue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first create has inserted its request and not committed yet. The retry finds no
    request, checks the body and inserts too: the unique index makes it wait, as Postgres
    reports, until the first commits; then it answers the first's request."""
    key = str(uuid.uuid4())
    pids: list[int] = []
    both_inserting, first_inserted, go = asyncio.Event(), asyncio.Event(), asyncio.Event()
    add, add_media = ServiceRequestRepository.add, ServiceRequestRepository.add_media

    async def recorded_add(repo: ServiceRequestRepository, row: ServiceRequest) -> ServiceRequest:
        pids.append(await backend_pid(repo._session))
        if len(pids) == 2:
            both_inserting.set()
        return await add(repo, row)

    async def held_add_media(repo: ServiceRequestRepository, media: Sequence[RequestMedia]) -> None:
        if not first_inserted.is_set():
            first_inserted.set()
            await go.wait()
        await add_media(repo, media)

    monkeypatch.setattr(ServiceRequestRepository, "add", recorded_add)
    monkeypatch.setattr(ServiceRequestRepository, "add_media", held_add_media)
    first = asyncio.create_task(post(customer.client, customer.caller, key))
    retry: asyncio.Task[httpx.Response] | None = None
    try:
        async with asyncio.timeout(5):
            await first_inserted.wait()
            retry = asyncio.create_task(post(customer.client, customer.caller, key))
            await both_inserting.wait()
        await wait_until_blocked(customer.sessions, waiter=pids[1], holder=pids[0])
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
    [row] = await committed_rows(customer)
    assert str(row.id) == created.json()["id"]
    async with customer.sessions() as session:
        assert await addresses_of(session, customer.caller.id) == 1  # the retry's rolled back
    assert len(queue.before) == 1  # dispatched once


async def test_simultaneous_creates_with_one_key_make_one_request(
    customer: CommittedCustomer, queue: RecordingQueue
) -> None:
    key = str(uuid.uuid4())

    async with asyncio.timeout(10):
        responses = await asyncio.gather(
            *(post(customer.client, customer.caller, key) for _ in range(5))
        )

    assert sorted(response.status_code for response in responses) == [200, 200, 200, 200, 201]
    assert len({json.dumps(response.json(), sort_keys=True) for response in responses}) == 1
    [row] = await committed_rows(customer)
    assert str(row.id) == responses[0].json()["id"]
    async with customer.sessions() as session:
        assert await addresses_of(session, customer.caller.id) == 1
    assert len(queue.before) == 1
