"""Reviews of a pro for tests (#78): each one on its own confirmed job, by its own customer.

A pro's rating and jobs completed are computed from these (app.modules.reviews.ratings), so a
test gives a pro a rating by writing what the rating is computed from, never the unread
pro_profiles.rating_avg / jobs_count columns."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.jobs.models import Job, JobStatus
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.reviews.models import Review, ReviewAuthorRole
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.helpers import as_status_writer

PRICE, TAX, PAYOUT, FEE = 20_000, 1_400, 17_000, 3_000
START: Final = datetime(2030, 1, 15, 14, 30, tzinfo=UTC)
# Long before any publication window: a review of a job confirmed then is published.
LONG_AGO: Final = datetime.now(UTC) - timedelta(days=120)


async def confirmed_job(
    session: AsyncSession,
    pro_id: uuid.UUID,
    *,
    confirmed_at: datetime = LONG_AGO,
    status: JobStatus = JobStatus.CONFIRMED,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A job of this pro for a new customer, confirmed at `confirmed_at` (status as given):
    (the job's id, the customer's id)."""
    customer = User(email=f"rated-{uuid.uuid4().hex[:12]}@x.com", password_hash="x")
    customer.role = UserRole.CUSTOMER
    session.add(customer)
    await session.flush()
    address = Address(
        user_id=customer.id, line1="1 Rating Road", city="Orlando", state="FL", zip_code="32801"
    )
    session.add(address)
    await session.flush()
    request = ServiceRequest(
        customer_id=customer.id,
        address_id=address.id,
        description="rated",
        origin=RequestOrigin.APP,
        status=RequestStatus.ACCEPTED,
    )
    async with as_status_writer(session):
        session.add(request)
        await session.flush()
    quote = Quote(
        request_id=request.id,
        pro_id=pro_id,
        amount_cents=PRICE,
        scope="Fix it",
        duration_minutes=60,
        proposed_start_at=START,
        expires_at=START,
        status=QuoteStatus.ACCEPTED,
    )
    session.add(quote)
    await session.flush()
    job = Job(
        request_id=request.id,
        quote_id=quote.id,
        customer_id=customer.id,
        pro_id=pro_id,
        status=status,
        confirmed_at=confirmed_at,
        customer_price_cents=PRICE,
        pro_payout_cents=PAYOUT,
        platform_fee_cents=FEE,
        tax_cents=TAX,
    )
    async with as_status_writer(session):
        session.add(job)
        await session.flush()
    return job.id, customer.id


async def rate(
    session: AsyncSession,
    pro_id: uuid.UUID,
    *ratings: int,
    published: bool = True,
    answered: bool = False,
    comment: str | None = None,
) -> list[uuid.UUID]:
    """One customer review of the pro per rating, each on its own confirmed job; the job ids.
    `published`: confirmed long ago (past the window); else confirmed now, so a review counts
    only when `answered` (the pro reviewed the customer on the same job too)."""
    pro_user_id = await session.scalar(select(ProProfile.user_id).where(ProProfile.id == pro_id))
    assert pro_user_id is not None
    jobs: list[uuid.UUID] = []
    for overall in ratings:
        when = LONG_AGO if published else datetime.now(UTC)
        job_id, customer_id = await confirmed_job(session, pro_id, confirmed_at=when)
        session.add(
            Review(
                job_id=job_id,
                author_id=customer_id,
                target_id=pro_user_id,
                author_role=ReviewAuthorRole.CUSTOMER,
                overall=overall,
                comment=comment,
            )
        )
        if answered:
            session.add(
                Review(
                    job_id=job_id,
                    author_id=pro_user_id,
                    target_id=customer_id,
                    author_role=ReviewAuthorRole.PRO,
                    overall=5,
                )
            )
        await session.flush()
        jobs.append(job_id)
    return jobs
