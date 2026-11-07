"""The original of a redacted chat message (#72): sealed with app.crypto at write, staff-only
and audited at read, cleared by the worker after the retention, never logged; plus the
sender's warning and the startup warning without a key."""

import base64
import json
import logging
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any, Final

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import func, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.crypto import (
    NONCE_BYTES,
    DecryptionError,
    KeyringError,
    OriginalCipher,
    Sealed,
    parse_keyring,
)
from app.db import get_session
from app.main import create_app
from app.modules.audit.models import AuditLog
from app.modules.audit.repository import AuditRepository
from app.modules.chat.models import JobMessage
from app.modules.chat.repository import ChatRepository
from app.modules.chat.service import original_associated_data
from app.modules.chat.tasks import purge_expired_originals
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from app.redaction import MASK
from tests.audit_helpers import audit_rows
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import JobWorld, build_world, make_job
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads

# Test keys only: fixed bytes, never a deployed key.
KEY_A: Final = base64.b64encode(bytes(range(32))).decode()
KEY_B: Final = base64.b64encode(bytes(range(100, 132))).decode()
KEYS: Final = json.dumps({"k1": KEY_A})
SECRET: Final = "the spare key is under the blue flowerpot"
TYPED: Final = f"{SECRET}, call me at 305-555-0199"
STORED: Final = f"{SECRET}, call me at {MASK}"
WARNING: Final = "contact_details_hidden"


def keyed_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "chat_original_keys": KEYS,
        "chat_original_active_key_id": "k1",
        **overrides,
    }
    return make_settings(**values)


@pytest.fixture
def settings() -> Settings:
    return keyed_settings()


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def messages_path(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/messages"


def staff_path(job_id: uuid.UUID) -> str:
    return f"/v1/admin/jobs/{job_id}/messages"


async def stored(session: AsyncSession, message_id: str) -> JobMessage:
    statement = (
        select(JobMessage)
        .where(JobMessage.id == uuid.UUID(message_id))
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def audit_count(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count()).select_from(AuditLog)) or 0)


def cipher() -> OriginalCipher:
    return OriginalCipher(parse_keyring(KEYS), "k1")


# --- app.crypto ------------------------------------------------------------------------------


def test_round_trip_and_a_fresh_nonce_each_time() -> None:
    sealing = cipher()
    data = original_associated_data(uuid.uuid4())

    first, second = sealing.encrypt(TYPED, data), sealing.encrypt(TYPED, data)

    assert first.key_id == second.key_id == "k1"
    assert first.ciphertext[:NONCE_BYTES] != second.ciphertext[:NONCE_BYTES]
    assert first.ciphertext != second.ciphertext
    assert SECRET.encode() not in first.ciphertext
    assert sealing.decrypt(first, data) == sealing.decrypt(second, data) == TYPED


def test_nonces_do_not_repeat_over_many_messages() -> None:
    sealing = cipher()
    nonces = {sealing.encrypt("x", b"a").ciphertext[:NONCE_BYTES] for _ in range(2_000)}
    assert len(nonces) == 2_000


def test_an_older_key_still_opens_what_it_sealed() -> None:
    data = b"m"
    old = OriginalCipher(parse_keyring(KEYS), "k1").encrypt(TYPED, data)
    rotated = OriginalCipher(parse_keyring(json.dumps({"k1": KEY_A, "k2": KEY_B})), "k2")

    assert rotated.encrypt(TYPED, data).key_id == "k2"
    assert rotated.decrypt(old, data) == TYPED


@pytest.mark.parametrize("change", ["key_id", "wrong_key", "byte", "nonce", "aad", "short"])
def test_anything_altered_does_not_open(change: str) -> None:
    sealing = cipher()
    data = original_associated_data(uuid.uuid4())
    sealed = sealing.encrypt(TYPED, data)
    flipped = bytearray(sealed.ciphertext)
    if change == "key_id":
        sealed = Sealed("k9", sealed.ciphertext)
    elif change == "wrong_key":
        sealing = OriginalCipher(parse_keyring(json.dumps({"k1": KEY_B})), "k1")
    elif change == "byte":
        flipped[-1] ^= 1
        sealed = Sealed("k1", bytes(flipped))
    elif change == "nonce":
        flipped[0] ^= 1
        sealed = Sealed("k1", bytes(flipped))
    elif change == "aad":
        data = original_associated_data(uuid.uuid4())
    else:
        sealed = Sealed("k1", sealed.ciphertext[:20])

    with pytest.raises(DecryptionError) as raised:
        sealing.decrypt(sealed, data)
    assert str(raised.value) == ""


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        "{}",
        json.dumps({"k1": 5}),
        json.dumps({"k1": "***"}),
        json.dumps({"k1": base64.b64encode(b"short").decode()}),
        json.dumps({"bad id!": KEY_A}),
        json.dumps({"k" * 33: KEY_A}),
    ],
)
def test_a_malformed_keyring_is_refused_without_its_value(raw: str) -> None:
    with pytest.raises(KeyringError) as raised:
        parse_keyring(raw)
    assert KEY_A not in str(raised.value)


@pytest.mark.parametrize(
    "overrides",
    [
        {"chat_original_keys": json.dumps({"k1": KEY_A[:-4]})},
        {"chat_original_active_key_id": "k2"},
        {"chat_original_active_key_id": None},
        {"chat_original_keys": None},
    ],
    ids=["bad_key", "unknown_active", "no_active", "active_without_keys"],
)
def test_settings_refuse_a_bad_keyring_without_printing_it(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError) as raised:
        keyed_settings(**overrides)
    for leak in (KEY_A, KEY_A[:-4]):
        assert leak not in str(raised.value)
        assert leak not in repr(raised.value)


def test_settings_never_print_the_keys() -> None:
    settings = keyed_settings()
    assert KEY_A not in repr(settings)
    assert KEY_A not in str(settings.model_dump())
    assert make_settings().chat_original_cipher() is None


# --- Writing ---------------------------------------------------------------------------------


async def test_a_redacted_message_keeps_its_original_sealed_for_the_retention(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.post(
        messages_path(job.id), json={"body": f"  {TYPED} \n"}, headers=world.pro.headers
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["body"], body["redacted"], body["warning"]) == (STORED, True, WARNING)
    assert "original" not in body
    message = await stored(db_session, body["id"])
    assert message.body == STORED
    assert message.original_ciphertext is not None
    assert message.original_key_id == "k1"
    assert message.original_expires_at == message.created_at + timedelta(days=90)
    assert SECRET.encode() not in message.original_ciphertext
    sealed = Sealed(message.original_key_id, message.original_ciphertext)
    # What the sender typed, trimmed (the schema strips it), bound to this message's id.
    assert cipher().decrypt(sealed, original_associated_data(message.id)) == TYPED


async def test_the_retention_comes_from_the_settings(
    db_session: AsyncSession, world: JobWorld
) -> None:
    app = _app(keyed_settings(chat_original_retention_days=30), db_session)
    job = await make_job(db_session, world)
    async with _client(app) as client:
        response = await client.post(
            messages_path(job.id), json={"body": TYPED}, headers=world.customer.headers
        )
    message = await stored(db_session, response.json()["id"])
    assert message.original_expires_at == message.created_at + timedelta(days=30)


async def test_an_unredacted_message_keeps_no_original_and_no_warning(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)

    response = await db_client.post(
        messages_path(job.id), json={"body": "The faucet drips at 7 pm"}, headers=world.pro.headers
    )

    assert response.status_code == 201, response.text
    assert (response.json()["redacted"], response.json()["warning"]) == (False, None)
    message = await stored(db_session, response.json()["id"])
    assert (message.original_ciphertext, message.original_key_id) == (None, None)
    assert message.original_expires_at is None


async def test_without_a_key_nothing_is_kept_but_the_sender_is_still_warned(
    db_session: AsyncSession, world: JobWorld
) -> None:
    app = _app(make_settings(), db_session)
    job = await make_job(db_session, world)
    async with _client(app) as client:
        response = await client.post(
            messages_path(job.id), json={"body": TYPED}, headers=world.customer.headers
        )

    assert response.status_code == 201, response.text
    assert (response.json()["body"], response.json()["warning"]) == (STORED, WARNING)
    message = await stored(db_session, response.json()["id"])
    assert (message.original_ciphertext, message.original_key_id) == (None, None)
    assert message.original_expires_at is None


async def test_participants_never_read_an_original(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await db_client.post(messages_path(job.id), json={"body": TYPED}, headers=world.pro.headers)

    for party in (world.customer, world.pro):
        listed = await db_client.get(messages_path(job.id), headers=party.headers)
        assert listed.status_code == 200
        [item] = listed.json()["items"]
        assert "original" not in item
        # The prose around a contact is the message itself; the contact is not.
        assert item["body"] == STORED
        assert "305-555-0199" not in listed.text
    # Only staff have a route to it, and a participant is refused there.
    for party in (world.customer, world.pro):
        refused = await db_client.get(staff_path(job.id), headers=party.headers)
        assert refused.status_code == 403
        assert SECRET not in refused.text


# --- Staff reads -----------------------------------------------------------------------------


async def test_staff_read_the_original_and_each_read_is_audited(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    sent = await db_client.post(
        messages_path(job.id), json={"body": TYPED}, headers=world.customer.headers
    )
    plain = await db_client.post(
        messages_path(job.id), json={"body": "see you at 9"}, headers=world.pro.headers
    )
    before = await audit_count(db_session)

    for staff in (world.agent, world.admin):
        response = await db_client.get(staff_path(job.id), headers=staff.headers)
        assert response.status_code == 200, response.text
        items = {item["id"]: item for item in response.json()["items"]}
        assert items[sent.json()["id"]]["original"] == TYPED
        assert items[sent.json()["id"]]["body"] == STORED
        assert items[plain.json()["id"]]["original"] is None

    rows = await audit_rows(db_session)
    assert await audit_count(db_session) == before + 2
    reads = [row for row in rows if row.action == "job.read_chat_originals"]
    assert sorted(str(row.actor_user_id) for row in reads) == sorted(
        str(staff.id) for staff in (world.agent, world.admin)
    )
    for row in reads:
        assert (row.entity_type, row.entity_id) == ("job", job.id)
        assert row.after == {"originals": 1, "message_ids": sent.json()["id"]}
        assert row.before == {}
        assert SECRET not in json.dumps(row.after)


async def test_a_page_without_originals_writes_no_audit_row(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await db_client.post(messages_path(job.id), json={"body": "hello"}, headers=world.pro.headers)
    before = await audit_count(db_session)

    response = await db_client.get(staff_path(job.id), headers=world.admin.headers)

    assert response.status_code == 200
    assert [item["original"] for item in response.json()["items"]] == [None]
    assert await audit_count(db_session) == before


async def test_an_expired_original_is_not_shown_even_before_the_purge(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    sent = await db_client.post(
        messages_path(job.id), json={"body": TYPED}, headers=world.pro.headers
    )
    message = await stored(db_session, sent.json()["id"])
    message.original_expires_at = await ChatRepository(db_session).now() - timedelta(seconds=1)
    await db_session.flush()
    before = await audit_count(db_session)

    response = await db_client.get(staff_path(job.id), headers=world.admin.headers)

    assert response.json()["items"][0]["original"] is None
    assert await audit_count(db_session) == before


@pytest.mark.parametrize("damage", ["tampered", "unknown_key_id", "moved", "no_key"])
async def test_an_original_that_does_not_open_is_null_and_an_error_with_ids_only(
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
    damage: str,
) -> None:
    job = await make_job(db_session, world)
    async with _client(_app(keyed_settings(), db_session)) as client:
        first = await client.post(
            messages_path(job.id), json={"body": TYPED}, headers=world.pro.headers
        )
        second = await client.post(
            messages_path(job.id),
            json={"body": "write jane.doe@gmail.com"},
            headers=world.pro.headers,
        )
    message = await stored(db_session, first.json()["id"])
    other = await stored(db_session, second.json()["id"])
    assert message.original_ciphertext is not None
    if damage == "tampered":
        flipped = bytearray(message.original_ciphertext)
        flipped[NONCE_BYTES] ^= 1
        message.original_ciphertext = bytes(flipped)
    elif damage == "unknown_key_id":
        message.original_key_id = "k9"
    elif damage == "moved":
        # Another message's sealed original copied onto this row does not open here.
        message.original_ciphertext = other.original_ciphertext
    await db_session.flush()
    settings = make_settings() if damage == "no_key" else keyed_settings()

    with caplog.at_level(logging.DEBUG):
        async with _client(_app(settings, db_session)) as client:
            response = await client.get(staff_path(job.id), headers=world.admin.headers)

    assert response.status_code == 200, response.text
    items = {item["id"]: item["original"] for item in response.json()["items"]}
    assert items[str(message.id)] is None
    assert items[str(other.id)] == (None if damage == "no_key" else "write jane.doe@gmail.com")
    errors = [r for r in caplog.records if r.getMessage() == "chat_original_unreadable"]
    unreadable = {r.__dict__["message_id"] for r in errors}
    assert str(message.id) in unreadable
    for record in errors:
        assert record.levelno == logging.ERROR
        assert record.__dict__["job_id"] == str(job.id)
        assert record.__dict__["staff_id"] == str(world.admin.id)
    _assert_no_leak(caplog.records)


async def test_a_failed_audit_write_shows_nothing_and_sentry_gets_no_text(
    db_session: AsyncSession,
    world: JobWorld,
    sentry_transport: MemoryTransport,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job = await make_job(db_session, world)
    app = _app(keyed_settings(sentry_dsn=TEST_DSN), db_session)
    async with _client(app) as client:
        await client.post(messages_path(job.id), json={"body": TYPED}, headers=world.pro.headers)

        async def fail(self: AuditRepository, **fields: Any) -> None:
            raise RuntimeError("probe failure")

        monkeypatch.setattr(AuditRepository, "add", fail)
        response = await client.get(staff_path(job.id), headers=world.admin.headers)
    sentry_sdk.flush()

    assert response.status_code == 500
    assert SECRET not in response.text
    payloads = _payloads(sentry_transport)
    assert any('"exception"' in p for p in payloads), "no event was captured"
    wire = "\n".join(payloads)
    for leak in (SECRET, "flowerpot", "305-555-0199", KEY_A):
        assert leak not in wire


# --- Logs ------------------------------------------------------------------------------------


async def test_logs_never_carry_the_text_or_the_keys(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)

    with caplog.at_level(logging.DEBUG):
        sent = await db_client.post(
            messages_path(job.id), json={"body": TYPED}, headers=world.pro.headers
        )
        await db_client.get(staff_path(job.id), headers=world.admin.headers)

    [record] = [r for r in caplog.records if r.getMessage() == "job_message_sent"]
    assert (record.__dict__["redacted"], record.__dict__["original_kept"]) == (True, True)
    assert record.__dict__["message_id"] == sent.json()["id"]
    [read] = [r for r in caplog.records if r.getMessage() == "job_chat_read_by_staff"]
    assert (read.__dict__["count"], read.__dict__["originals"]) == (1, 1)
    _assert_no_leak(caplog.records)


def _assert_no_leak(records: list[logging.LogRecord]) -> None:
    formatter = JsonFormatter()
    logs = "\n".join(formatter.format(r) + r.getMessage() for r in records)
    for leak in (SECRET, "flowerpot", "305-555-0199", "jane.doe", KEY_A, KEY_B, MASK):
        assert leak not in logs


# --- Startup ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("app_env", "keyed", "warned"),
    [
        ("staging", False, True),
        ("production", False, True),
        ("staging", True, False),
        ("development", False, False),
        ("test", False, False),
    ],
)
async def test_startup_warns_once_without_a_key_where_deployed(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    app_env: str,
    keyed: bool,
    warned: bool,
) -> None:
    settings = keyed_settings() if keyed else make_settings()
    # Only the branch under test: the deployed validators need many other settings.
    monkeypatch.setattr(settings, "app_env", app_env)
    app = create_app(settings)

    with caplog.at_level(logging.DEBUG):
        async with app.router.lifespan_context(app):
            pass

    warnings = [r for r in caplog.records if r.getMessage() == "chat_original_key_missing"]
    assert len(warnings) == (1 if warned else 0)
    if warned:
        assert warnings[0].levelno == logging.WARNING
    _assert_no_leak(caplog.records)


# --- Purge -----------------------------------------------------------------------------------


async def _seed_originals(session: AsyncSession, world: JobWorld, count: int) -> list[JobMessage]:
    job = await make_job(session, world)
    now = await ChatRepository(session).now()
    sealing = cipher()
    messages = []
    for index in range(count):
        message = JobMessage(job_id=job.id, sender_id=world.pro.id, body=MASK, redacted=True)
        session.add(message)
        await session.flush()
        sealed = sealing.encrypt(TYPED, original_associated_data(message.id))
        message.original_ciphertext = sealed.ciphertext
        message.original_key_id = sealed.key_id
        message.original_expires_at = now - timedelta(days=1) + timedelta(seconds=index)
        messages.append(message)
    await session.flush()
    return messages


def _sessions(session: AsyncSession) -> Any:
    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        try:
            yield session
        except BaseException:
            await session.rollback()
            raise

    return factory


async def _kept(session: AsyncSession, messages: list[JobMessage]) -> list[bool]:
    result = []
    for message in messages:
        # By identity: a rolled-back batch expired the objects, and a lazy load cannot run here.
        row = await stored(session, str(inspect(message).identity[0]))
        cleared = (row.original_ciphertext, row.original_key_id, row.original_expires_at)
        assert cleared.count(None) in (0, 3)  # the three columns go together
        result.append(row.original_ciphertext is not None)
    return result


async def test_the_purge_clears_originals_due_at_or_before_now(
    db_session: AsyncSession, world: JobWorld, caplog: pytest.LogCaptureFixture
) -> None:
    messages = await _seed_originals(db_session, world, 3)
    boundary = messages[1].original_expires_at
    assert boundary is not None

    with caplog.at_level(logging.INFO):
        purged = await purge_expired_originals(_sessions(db_session), boundary, 10)

    # Due exactly at `now` is purged; one microsecond later is kept.
    assert purged == 2
    assert await _kept(db_session, messages) == [False, False, True]
    later = await purge_expired_originals(
        _sessions(db_session), boundary + timedelta(microseconds=1), 10
    )
    assert later == 0
    rows = await _kept(db_session, messages)
    assert rows == [False, False, True]
    # The messages stay: only their originals go.
    bodies = [(await stored(db_session, str(inspect(m).identity[0]))).body for m in messages]
    assert bodies == [MASK] * 3
    [summary, *_] = [r for r in caplog.records if r.getMessage() == "chat_originals_purged"]
    assert (summary.__dict__["purged"], summary.__dict__["failed"]) == (2, False)
    _assert_no_leak(caplog.records)


async def test_the_purge_works_in_batches_each_committed_on_its_own(
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    messages = await _seed_originals(db_session, world, 5)
    now = await ChatRepository(db_session).now()
    real = ChatRepository.clear_expired_originals
    calls: list[int] = []

    async def second_batch_fails(self: ChatRepository, before: Any, limit: int) -> int:
        calls.append(limit)
        if len(calls) == 2:
            await real(self, before, limit)  # cleared, then the batch fails: rolled back
            raise RuntimeError("probe failure with SELECT 'secret literal'")
        return await real(self, before, limit)

    monkeypatch.setattr(ChatRepository, "clear_expired_originals", second_batch_fails)
    with caplog.at_level(logging.INFO):
        purged = await purge_expired_originals(_sessions(db_session), now, 2)

    assert (purged, calls) == (2, [2, 2])
    assert await _kept(db_session, messages) == [False, False, True, True, True]
    [failed] = [r for r in caplog.records if r.getMessage() == "chat_originals_purge_failed"]
    assert failed.__dict__["error"] == "RuntimeError"
    [summary] = [r for r in caplog.records if r.getMessage() == "chat_originals_purged"]
    assert (summary.__dict__["purged"], summary.__dict__["batches"]) == (2, 1)
    assert summary.__dict__["failed"] is True
    assert "secret literal" not in "\n".join(JsonFormatter().format(r) for r in caplog.records)

    # The next run takes the rest, in batches.
    monkeypatch.setattr(ChatRepository, "clear_expired_originals", real)
    assert await purge_expired_originals(_sessions(db_session), now, 2) == 3
    assert await _kept(db_session, messages) == [False] * 5


# --- Helpers ---------------------------------------------------------------------------------


def _app(settings: Settings, session: AsyncSession) -> FastAPI:
    app = create_app(settings)
    limiter = InMemoryRateLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter

    async def session_override() -> AsyncIterator[AsyncSession]:
        yield session

    app.dependency_overrides[get_session] = session_override
    return app


@asynccontextmanager
async def _client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest.fixture
def sentry_transport(monkeypatch: pytest.MonkeyPatch) -> Iterator[MemoryTransport]:
    transport = MemoryTransport()
    real_init = sentry_sdk.init

    def init_with_memory_transport(*args: Any, **kwargs: Any) -> object:
        return real_init(*args, transport=transport, **kwargs)

    monkeypatch.setattr(sentry_sdk, "init", init_with_memory_transport)
    try:
        yield transport
    finally:
        sentry_sdk.get_client().close()
        sentry_sdk.get_global_scope().set_client(None)
