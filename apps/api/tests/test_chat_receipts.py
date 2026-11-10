"""Chat read receipts, API side (#331): sent, delivered, seen on the caller's own messages.

A message turns delivered when a page the recipient lists returns it (job_message_deliveries,
per message: never one the page skipped), seen when they mark it read (job_chat_reads); staff
see the receipts and move nothing; a page with its receipts is one query. Every denial on the
participants' endpoints does the same reads (Vault round 1, B2)."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.chat.models import JobChatRead, JobMessage, JobMessageDelivery
from app.modules.chat.service import _encode_cursor
from app.modules.jobs.models import Job
from tests.job_world import JobWorld, Party, build_world, make_job
from tests.test_job_chat_api import NOT_FOUND, T0, _call, messages_path, seed, staff_path


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


async def positions(
    session: AsyncSession, job: Job, party: Party
) -> tuple[set[uuid.UUID], uuid.UUID | None]:
    """(the ids of the job's messages delivered to the party, their read marker's message id or
    None when never written)."""
    delivered = await session.scalars(
        select(JobMessageDelivery.message_id)
        .join(JobMessage, JobMessage.id == JobMessageDelivery.message_id)
        .where(JobMessage.job_id == job.id, JobMessageDelivery.user_id == party.id)
    )
    read = await session.scalar(
        select(JobChatRead.last_read_message_id).where(
            JobChatRead.job_id == job.id, JobChatRead.user_id == party.id
        )
    )
    return set(delivered), read


async def marker_rows(session: AsyncSession) -> int:
    """Read marker and delivery rows, all jobs."""
    reads = await session.scalar(select(func.count()).select_from(JobChatRead))
    deliveries = await session.scalar(select(func.count()).select_from(JobMessageDelivery))
    return int(reads or 0) + int(deliveries or 0)


def writes(statements: list[str]) -> list[str]:
    return [s for s in statements if s.lstrip().upper().startswith(("INSERT", "UPDATE"))]


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

    # With a message of the pro before it, only the pro's message is delivered to the customer.
    theirs = await seed(db_session, job, world.pro, "theirs", at=T0 - timedelta(minutes=1))
    await listed(db_client, job, world.customer)
    assert await positions(db_session, job, world.customer) == ({theirs.id}, None)
    assert await receipts(db_client, job, world.customer) == {"mine": "sent", "theirs": None}
    assert await positions(db_session, job, world.pro) == (set(), None)


async def test_listing_without_news_writes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await seed(db_session, job, world.pro, "hi", at=T0)
    await listed(db_client, job, world.customer)
    before = await positions(db_session, job, world.customer)
    assert len(before[0]) == 1

    # The same page again (a retry, a poll): nothing to deliver, no write.
    with counted_statements(db_session) as statements:
        await listed(db_client, job, world.customer)

    assert not writes(statements)
    assert await positions(db_session, job, world.customer) == before
    assert await marker_rows(db_session) == 1


async def test_deliveries_stay_and_the_read_marker_never_moves_back(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.pro, "1", at=T0)
    second = await seed(db_session, job, world.pro, "2", at=T0 + timedelta(minutes=1))
    third = await seed(db_session, job, world.pro, "3", at=T0 + timedelta(minutes=2))

    # Each page delivers what it returns; reading an older message keeps the deliveries.
    page = await listed(db_client, job, world.customer, limit=1)
    assert await positions(db_session, job, world.customer) == ({third.id}, None)
    await listed(db_client, job, world.customer, limit=1, cursor=page["next_cursor"])
    await mark_read(db_client, job, world.customer, first)
    both = {second.id, third.id}
    assert await positions(db_session, job, world.customer) == (both, first.id)
    await mark_read(db_client, job, world.customer, third)
    await mark_read(db_client, job, world.customer, second)
    assert await positions(db_session, job, world.customer) == (both, third.id)
    await listed(db_client, job, world.customer, limit=1, cursor=page["next_cursor"])
    assert await positions(db_session, job, world.customer) == (both, third.id)
    assert await receipts(db_client, job, world.pro) == {"1": "seen", "2": "seen", "3": "seen"}


async def test_an_older_page_delivers_when_the_first_had_nothing_from_the_other_side(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    theirs = await seed(db_session, job, world.pro, "theirs", at=T0)
    await seed(db_session, job, world.customer, "mine", at=T0 + timedelta(minutes=1))

    page = await listed(db_client, job, world.customer, limit=1)
    assert await positions(db_session, job, world.customer) == (set(), None)
    await listed(db_client, job, world.customer, limit=1, cursor=page["next_cursor"])

    assert await positions(db_session, job, world.customer) == ({theirs.id}, None)


async def test_reading_implies_delivered(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    first = await seed(db_session, job, world.customer, "1", at=T0)
    await seed(db_session, job, world.customer, "2", at=T0 + timedelta(minutes=1))

    # The pro never listed: reading alone makes it seen, with no delivery written.
    await mark_read(db_client, job, world.pro, first)

    assert await positions(db_session, job, world.pro) == (set(), first.id)
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

    # The listing delivers only the message the read marker does not cover.
    await listed(db_client, job, world.customer)
    assert await positions(db_session, job, world.customer) == ({high}, low)
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
    # Deliveries without a read marker: everything from the other side is unread.
    job = await make_job(db_session, world)
    oldest = await seed(db_session, job, world.pro, "1", at=T0)
    newest = await seed(db_session, job, world.pro, "2", at=T0 + timedelta(minutes=1))

    await listed(db_client, job, world.customer)

    assert await positions(db_session, job, world.customer) == ({oldest.id, newest.id}, None)
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
    assert await positions(db_session, job, world.pro) == (set(), first.id)
    assert await positions(db_session, job, world.customer) == (set(), None)


# Pagination (Vault round 1, B1): a page delivers what it returns, never what it skipped


@pytest.mark.parametrize("use_cursor", [False, True], ids=["first-page", "older-cursor-page"])
async def test_unreturned_messages_are_not_delivered(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, use_cursor: bool
) -> None:
    # The Vault's probe: the pro sends three; the customer's app lists one message only.
    job = await make_job(db_session, world)
    old = await seed(db_session, job, world.pro, "never-returned", at=T0)
    middle = await seed(db_session, job, world.pro, "middle", at=T0 + timedelta(seconds=1))
    newest = await seed(db_session, job, world.pro, "newest", at=T0 + timedelta(seconds=2))
    params: dict[str, str | int] = {"limit": 1}
    if use_cursor:
        params["cursor"] = _encode_cursor(newest)

    page = await listed(db_client, job, world.customer, **params)

    expected = middle if use_cursor else newest
    assert [item["id"] for item in page["items"]] == [str(expected.id)]
    assert await positions(db_session, job, world.customer) == ({expected.id}, None)
    actual = await receipts(db_client, job, world.pro)
    assert actual[expected.body] == "delivered"
    if use_cursor:
        assert actual["newest"] == "sent"
    assert actual[old.body] == "sent", f"{old.body} was never served, but sender sees {actual}"


async def test_the_gap_closes_as_the_older_pages_are_returned(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # Oldest first: the pro's A, the customer's own message, the pro's B and C. Pages of two.
    job = await make_job(db_session, world)
    a = await seed(db_session, job, world.pro, "A", at=T0)
    await seed(db_session, job, world.customer, "mine", at=T0 + timedelta(seconds=1))
    b = await seed(db_session, job, world.pro, "B", at=T0 + timedelta(seconds=2))
    c = await seed(db_session, job, world.pro, "C", at=T0 + timedelta(seconds=3))

    first = await listed(db_client, job, world.customer, limit=2)
    assert [item["body"] for item in first["items"]] == ["C", "B"]
    assert await positions(db_session, job, world.customer) == ({b.id, c.id}, None)
    assert await receipts(db_client, job, world.pro) == {
        "A": "sent",
        "mine": None,
        "B": "delivered",
        "C": "delivered",
    }

    # The older page closes the gap: all the pro's messages are delivered, the customer's own
    # is not theirs to receive.
    second = await listed(db_client, job, world.customer, limit=2, cursor=first["next_cursor"])
    assert [item["body"] for item in second["items"]] == ["mine", "A"]
    everything = ({a.id, b.id, c.id}, None)
    assert await positions(db_session, job, world.customer) == everything
    assert set((await receipts(db_client, job, world.pro)).values()) == {"delivered", None}

    # Retries of either page, or both pages again: nothing more to write.
    for cursor in (None, first["next_cursor"]):
        params: dict[str, str | int] = {"limit": 2}
        if cursor is not None:
            params["cursor"] = cursor
        with counted_statements(db_session) as statements:
            await listed(db_client, job, world.customer, **params)
        assert not writes(statements)
    assert await positions(db_session, job, world.customer) == everything


async def test_a_page_that_ends_inside_a_tie_delivers_only_its_side(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    low, high = sorted(uuid.uuid4() for _ in range(2))
    await seed(db_session, job, world.pro, "low", at=T0, message_id=low)
    await seed(db_session, job, world.pro, "high", at=T0, message_id=high)

    first = await listed(db_client, job, world.customer, limit=1)

    assert [item["body"] for item in first["items"]] == ["high"]
    assert await receipts(db_client, job, world.pro) == {"low": "sent", "high": "delivered"}
    await listed(db_client, job, world.customer, limit=1, cursor=first["next_cursor"])
    assert await positions(db_session, job, world.customer) == ({low, high}, None)


# Denials (Vault round 1, B2): a job of others costs what an unknown id costs

# The caller's account (authentication), then the job scoped to them: the same reads for every
# denial, whoever asks and whatever the id.
DENIAL_SELECTS = 2


@pytest.mark.parametrize("endpoint", ["list", "send", "read"])
@pytest.mark.parametrize("caller", ["other_customer", "other_pro", "pro_without_profile"])
async def test_every_denial_does_the_same_reads(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caller: str,
    endpoint: str,
) -> None:
    job = await make_job(db_session, world)
    message = await seed(db_session, job, world.pro, "secret", at=T0)
    headers = getattr(world, caller).headers
    counts: dict[str, list[int]] = {"existing": [], "unknown": []}

    # Interleaved, twice each: a warm-up changes nothing.
    for kind in ("existing", "unknown", "unknown", "existing"):
        target = job.id if kind == "existing" else uuid.uuid4()
        db_session.expunge_all()  # nothing served from the identity map
        with counted_statements(db_session) as statements:
            response = await _call(db_client, endpoint, target, message.id, headers)
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
        assert not writes(statements)
        counts[kind].append(sum(s.lstrip().upper().startswith("SELECT") for s in statements))

    assert counts == {"existing": [DENIAL_SELECTS] * 2, "unknown": [DENIAL_SELECTS] * 2}
    assert await marker_rows(db_session) == 0


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
    # The pro's messages, which the customer has received already: no write on the pro's page.
    await seed(db_session, job, world.pro, "p0", at=T0)
    await listed(db_client, job, world.customer)

    async def page_statements() -> list[str]:
        db_session.expunge_all()  # nothing served from the identity map
        with counted_statements(db_session) as statements:
            page = await listed(db_client, job, world.pro)
        assert {item["receipt"] for item in page["items"]} == {"delivered"}
        return statements

    one = await page_statements()
    for n in range(1, 6):
        await seed(db_session, job, world.pro, f"p{n}", at=T0 - timedelta(minutes=n))
    await listed(db_client, job, world.customer)
    six = await page_statements()

    assert len(one) == len(six)
    # The page (bodies and receipts): one statement, joined to the recipient's read marker and
    # to each message's delivery.
    pages = [s for s in six if "job_messages.body" in s]
    assert len(pages) == 1
    assert "LEFT OUTER JOIN job_chat_reads" in pages[0]
    assert "LEFT OUTER JOIN job_message_deliveries" in pages[0]
    assert not writes(six)


async def test_a_page_delivers_in_one_statement_whatever_its_size(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    inserts = []
    for batch, count in enumerate((1, 5)):
        for n in range(count):
            at = T0 + timedelta(minutes=10 * batch + n)
            await seed(db_session, job, world.pro, f"{batch}-{n}", at=at)
        db_session.expunge_all()
        with counted_statements(db_session) as statements:
            await listed(db_client, job, world.customer)
        inserts.append(writes(statements))

    # The second page holds the first message, delivered already, and the five new ones.
    assert [len(batch) for batch in inserts] == [1, 1]
    assert all("INSERT INTO job_message_deliveries" in batch[0] for batch in inserts)
    assert len((await positions(db_session, job, world.customer))[0]) == 6
