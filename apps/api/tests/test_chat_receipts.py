"""Chat read receipts, API side (#331): sent, delivered, seen on the caller's own messages.

Delivered moves when the recipient lists the thread (job_chat_deliveries), seen when they mark
it read (job_chat_reads); staff see the receipts and move nothing; a page with its receipts is
one query."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import JobChatDelivery, JobChatRead, JobMessage
from app.modules.jobs.models import Job
from tests.job_world import JobWorld, Party, build_world, make_job
from tests.test_job_chat_api import T0, messages_path, seed, staff_path


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def listed(
    client: httpx.AsyncClient, job: Job, party: Party, **params: str | int
) -> dict[str, Any]:
    response = await client.get(messages_path(job.id), params=params, headers=party.headers)
    assert response.status_code == 200, response.text
    page: dict[str, Any] = response.json()
    return page


async def receipts(client: httpx.AsyncClient, job: Job, party: Party) -> dict[str, str | None]:
    """The receipts the party sees, by body."""
    page = await listed(client, job, party)
    return {item["body"]: item["receipt"] for item in page["items"]}


async def mark_read(client: httpx.AsyncClient, job: Job, party: Party, message: JobMessage) -> None:
    response = await client.post(
        f"{messages_path(job.id)}/read", json={"up_to": str(message.id)}, headers=party.headers
    )
    assert response.status_code == 200, response.text


async def delivery(session: AsyncSession, job: Job, party: Party) -> JobChatDelivery | None:
    statement = (
        select(JobChatDelivery)
        .where(JobChatDelivery.job_id == job.id, JobChatDelivery.user_id == party.id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one_or_none()


async def positions(
    session: AsyncSession, job: Job, party: Party
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    """(delivered, read) message ids of the party's markers, None for one never written."""
    row = await delivery(session, job, party)
    read = await session.scalar(
        select(JobChatRead.last_read_message_id).where(
            JobChatRead.job_id == job.id, JobChatRead.user_id == party.id
        )
    )
    return (row.last_delivered_message_id if row else None), read


async def marker_rows(session: AsyncSession) -> int:
    """Read and delivered marker rows, all jobs."""
    reads = await session.scalar(select(func.count()).select_from(JobChatRead))
    deliveries = await session.scalar(select(func.count()).select_from(JobChatDelivery))
    return int(reads or 0) + int(deliveries or 0)


async def test_sent_then_delivered_then_seen(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)

    sent = await db_client.post(
        messages_path(job.id), json={"body": "on my way"}, headers=world.pro.headers
    )
    assert sent.status_code == 201, sent.text
    assert sent.json()["receipt"] == "sent"
    assert await receipts(db_client, job, world.pro) == {"on my way": "sent"}

    # The customer's app lists the thread: delivered.
    assert await receipts(db_client, job, world.customer) == {"on my way": None}
    assert await receipts(db_client, job, world.pro) == {"on my way": "delivered"}

    # The customer marks it read: seen.
    [message] = (await db_session.scalars(select(JobMessage))).all()
    await mark_read(db_client, job, world.customer, message)
    assert await receipts(db_client, job, world.pro) == {"on my way": "seen"}


async def test_my_own_listing_never_delivers_my_own_messages(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await seed(db_session, job, world.customer, "mine", at=T0)

    for _ in range(2):
        assert await receipts(db_client, job, world.customer) == {"mine": "sent"}
    assert await marker_rows(db_session) == 0

    # With a message of the pro before it, the customer's marker stops at the pro's message.
    theirs = await seed(db_session, job, world.pro, "theirs", at=T0 - timedelta(minutes=1))
    await listed(db_client, job, world.customer)
    assert await positions(db_session, job, world.customer) == (theirs.id, None)
    assert await receipts(db_client, job, world.customer) == {"mine": "sent", "theirs": None}
    assert await positions(db_session, job, world.pro) == (None, None)


async def test_listing_without_news_writes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await seed(db_session, job, world.pro, "hi", at=T0)
    await listed(db_client, job, world.customer)
    row = await delivery(db_session, job, world.customer)
    assert row is not None
    updated_at = row.updated_at

    with counted_statements(db_session) as statements:
        await listed(db_client, job, world.customer)

    assert not [s for s in statements if s.lstrip().upper().startswith(("INSERT", "UPDATE"))]
    after = await delivery(db_session, job, world.customer)
    assert after is not None
    assert after.updated_at == updated_at


async def test_markers_never_move_back(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.pro, "1", at=T0)
    second = await seed(db_session, job, world.pro, "2", at=T0 + timedelta(minutes=1))
    third = await seed(db_session, job, world.pro, "3", at=T0 + timedelta(minutes=2))

    # Listing delivers the newest; an older page, and reading an older message, keep it.
    page = await listed(db_client, job, world.customer, limit=1)
    assert await positions(db_session, job, world.customer) == (third.id, None)
    await listed(db_client, job, world.customer, limit=1, cursor=page["next_cursor"])
    await mark_read(db_client, job, world.customer, first)
    assert await positions(db_session, job, world.customer) == (third.id, first.id)
    await mark_read(db_client, job, world.customer, third)
    await mark_read(db_client, job, world.customer, second)
    assert await positions(db_session, job, world.customer) == (third.id, third.id)
    await listed(db_client, job, world.customer, limit=1, cursor=page["next_cursor"])
    assert await positions(db_session, job, world.customer) == (third.id, third.id)
    assert await receipts(db_client, job, world.pro) == {"1": "seen", "2": "seen", "3": "seen"}


async def test_an_older_page_delivers_when_the_first_had_nothing_from_the_other_side(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    theirs = await seed(db_session, job, world.pro, "theirs", at=T0)
    await seed(db_session, job, world.customer, "mine", at=T0 + timedelta(minutes=1))

    page = await listed(db_client, job, world.customer, limit=1)
    assert await positions(db_session, job, world.customer) == (None, None)
    await listed(db_client, job, world.customer, limit=1, cursor=page["next_cursor"])

    assert await positions(db_session, job, world.customer) == (theirs.id, None)


async def test_reading_implies_delivered(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.customer, "1", at=T0)
    await seed(db_session, job, world.customer, "2", at=T0 + timedelta(minutes=1))

    # The pro never listed: reading alone makes it seen, with no delivered marker written.
    await mark_read(db_client, job, world.pro, first)

    assert await positions(db_session, job, world.pro) == (None, first.id)
    assert await receipts(db_client, job, world.customer) == {"1": "seen", "2": "sent"}


async def test_ties_on_created_at_follow_the_id(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    low, high = sorted(uuid.uuid4() for _ in range(2))
    low_message = await seed(db_session, job, world.pro, "low", at=T0, message_id=low)
    await seed(db_session, job, world.pro, "high", at=T0, message_id=high)

    await mark_read(db_client, job, world.customer, low_message)
    assert await receipts(db_client, job, world.pro) == {"low": "seen", "high": "sent"}

    await listed(db_client, job, world.customer)
    assert await positions(db_session, job, world.customer) == (high, low)
    assert await receipts(db_client, job, world.pro) == {"low": "seen", "high": "delivered"}


async def test_the_other_sides_messages_carry_no_receipt(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.pro, "from the pro", at=T0)
    await seed(db_session, job, world.customer, "from the customer", at=T0 + timedelta(minutes=1))
    await mark_read(db_client, job, world.customer, first)
    await listed(db_client, job, world.pro)

    assert await receipts(db_client, job, world.customer) == {
        "from the pro": None,
        "from the customer": "delivered",
    }
    assert await receipts(db_client, job, world.pro) == {
        "from the pro": "seen",
        "from the customer": None,
    }


async def test_a_listing_row_keeps_the_unread_count(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # A row with a delivered marker only (read NULL) counts everything from the other side.
    job = await make_job(db_session, world)
    await seed(db_session, job, world.pro, "1", at=T0)
    newest = await seed(db_session, job, world.pro, "2", at=T0 + timedelta(minutes=1))

    await listed(db_client, job, world.customer)

    assert await positions(db_session, job, world.customer) == (newest.id, None)
    assert (await listed(db_client, job, world.customer))["unread_count"] == 2
    view = await db_client.get(f"/v1/requests/{job.request_id}/job", headers=world.customer.headers)
    assert view.status_code == 200, view.text
    assert view.json()["unread_messages"] == 2


async def test_staff_see_receipts_and_move_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.customer, "from the customer", at=T0)
    await seed(db_session, job, world.pro, "from the pro", at=T0 + timedelta(minutes=1))
    await mark_read(db_client, job, world.pro, first)
    before = await marker_rows(db_session)

    for staff in (world.agent, world.admin):
        response = await db_client.get(staff_path(job.id), headers=staff.headers)
        assert response.status_code == 200, response.text
        assert {i["body"]: i["receipt"] for i in response.json()["items"]} == {
            "from the customer": "seen",
            "from the pro": "sent",
        }

    assert await marker_rows(db_session) == before
    assert await positions(db_session, job, world.pro) == (None, first.id)
    assert await positions(db_session, job, world.customer) == (None, None)


# Cost


@contextmanager
def counted_statements(session: AsyncSession) -> Iterator[list[str]]:
    statements: list[str] = []
    engine = session.get_bind().engine

    def record(*args: Any) -> None:
        statements.append(args[2])

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


async def test_a_page_with_its_receipts_is_one_query(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    # The pro's messages, which the customer has received already: no marker write.
    small = [await seed(db_session, job, world.pro, "p0", at=T0)]
    await listed(db_client, job, world.customer)

    async def page_statements() -> list[str]:
        db_session.expunge_all()  # nothing served from the identity map
        with counted_statements(db_session) as statements:
            page = await listed(db_client, job, world.pro)
        assert {item["receipt"] for item in page["items"]} == {"delivered"}
        return statements

    one = await page_statements()
    for n in range(1, 6):
        small.append(await seed(db_session, job, world.pro, f"p{n}", at=T0 - timedelta(minutes=n)))
    six = await page_statements()

    assert len(one) == len(six)
    # The page (bodies and receipts): one statement, joined to the recipient's markers.
    pages = [s for s in six if "job_messages.body" in s]
    assert len(pages) == 1
    assert "LEFT OUTER JOIN job_chat_reads" in pages[0]
    assert "LEFT OUTER JOIN job_chat_deliveries" in pages[0]
    assert not [s for s in six if s.lstrip().upper().startswith(("INSERT", "UPDATE"))]
