"""Two submits of the same side's review at once create exactly one (#77).

Real commits on separate connections: the rolled-back db_session cannot show a race. The job
and its users are test_job_chat_concurrency's, committed and deleted afterwards; the reviews
go first.
"""

import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest
from sqlalchemy import delete, select

from app.modules.jobs.models import JobStatus
from app.modules.jobs.service import JobStateMachine
from app.modules.pros.service import ProService
from app.modules.reviews.errors import AlreadyReviewedError
from app.modules.reviews.models import Review, ReviewAuthorRole
from app.modules.reviews.repository import ReviewRepository
from app.modules.reviews.schemas import ReviewIn
from app.modules.reviews.service import ReviewConfig, ReviewService
from app.modules.users.types import UserRole
from tests.conftest import Committed, backend_pid, wait_until_blocked
from tests.job_world import headers_for
from tests.test_job_chat_concurrency import CommittedJob, committed_job

__all__ = ["committed_job"]  # a fixture, used by name

ALREADY_REVIEWED = {
    "error": {"code": "already_reviewed", "message": "You already reviewed this job."}
}
SUBMITS = 5
CONFIG = ReviewConfig(publish_after=timedelta(days=14))


@pytest.fixture
async def confirmed(committed_job: CommittedJob) -> AsyncIterator[CommittedJob]:
    """The committed job, confirmed by its customer through the state machine."""
    world = committed_job
    async with world.sessions() as session:
        machine = JobStateMachine(session, ProService(session))
        await machine.transition(world.job_id, JobStatus.CONFIRMED, world.customer)
        await session.commit()
    try:
        yield world
    finally:
        async with world.sessions() as session:
            await session.execute(delete(Review).where(Review.job_id == world.job_id))
            await session.commit()


async def _reviews(world: CommittedJob) -> list[Review]:
    async with world.sessions() as session:
        statement = (
            select(Review)
            .where(Review.job_id == world.job_id)
            .order_by(Review.created_at, Review.id)
        )
        return list((await session.scalars(statement)).all())


def _first_submit(world: CommittedJob) -> Review:
    """The customer's review as the first of two submits writes it."""
    return Review(
        job_id=world.job_id,
        author_id=world.customer.id,
        target_id=world.pro.id,
        author_role=ReviewAuthorRole.CUSTOMER,
        overall=5,
    )


async def test_a_submit_waiting_on_another_is_refused_once_that_one_commits(
    confirmed: CommittedJob,
) -> None:
    world = confirmed
    async with world.sessions() as first, world.sessions() as second:
        # The first submit wrote its review and has not committed yet.
        await ReviewRepository(first).add(_first_submit(world))
        holder = await backend_pid(first)
        waiter = await backend_pid(second)
        submit = asyncio.create_task(
            ReviewService(second, CONFIG).create(world.customer, world.job_id, ReviewIn(overall=1))
        )
        # The second passed every check (no review is committed) and waits on the constraint.
        await wait_until_blocked(world.sessions, waiter=waiter, holder=holder)
        await first.commit()

        with pytest.raises(AlreadyReviewedError):
            await submit
        await second.rollback()

    assert [(r.author_id, r.overall) for r in await _reviews(world)] == [(world.customer.id, 5)]


async def test_a_submit_waiting_on_another_goes_through_when_that_one_rolls_back(
    confirmed: CommittedJob,
) -> None:
    world = confirmed
    async with world.sessions() as first, world.sessions() as second:
        await ReviewRepository(first).add(_first_submit(world))
        holder = await backend_pid(first)
        waiter = await backend_pid(second)
        submit = asyncio.create_task(
            ReviewService(second, CONFIG).create(world.customer, world.job_id, ReviewIn(overall=1))
        )
        await wait_until_blocked(world.sessions, waiter=waiter, holder=holder)
        await first.rollback()

        created = await submit

    assert [(r.id, r.author_id, r.overall) for r in await _reviews(world)] == [
        (created.id, world.customer.id, 1)
    ]


@pytest.mark.parametrize("side", ["customer", "pro"])
async def test_the_same_side_submitting_at_once_creates_exactly_one_review(
    committed: Committed, confirmed: CommittedJob, side: str
) -> None:
    world = confirmed
    author = world.customer if side == "customer" else world.pro
    headers = headers_for(author.id, UserRole(side))

    responses = await asyncio.gather(
        *(
            committed.client.post(
                f"/v1/jobs/{world.job_id}/reviews", json={"overall": overall}, headers=headers
            )
            for overall in range(1, SUBMITS + 1)
        )
    )

    assert sorted(r.status_code for r in responses) == [201, *[409] * (SUBMITS - 1)]
    [winner] = [r for r in responses if r.status_code == 201]
    assert all(r.json() == ALREADY_REVIEWED for r in responses if r is not winner)
    [review] = await _reviews(world)
    assert (str(review.id), review.author_id) == (winner.json()["id"], author.id)


async def test_both_sides_submitting_at_once_each_create_their_own(
    committed: Committed, confirmed: CommittedJob
) -> None:
    world = confirmed
    sides = (
        (world.customer.id, UserRole.CUSTOMER, world.pro.id),
        (world.pro.id, UserRole.PRO, world.customer.id),
    )

    responses = await asyncio.gather(
        *(
            committed.client.post(
                f"/v1/jobs/{world.job_id}/reviews",
                json={"overall": 4},
                headers=headers_for(author, role),
            )
            for author, role, _ in sides
        )
    )

    assert [r.status_code for r in responses] == [201, 201]
    assert {(r.author_id, r.target_id) for r in await _reviews(world)} == {
        (author, target) for author, _, target in sides
    }
