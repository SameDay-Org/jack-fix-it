"""A pro's earnings (#70): each status from our own rows, the summary adding up to the items,
the pro's own jobs only, stable pages, and nothing of the customer or of Stripe in the answer."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.payments.models import Transfer, TransferStatus
from app.rate_limit import get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.job_world import (
    CUSTOMER_EMAIL,
    CUSTOMER_FIRST,
    CUSTOMER_LAST,
    CUSTOMER_PHONE,
    FEE,
    LINE1,
    PRICE,
    JobWorld,
    Pro,
    build_world,
    make_job,
)
from tests.test_transfers import add_payment

PATH: Final = "/v1/pros/me/earnings"
NO_STORE: Final = "no-store"
T0: Final = datetime(2031, 5, 1, 12, 0, tzinfo=UTC)
CONFIRM_HOURS: Final = 48  # JOB_AUTO_CONFIRM_AFTER_HOURS's default
STRIPE_TRANSFER: Final = "tr_probe70secret"
STRIPE_REVERSED: Final = "tr_probe70reversed"


@pytest.fixture
def settings() -> Settings:
    return make_settings(earnings_read_limit=1_000)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    # Committed: the earnings end their transaction with a rollback.
    built = await build_world(db_session)
    await db_session.commit()
    return built


async def earning_job(
    session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
    completed: datetime | None,
    payout: int,
    *,
    pro: Pro | None = None,
    transfer: TransferStatus | None = None,
    paid_at: datetime | None = None,
) -> uuid.UUID:
    """A job of `pro` (the world's by default) whose pro receives `payout`, and its transfer row
    and paid_out event when given."""
    job = await make_job(session, world, status, pro=pro, completed_at=completed)
    await session.execute(
        update(Job)
        .where(Job.id == job.id)
        .values(pro_payout_cents=payout, platform_fee_cents=PRICE - payout)
    )
    if transfer is not None:
        payment = await add_payment(
            session, world, job, pro_payout_cents=payout, platform_fee_cents=PRICE - payout
        )
        session.add(
            Transfer(
                job_id=job.id,
                payment_id=payment.id,
                pro_id=job.pro_id,
                amount_cents=payout,
                currency="usd",
                idempotency_key=f"transfer:{job.id}",
                status=transfer,
                attempts=1,
                last_error_code="balance_insufficient"
                if transfer is TransferStatus.FAILED
                else None,
                # Unique per row; the prefixes are what the leak test looks for.
                stripe_transfer_id=(
                    f"{STRIPE_TRANSFER}{job.id.hex[:8]}"
                    if transfer is TransferStatus.CREATED
                    else f"{STRIPE_REVERSED}{job.id.hex[:8]}"
                    if transfer is TransferStatus.REVERSED
                    else None
                ),
            )
        )
    if paid_at is not None:
        session.add(
            JobEvent(
                job_id=job.id,
                type="status_changed",
                from_status=JobStatus.CONFIRMED,
                to_status=JobStatus.PAID_OUT,
                created_at=paid_at,
            )
        )
    await session.flush()
    return job.id


async def seed(session: AsyncSession, world: JobWorld) -> dict[str, uuid.UUID]:
    """One job per status (distinct payouts), the ones that earn nothing, and another pro's."""
    ids = {
        "awaiting": await earning_job(session, world, JobStatus.COMPLETED, T0, 1_001),
        "confirmed_no_row": await earning_job(
            session, world, JobStatus.CONFIRMED, T0 - timedelta(days=1), 2_002
        ),
        "failed_retrying": await earning_job(
            session,
            world,
            JobStatus.CONFIRMED,
            T0 - timedelta(days=2),
            3_003,
            transfer=TransferStatus.FAILED,
        ),
        "held_back": await earning_job(
            session,
            world,
            JobStatus.CONFIRMED,
            T0 - timedelta(days=3),
            4_004,
            transfer=TransferStatus.PENDING,
        ),
        "disputed": await earning_job(
            session, world, JobStatus.DISPUTED, T0 - timedelta(days=4), 5_005
        ),
        "paid": await earning_job(
            session,
            world,
            JobStatus.PAID_OUT,
            T0 - timedelta(days=5),
            6_006,
            transfer=TransferStatus.CREATED,
            paid_at=T0 - timedelta(days=4),
        ),
        "reversed": await earning_job(
            session,
            world,
            JobStatus.PAID_OUT,
            T0 - timedelta(days=6),
            7_007,
            transfer=TransferStatus.REVERSED,
            paid_at=T0 - timedelta(days=5),
        ),
    }
    # Nothing earned: refunded, cancelled, not done yet.
    for status in (JobStatus.REFUNDED, JobStatus.CANCELLED, JobStatus.SCHEDULED):
        await earning_job(session, world, status, None, 9_999)
    await earning_job(session, world, JobStatus.REFUNDED, T0, 9_999)
    # Another pro's paid job, the newest of all.
    ids["other_pro"] = await earning_job(
        session,
        world,
        JobStatus.PAID_OUT,
        T0 + timedelta(days=1),
        8_008,
        pro=world.other_pro,
        transfer=TransferStatus.CREATED,
        paid_at=T0 + timedelta(days=1),
    )
    await session.commit()
    return ids


async def read(client: httpx.AsyncClient, party: Any, **params: Any) -> httpx.Response:
    return await client.get(PATH, params=params, headers=party.headers)


async def test_each_job_reads_its_status_and_the_summary_adds_up(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    ids = await seed(db_session, world)

    response = await read(db_client, world.pro, limit=50)

    assert response.status_code == 200, response.text[:300]
    assert response.headers["cache-control"] == NO_STORE
    body = response.json()
    items = {item["job_id"]: item for item in body["items"]}
    by_name = {name: items.get(str(job_id)) for name, job_id in ids.items()}
    # Newest completion first; only the pro's jobs whose work is done.
    assert [item["job_id"] for item in body["items"]] == [
        str(ids[name])
        for name in (
            "awaiting",
            "confirmed_no_row",
            "failed_retrying",
            "held_back",
            "disputed",
            "paid",
            "reversed",
        )
    ]
    expected = {
        "awaiting": ("awaiting_confirmation", 1_001),
        "confirmed_no_row": ("on_the_way", 2_002),
        "failed_retrying": ("on_the_way", 3_003),
        "held_back": ("on_the_way", 4_004),
        "disputed": ("on_hold", 5_005),
        "paid": ("paid", 6_006),
        "reversed": ("on_hold", 7_007),
    }
    for name, (status, amount) in expected.items():
        item = by_name[name]
        assert item is not None, name
        assert (item["status"], item["amount_cents"]) == (status, amount), name
    assert by_name["other_pro"] is None
    # Dates: when the job confirms itself; when it was paid; nothing else.
    awaiting = by_name["awaiting"]
    assert awaiting is not None
    assert datetime.fromisoformat(awaiting["expected_by"]) == T0 + timedelta(hours=CONFIRM_HOURS)
    paid = by_name["paid"]
    assert paid is not None
    assert datetime.fromisoformat(paid["paid_at"]) == T0 - timedelta(days=4)
    assert {
        (name, item["paid_at"] is None, item["expected_by"] is None)
        for name, item in by_name.items()
        if item is not None and name not in ("awaiting", "paid")
    } == {(name, True, True) for name in expected if name not in ("awaiting", "paid")}
    # The safe title: the request's category.
    assert awaiting["category"]["names"]["en"] == "Plumbing"
    assert body["summary"] == {
        "awaiting_confirmation_cents": 1_001,
        "pending_cents": 2_002 + 3_003 + 4_004,
        "on_hold_cents": 5_005 + 7_007,
        "paid_cents": 6_006,
        "currency": "usd",
    }
    totals: dict[str, int] = {}
    for item in body["items"]:
        totals[item["status"]] = totals.get(item["status"], 0) + item["amount_cents"]
    assert totals == {
        "awaiting_confirmation": body["summary"]["awaiting_confirmation_cents"],
        "on_the_way": body["summary"]["pending_cents"],
        "on_hold": body["summary"]["on_hold_cents"],
        "paid": body["summary"]["paid_cents"],
    }
    assert body["next_cursor"] is None


async def test_the_amount_is_the_frozen_payout_never_the_price(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    await earning_job(db_session, world, JobStatus.COMPLETED, T0, 8_500)
    await db_session.commit()

    [item] = (await read(db_client, world.pro)).json()["items"]

    assert item["amount_cents"] == 8_500
    assert item["amount_cents"] not in (PRICE, PRICE - 8_500, FEE)


async def test_another_pro_never_sees_these_jobs(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    ids = await seed(db_session, world)

    mine = (await read(db_client, world.pro, limit=50)).json()
    theirs = (await read(db_client, world.other_pro, limit=50)).json()

    assert str(ids["other_pro"]) not in {item["job_id"] for item in mine["items"]}
    assert [item["job_id"] for item in theirs["items"]] == [str(ids["other_pro"])]
    assert theirs["summary"]["paid_cents"] == 8_008
    assert (
        sum(
            theirs["summary"][key]
            for key in ("awaiting_confirmation_cents", "pending_cents", "on_hold_cents")
        )
        == 0
    )
    # No parameter names a pro: one given is ignored, the caller's own come back.
    guessed = (await read(db_client, world.other_pro, pro_id=str(world.pro.profile_id))).json()
    assert guessed == theirs


async def test_pages_are_stable_at_equal_completion_times(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    ids = sorted(
        [await earning_job(db_session, world, JobStatus.COMPLETED, T0, 100 + n) for n in range(3)],
        reverse=True,
    )
    await db_session.commit()

    seen: list[str] = []
    summaries = []
    cursor: str | None = None
    for _ in range(4):
        params: dict[str, Any] = {"limit": 1}
        if cursor is not None:
            params["cursor"] = cursor
        body = (await read(db_client, world.pro, **params)).json()
        seen += [item["job_id"] for item in body["items"]]
        summaries.append(body["summary"])
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert seen == [str(job_id) for job_id in ids]  # by job id, newest-first order kept
    assert all(summary == summaries[0] for summary in summaries)
    assert summaries[0]["awaiting_confirmation_cents"] == 100 + 101 + 102


async def test_empty_and_no_profile_read_zero(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    for party in (world.pro, world.pro_without_profile):
        body = (await read(db_client, party)).json()
        assert body == {
            "summary": {
                "awaiting_confirmation_cents": 0,
                "pending_cents": 0,
                "on_hold_cents": 0,
                "paid_cents": 0,
                "currency": "usd",
            },
            "items": [],
            "next_cursor": None,
        }


async def test_only_pros_read_and_every_answer_is_no_store(
    db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    answers = {
        "anonymous": await db_client.get(PATH),
        "customer": await db_client.get(PATH, headers=world.customer.headers),
        "agent": await db_client.get(PATH, headers=world.agent.headers),
        "admin": await db_client.get(PATH, headers=world.admin.headers),
        "pro": await db_client.get(PATH, headers=world.pro.headers),
        "bad_cursor": await db_client.get(PATH, params={"cursor": "%%"}, headers=world.pro.headers),
    }

    assert {who: answer.status_code for who, answer in answers.items()} == {
        "anonymous": 401,
        "customer": 403,
        "agent": 403,
        "admin": 403,
        "pro": 200,
        "bad_cursor": 422,
    }
    assert {answer.headers["cache-control"] for answer in answers.values()} == {NO_STORE}


@pytest.mark.parametrize("settings", [make_settings(earnings_read_limit=2)])
async def test_reads_are_limited_per_pro(
    app: FastAPI, db_client: httpx.AsyncClient, world: JobWorld
) -> None:
    # One fixed window for the whole test: on the real clock, a slow run can cross the end of a
    # window between two reads and start counting again.
    limiter = InMemoryRateLimiter(clock=lambda: T0.timestamp())
    app.dependency_overrides[get_rate_limiter] = lambda: limiter

    answers = [await read(db_client, world.pro) for _ in range(3)]

    assert [answer.status_code for answer in answers] == [200, 200, 429]
    assert (await read(db_client, world.other_pro)).status_code == 200


async def test_the_answer_never_names_the_customer_or_stripe(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    await seed(db_session, world)

    text = (await read(db_client, world.pro, limit=50)).text

    for leak in (
        CUSTOMER_EMAIL,
        CUSTOMER_PHONE,
        CUSTOMER_FIRST,
        CUSTOMER_LAST,
        LINE1,
        str(world.customer.id),
        STRIPE_TRANSFER,
        STRIPE_REVERSED,
        "pi_probe68",
        "transfer:",
        "platform_fee",
    ):
        assert leak not in text, leak
