"""Repeat-offender flags (#72): a sender with CHAT_OFFENDER_THRESHOLD redacted messages, across
all jobs, within CHAT_OFFENDER_WINDOW_DAYS gets one open flag; staff list them."""

import logging
import uuid
from datetime import timedelta
from typing import Final

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import ChatOffenderFlag, JobMessage
from app.modules.chat.repository import ChatRepository
from app.observability import JsonFormatter
from app.redaction import MASK
from tests.conftest import make_settings
from tests.job_world import JobWorld, Party, build_world, make_job
from tests.test_chat_originals import _app, _client

REDACTED: Final = "the gate code is 4411, call 305-555-0199"
PLAIN: Final = "see you at 9"
FLAGS = "/v1/admin/chat/flags"
FLAG_KEYS = {"id", "user_id", "job_id", "window_count", "created_at", "updated_at", "resolved_at"}


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def messages_path(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/messages"


async def send(
    client: httpx.AsyncClient, job_id: uuid.UUID, party: Party, body: str = REDACTED
) -> httpx.Response:
    response = await client.post(messages_path(job_id), json={"body": body}, headers=party.headers)
    assert response.status_code == 201, response.text
    return response


async def flags(session: AsyncSession, user_id: uuid.UUID) -> list[ChatOffenderFlag]:
    statement = (
        select(ChatOffenderFlag)
        .where(ChatOffenderFlag.user_id == user_id)
        .order_by(ChatOffenderFlag.created_at)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


async def seed_redacted(
    session: AsyncSession, job_id: uuid.UUID, sender: Party, age: timedelta
) -> None:
    """A redacted message of `sender`, `age` old by the database clock."""
    now = await ChatRepository(session).now()
    session.add(
        JobMessage(
            job_id=job_id, sender_id=sender.id, body=MASK, redacted=True, created_at=now - age
        )
    )
    await session.flush()


async def test_the_third_redaction_within_the_window_opens_one_flag(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)
    other_job = await make_job(db_session, world)

    with caplog.at_level(logging.DEBUG):
        await send(db_client, job.id, world.customer)
        await send(db_client, job.id, world.customer, PLAIN)  # not redacted: never counts
        await send(db_client, other_job.id, world.customer)
        assert await flags(db_session, world.customer.id) == []  # two is not enough

        await send(db_client, other_job.id, world.customer)  # the third, in another job

    [flag] = await flags(db_session, world.customer.id)
    assert (flag.job_id, flag.window_count, flag.resolved_at) == (other_job.id, 3, None)
    [record] = [r for r in caplog.records if r.getMessage() == "chat_offender_flagged"]
    assert record.levelno == logging.ERROR
    assert record.__dict__["user_id"] == str(world.customer.id)
    assert record.__dict__["job_id"] == str(other_job.id)
    assert record.__dict__["flag_id"] == str(flag.id)
    assert record.__dict__["window_count"] == 3
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    for leak in ("gate code", "4411", "305-555-0199", MASK):
        assert leak not in logs
    # The other side sent nothing redacted: no flag.
    assert await flags(db_session, world.pro.id) == []


async def test_a_later_redaction_raises_the_open_flags_count(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)
    for _ in range(3):
        await send(db_client, job.id, world.pro)
    [opened] = await flags(db_session, world.pro.id)
    caplog.clear()

    with caplog.at_level(logging.DEBUG):
        await send(db_client, job.id, world.pro)
        await send(db_client, job.id, world.pro)

    [flag] = await flags(db_session, world.pro.id)
    assert (flag.id, flag.window_count) == (opened.id, 5)
    assert not [r for r in caplog.records if r.getMessage() == "chat_offender_flagged"]
    raised = [r for r in caplog.records if r.getMessage() == "chat_offender_flag_raised"]
    assert [r.__dict__["window_count"] for r in raised] == [4, 5]


async def test_redactions_outside_the_window_do_not_count(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    week = timedelta(days=7)
    await seed_redacted(db_session, job.id, world.customer, week + timedelta(minutes=1))
    await seed_redacted(db_session, job.id, world.customer, week + timedelta(days=30))

    await send(db_client, job.id, world.customer)
    await send(db_client, job.id, world.customer)
    assert await flags(db_session, world.customer.id) == []

    # One just inside the window counts.
    await seed_redacted(db_session, job.id, world.customer, week - timedelta(minutes=1))
    await send(db_client, job.id, world.customer, PLAIN)
    assert await flags(db_session, world.customer.id) == []  # an unredacted one never checks
    await send(db_client, job.id, world.customer)
    [flag] = await flags(db_session, world.customer.id)
    assert flag.window_count == 4


async def test_a_resolved_flag_lets_a_new_one_open(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    for _ in range(3):
        await send(db_client, job.id, world.customer)
    [first] = await flags(db_session, world.customer.id)
    first.resolved_at = await ChatRepository(db_session).now()
    await db_session.flush()

    await send(db_client, job.id, world.customer)

    resolved, opened = await flags(db_session, world.customer.id)
    assert resolved.id == first.id
    assert (opened.resolved_at, opened.window_count) == (None, 4)


async def test_the_threshold_and_window_come_from_the_settings(
    db_session: AsyncSession, world: JobWorld
) -> None:
    app = _app(make_settings(chat_offender_threshold=2, chat_offender_window_days=1), db_session)
    job = await make_job(db_session, world)
    await seed_redacted(db_session, job.id, world.pro, timedelta(days=1, minutes=1))
    async with _client(app) as client:
        await send(client, job.id, world.pro)
        assert await flags(db_session, world.pro.id) == []
        await send(client, job.id, world.pro)
    [flag] = await flags(db_session, world.pro.id)
    assert flag.window_count == 2


async def test_a_failed_check_never_fails_the_message(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)

    async def fail(self: ChatRepository, sender_id: uuid.UUID, window_seconds: int) -> int:
        raise RuntimeError("probe failure SELECT 'literal'")

    monkeypatch.setattr(ChatRepository, "redacted_since", fail)
    with caplog.at_level(logging.DEBUG):
        response = await send(db_client, job.id, world.customer)

    assert response.json()["warning"] == "contact_details_hidden"
    stored = await db_session.scalar(
        select(JobMessage).where(JobMessage.id == uuid.UUID(response.json()["id"]))
    )
    assert stored is not None
    [record] = [r for r in caplog.records if r.getMessage() == "chat_offender_check_failed"]
    assert (record.levelno, record.__dict__["error"]) == (logging.ERROR, "RuntimeError")
    assert "literal" not in JsonFormatter().format(record)


# --- The staff list --------------------------------------------------------------------------


async def test_staff_list_open_flags_newest_first_with_ids_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    for _ in range(3):
        await send(db_client, job.id, world.customer)
    for _ in range(3):
        await send(db_client, job.id, world.pro)
    customer_flag, pro_flag = (
        (await flags(db_session, world.customer.id))[0],
        (await flags(db_session, world.pro.id))[0],
    )
    pro_flag.resolved_at = await ChatRepository(db_session).now()
    await db_session.flush()

    for staff in (world.agent, world.admin):
        listed = await db_client.get(FLAGS, headers=staff.headers)
        assert listed.status_code == 200, listed.text
        [item] = [i for i in listed.json()["items"] if i["job_id"] == str(job.id)]
        assert set(item) == FLAG_KEYS
        assert (item["id"], item["user_id"], item["window_count"]) == (
            str(customer_flag.id),
            str(world.customer.id),
            3,
        )
        assert item["resolved_at"] is None
        for leak in ("gate code", "4411", "305-555-0199", MASK):
            assert leak not in listed.text

    resolved = await db_client.get(FLAGS, params={"open": "false"}, headers=world.admin.headers)
    [item] = [i for i in resolved.json()["items"] if i["job_id"] == str(job.id)]
    assert item["id"] == str(pro_flag.id)
    assert item["resolved_at"] is not None


async def test_the_flag_list_pages_with_a_cursor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    now = await ChatRepository(db_session).now()
    users = (world.customer, world.pro, world.other_customer)
    for index, party in enumerate(users):
        db_session.add(
            ChatOffenderFlag(
                user_id=party.id,
                job_id=job.id,
                window_count=3,
                created_at=now + timedelta(days=3650, seconds=index),
            )
        )
    await db_session.flush()

    first = await db_client.get(FLAGS, params={"limit": 2}, headers=world.agent.headers)
    second = await db_client.get(
        FLAGS,
        params={"limit": 2, "cursor": first.json()["next_cursor"]},
        headers=world.agent.headers,
    )

    assert [i["user_id"] for i in first.json()["items"]] == [
        str(world.other_customer.id),
        str(world.pro.id),
    ]
    assert second.json()["items"][0]["user_id"] == str(world.customer.id)
    bad = await db_client.get(FLAGS, params={"cursor": "x"}, headers=world.agent.headers)
    assert bad.status_code == 422


async def test_the_flag_list_is_staff_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    for party in (world.customer, world.pro, world.pro_without_profile):
        refused = await db_client.get(FLAGS, headers=party.headers)
        assert refused.status_code == 403
        assert refused.json()["error"]["code"] == "forbidden"
    assert (await db_client.get(FLAGS)).status_code == 401
