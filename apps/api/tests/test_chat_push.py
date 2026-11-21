"""The new-message push (#73 part 1, plan D14.4): after a message commits, one push to the other
side of the job's chat, unless they have it open (listed it or moved their read marker within
CHAT_PRESENCE_SECONDS) or a push for this job went out to them within CHAT_PUSH_COOLDOWN_SECONDS.
The push names the job's code only and opens the recipient's job screen. Presence fails toward
the push and never fails a message."""

import logging
import time
import uuid
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.chat.models import JobMessage
from app.modules.chat.notify import ChatNotifier, get_chat_notifier
from app.modules.chat.presence import (
    PushClaim,
    RedisChatPresence,
    get_chat_presence,
    present_key,
    pushed_key,
)
from app.modules.jobs.models import Job, JobStatus
from app.modules.notifications import catalog
from app.modules.notifications.preferences import KIND_GROUP, PreferenceGroup
from app.modules.requests.models import ServiceRequest
from app.queue import get_job_queue
from tests.conftest import InMemoryChatPresence
from tests.job_world import LEAKS, JobWorld, Party, build_world, make_job
from tests.test_requests_api import ENQUEUE_TIMEOUT, RecordingQueue

CLOSED = (JobStatus.CONFIRMED, JobStatus.PAID_OUT, JobStatus.REFUNDED, JobStatus.CANCELLED)
SECRET_TEXT = "the spare key is under the blue pot"
PHONE_TEXT = "call me at 305-555-0199"
TIMEOUT = 0.2  # a Redis call's budget in the presence tests


def messages_path(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/messages"


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


@pytest.fixture
def presence() -> InMemoryChatPresence:
    return InMemoryChatPresence(presence_seconds=15, cooldown_seconds=60)


@pytest.fixture
def queue(app: FastAPI, presence: InMemoryChatPresence) -> RecordingQueue:
    """The chat's notifier on the in-memory presence and a recording queue."""
    recorder = RecordingQueue()
    notifier = ChatNotifier(presence, recorder, enqueue_timeout_seconds=ENQUEUE_TIMEOUT)
    app.dependency_overrides[get_chat_notifier] = lambda: notifier
    return recorder


Push = tuple[str, str, str, str, dict[str, str], str]


def pushes(queue: RecordingQueue) -> list[Push]:
    """Each queued push: recipient, message id, title key, body key, params, deep link."""
    found: list[Push] = []
    for function, args in queue.jobs.values():
        if function == "send_push":
            user_id, message_id, title, body, params, link = args
            assert isinstance(params, dict)
            found.append((str(user_id), str(message_id), str(title), str(body), params, str(link)))
    return found


async def public_code(session: AsyncSession, job: Job) -> str:
    code = await session.scalar(
        select(ServiceRequest.public_code).where(ServiceRequest.id == job.request_id)
    )
    assert code is not None
    return code


async def send(
    client: httpx.AsyncClient, job: Job, sender: Party, body: str = "hello"
) -> uuid.UUID:
    response = await client.post(messages_path(job.id), json={"body": body}, headers=sender.headers)
    assert response.status_code == 201, response.text
    return uuid.UUID(response.json()["id"])


async def list_thread(client: httpx.AsyncClient, job: Job, reader: Party) -> None:
    response = await client.get(messages_path(job.id), headers=reader.headers)
    assert response.status_code == 200, response.text


async def read_up_to(
    client: httpx.AsyncClient, job: Job, reader: Party, message_id: uuid.UUID
) -> None:
    response = await client.post(
        f"{messages_path(job.id)}/read", json={"up_to": str(message_id)}, headers=reader.headers
    )
    assert response.status_code == 200, response.text


def skipped(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        str(record.__dict__["reason"])
        for record in caplog.records
        if record.message == "chat_push_skipped"
    ]


def assert_no_leak(caplog: pytest.LogCaptureFixture, *texts: str) -> None:
    rendered = caplog.text + "".join(str(record.__dict__) for record in caplog.records)
    for leak in (*LEAKS, *texts):
        assert leak not in rendered, leak


# --- Who gets it, what it says, where it opens ------------------------------------------------


@pytest.mark.parametrize("direction", ["customer_to_pro", "pro_to_customer"])
async def test_a_message_pushes_once_to_the_other_side_opening_its_chat(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    direction: str,
) -> None:
    job = await make_job(db_session, world)
    code = await public_code(db_session, job)
    to_pro = direction == "customer_to_pro"
    sender, recipient = (world.customer, world.pro) if to_pro else (world.pro, world.customer)

    message_id = await send(db_client, job, sender)

    # #73 P3: each side's own chat screen (the customer's needs the request id).
    link = f"/jobs/{job.id}/chat" if to_pro else f"/requests/{job.request_id}/job/chat"
    assert pushes(queue) == [
        (
            str(recipient.id),
            f"chat_message:{message_id}",
            "push.chat_message.title",
            "push.chat_message.body",
            {"public_code": code},
            link,
        )
    ]


async def test_the_push_names_the_job_never_the_text(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    presence: InMemoryChatPresence,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)
    code = await public_code(db_session, job)

    with caplog.at_level(logging.INFO):
        await send(db_client, job, world.customer, SECRET_TEXT)
        presence.now += presence.cooldown_seconds
        await send(db_client, job, world.customer, PHONE_TEXT)  # redacted when stored

    sent = pushes(queue)
    assert len(sent) == 2
    assert all(params == {"public_code": code} for _, _, _, _, params, _ in sent)
    queued = repr(queue.jobs)
    for text in (SECRET_TEXT, PHONE_TEXT, "305-555-0199", "blue pot"):
        assert text not in queued
    assert_no_leak(caplog, SECRET_TEXT, "305-555-0199", "blue pot")


def test_the_push_has_its_own_preference_group() -> None:
    """The messages group mutes the chat and nothing else (tests/test_push_tasks.py sends)."""
    assert KIND_GROUP["chat_message"] is PreferenceGroup.MESSAGES
    assert [kind for kind, group in KIND_GROUP.items() if group is PreferenceGroup.MESSAGES] == [
        "chat_message"
    ]
    assert catalog.CATALOG["en"]["push.chat_message.title"] == "New message"
    assert catalog.CATALOG["es"]["push.chat_message.title"] == "Nuevo mensaje"


# --- Presence: no push while the recipient has the chat open ----------------------------------


@pytest.mark.parametrize("how", ["list", "read"])
async def test_no_push_while_the_recipient_has_the_chat_open_and_one_once_they_leave(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    presence: InMemoryChatPresence,
    caplog: pytest.LogCaptureFixture,
    how: str,
) -> None:
    """Listing the thread or moving the read marker is having the chat open. It also ends the
    cooldown: the first message once they left (presence over, cooldown not) pushes."""
    job = await make_job(db_session, world)
    first = await send(db_client, job, world.customer)  # the pro is away: a push

    if how == "list":
        await list_thread(db_client, job, world.pro)
    else:
        await read_up_to(db_client, job, world.pro, first)
    with caplog.at_level(logging.INFO):
        await send(db_client, job, world.customer)  # the pro has the chat open
    assert skipped(caplog) == ["present"]
    presence.now += presence.presence_seconds  # they left; the cooldown would still run
    third = await send(db_client, job, world.customer)

    assert [push[1] for push in pushes(queue)] == [f"chat_message:{first}", f"chat_message:{third}"]
    assert presence.presence_seconds < presence.cooldown_seconds


async def test_the_senders_own_presence_never_silences_the_other_side(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    job = await make_job(db_session, world)
    await list_thread(db_client, job, world.customer)

    message_id = await send(db_client, job, world.customer)

    assert [(push[0], push[1]) for push in pushes(queue)] == [
        (str(world.pro.id), f"chat_message:{message_id}")
    ]


async def test_presence_is_per_job(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    """The pro reading one job's chat still hears about another job's message."""
    reading = await make_job(db_session, world)
    other = await make_job(db_session, world)
    await list_thread(db_client, reading, world.pro)

    message_id = await send(db_client, other, world.customer)

    assert [push[1] for push in pushes(queue)] == [f"chat_message:{message_id}"]


async def test_strangers_and_staff_never_count_as_present(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    presence: InMemoryChatPresence,
) -> None:
    job = await make_job(db_session, world)

    stranger = await db_client.get(messages_path(job.id), headers=world.other_pro.headers)
    staff = await db_client.get(f"/v1/admin/jobs/{job.id}/messages", headers=world.agent.headers)

    assert (stranger.status_code, staff.status_code) == (404, 200)
    assert presence.present == {}


# --- Cooldown: a burst is one push --------------------------------------------------------------


async def test_a_burst_pushes_once_per_cooldown(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    presence: InMemoryChatPresence,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)

    with caplog.at_level(logging.INFO):
        first = await send(db_client, job, world.pro)
        await send(db_client, job, world.pro)
        await send(db_client, job, world.pro)
    presence.now += presence.cooldown_seconds
    later = await send(db_client, job, world.pro)

    assert [push[1] for push in pushes(queue)] == [f"chat_message:{first}", f"chat_message:{later}"]
    assert skipped(caplog) == ["cooldown", "cooldown"]


async def test_each_recipient_and_job_has_its_own_cooldown(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    job = await make_job(db_session, world)
    other = await make_job(db_session, world)

    to_pro = await send(db_client, job, world.customer)
    to_customer = await send(db_client, job, world.pro)
    other_job = await send(db_client, other, world.customer)

    assert {push[1] for push in pushes(queue)} == {
        f"chat_message:{to_pro}",
        f"chat_message:{to_customer}",
        f"chat_message:{other_job}",
    }


# --- Nothing pushes without a stored message; nothing fails a stored one ---------------------


@pytest.mark.parametrize("status", CLOSED)
async def test_a_closed_chat_pushes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    status: JobStatus,
) -> None:
    job = await make_job(db_session, world, status)

    response = await db_client.post(
        messages_path(job.id), json={"body": "hi"}, headers=world.customer.headers
    )

    assert response.status_code == 409
    assert pushes(queue) == []


async def test_a_stranger_or_a_blank_message_pushes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
) -> None:
    job = await make_job(db_session, world)

    stranger = await db_client.post(
        messages_path(job.id), json={"body": "hi"}, headers=world.other_customer.headers
    )
    blank = await db_client.post(
        messages_path(job.id), json={"body": chr(0x200B)}, headers=world.customer.headers
    )

    assert (stranger.status_code, blank.status_code) == (404, 422)
    assert pushes(queue) == []


async def test_a_queue_failure_never_fails_the_message(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world)
    queue.failure = RedisError("down")

    with caplog.at_level(logging.INFO):
        message_id = await send(db_client, job, world.customer, SECRET_TEXT)

    stored = await db_session.scalar(select(JobMessage).where(JobMessage.id == message_id))
    assert stored is not None
    assert [record.message for record in caplog.records].count("push_enqueue_failed") == 1
    assert_no_leak(caplog, SECRET_TEXT)


# --- The Redis presence itself ----------------------------------------------------------------


@pytest.fixture
async def redis_client() -> AsyncIterator[Redis]:
    """The real Redis of REDIS_URL, under a key prefix of this test's own (deleted after)."""
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def prefix(redis_client: Redis) -> AsyncIterator[str]:
    value = f"chat-test-{uuid.uuid4().hex}"
    yield value
    keys = [key async for key in redis_client.scan_iter(match=f"{value}:*")]
    if keys:
        await redis_client.delete(*keys)


def redis_presence(redis: Redis, prefix: str) -> RedisChatPresence:
    return RedisChatPresence(
        redis, presence_seconds=15, cooldown_seconds=60, timeout_seconds=TIMEOUT, prefix=prefix
    )


async def test_the_redis_presence_keeps_the_rules_with_ttls(
    redis_client: Redis, prefix: str
) -> None:
    presence = redis_presence(redis_client, prefix)
    job_id, user_id, other_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    present, pushed = present_key(prefix, job_id, user_id), pushed_key(prefix, job_id, user_id)

    assert await presence.claim_push(job_id, user_id) is PushClaim.PUSH
    assert 0 < await redis_client.ttl(pushed) <= 60
    assert await presence.claim_push(job_id, user_id) is PushClaim.COOLDOWN
    assert await presence.claim_push(job_id, other_id) is PushClaim.PUSH  # per participant

    await presence.seen(job_id, user_id)
    assert 0 < await redis_client.ttl(present) <= 15
    assert await redis_client.exists(pushed) == 0  # the cooldown ended with the listing
    assert await presence.claim_push(job_id, user_id) is PushClaim.PRESENT
    assert await redis_client.exists(pushed) == 0  # present takes no cooldown

    await redis_client.delete(present)  # the presence ran out
    assert await presence.claim_push(job_id, user_id) is PushClaim.PUSH


@pytest.mark.parametrize("where", ["hung", "refused"])
async def test_a_redis_that_cannot_tell_means_push_and_never_raises(
    silent_redis_url: str, caplog: pytest.LogCaptureFixture, where: str
) -> None:
    url = silent_redis_url if where == "hung" else "redis://127.0.0.1:1/0"
    client = Redis.from_url(url)
    presence = RedisChatPresence(
        client, presence_seconds=15, cooldown_seconds=60, timeout_seconds=TIMEOUT
    )
    job_id, user_id = uuid.uuid4(), uuid.uuid4()
    try:
        started = time.monotonic()
        with caplog.at_level(logging.WARNING):
            await presence.seen(job_id, user_id)
            claim = await presence.claim_push(job_id, user_id)
        elapsed = time.monotonic() - started
    finally:
        await client.aclose()

    assert claim is PushClaim.PUSH
    assert elapsed < 2 * TIMEOUT + 1.0
    found = [record for record in caplog.records if record.message == "chat_presence_unavailable"]
    assert [record.__dict__["step"] for record in found] == ["seen", "claim_push"]
    for record in found:
        assert (record.__dict__["job_id"], record.__dict__["user_id"]) == (
            str(job_id),
            str(user_id),
        )
    assert "127.0.0.1" not in caplog.text


async def test_the_app_wires_the_redis_presence_and_the_queue(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    redis_client: Redis,
    prefix: str,
) -> None:
    """Nothing of the chat's replaced but Redis itself: get_chat_notifier builds the notifier
    from get_chat_presence and get_job_queue."""
    recorder = RecordingQueue()
    app.dependency_overrides.pop(get_chat_notifier)
    app.dependency_overrides[get_job_queue] = lambda: recorder
    app.dependency_overrides[get_chat_presence] = lambda: redis_presence(redis_client, prefix)
    job = await make_job(db_session, world)

    first = await send(db_client, job, world.customer)
    await send(db_client, job, world.customer)  # cooled down
    await list_thread(db_client, job, world.pro)
    await send(db_client, job, world.customer)  # present

    assert [push[1] for push in pushes(recorder)] == [f"chat_message:{first}"]
    assert await redis_client.exists(present_key(prefix, job.id, world.pro.id)) == 1


async def test_a_hung_presence_still_sends_the_message_and_its_push(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    silent_redis_url: str,
) -> None:
    recorder = RecordingQueue()
    hung = Redis.from_url(silent_redis_url)
    hung_presence = RedisChatPresence(
        hung, presence_seconds=15, cooldown_seconds=60, timeout_seconds=TIMEOUT
    )
    notifier = ChatNotifier(hung_presence, recorder, enqueue_timeout_seconds=ENQUEUE_TIMEOUT)
    app.dependency_overrides[get_chat_notifier] = lambda: notifier
    job = await make_job(db_session, world)
    try:
        await list_thread(db_client, job, world.pro)
        message_id = await send(db_client, job, world.customer)
    finally:
        await hung.aclose()

    assert [push[1] for push in pushes(recorder)] == [f"chat_message:{message_id}"]
