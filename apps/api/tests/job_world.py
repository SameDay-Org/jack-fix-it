"""Rows for the job execution tests (#63): two customers, two pros, staff, and paid jobs.

Every private field is filled (emails, phones, last names, the street), so a leak would show.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.auth import security
from app.modules.categories.models import Category
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.conftest import TEST_JWT_SECRET
from tests.helpers import as_status_writer, letter_tag

CUSTOMER_EMAIL = "probe-customer-63@example.com"
CUSTOMER_PHONE = "+13055550163"
CUSTOMER_FIRST = "Ana"
CUSTOMER_LAST = "Probelast"
PRO_EMAIL = "probe-pro-63@example.com"
PRO_PHONE = "+13055550164"
LINE1 = "742 Evergreen Terrace"
LINE2 = "Apt 63"
DESCRIPTION = "Kitchen faucet drips"
PRICE, TAX, PAYOUT, FEE = 20_000, 1_400, 17_000, 3_000
START = datetime(2030, 1, 15, 14, 30, tzinfo=UTC)
LEAKS = (CUSTOMER_EMAIL, CUSTOMER_PHONE, CUSTOMER_LAST, PRO_EMAIL, PRO_PHONE)


@dataclass(frozen=True)
class Party:
    id: uuid.UUID
    headers: dict[str, str]


@dataclass(frozen=True)
class Pro(Party):
    profile_id: uuid.UUID


@dataclass(frozen=True)
class JobWorld:
    customer: Party
    other_customer: Party
    pro: Pro
    other_pro: Pro
    pro_without_profile: Party
    agent: Party
    admin: Party
    category_id: uuid.UUID
    address_id: uuid.UUID


def headers_for(user_id: uuid.UUID, role: UserRole) -> dict[str, str]:
    token = security.create_access_token(
        user_id=user_id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return {"Authorization": f"Bearer {token}"}


async def _user(session: AsyncSession, role: UserRole, **fields: object) -> Party:
    fields.setdefault("email", f"{role.value}-{uuid.uuid4().hex[:8]}@x.com")
    user = User(password_hash="x", role=role, **fields)
    session.add(user)
    await session.flush()
    return Party(user.id, headers_for(user.id, role))


async def _pro(session: AsyncSession, **fields: object) -> Pro:
    party = await _user(session, UserRole.PRO, **fields)
    profile = ProProfile(
        user_id=party.id,
        verification_status=ProVerificationStatus.APPROVED,
        payouts_enabled=True,
        years_of_experience=7,
        bio="probe-bio-63",
    )
    session.add(profile)
    await session.flush()
    return Pro(party.id, party.headers, profile.id)


async def build_world(session: AsyncSession) -> JobWorld:
    customer = await _user(
        session,
        UserRole.CUSTOMER,
        email=CUSTOMER_EMAIL,
        phone=CUSTOMER_PHONE,
        first_name=CUSTOMER_FIRST,
        last_name=CUSTOMER_LAST,
    )
    pro = await _pro(
        session, email=PRO_EMAIL, phone=PRO_PHONE, first_name="María", last_name="Pérez"
    )
    category = Category(slug=f"test-{letter_tag()}", names={"en": "Plumbing", "es": "Plomería"})
    session.add(category)
    await session.flush()
    address = Address(
        user_id=customer.id,
        line1=LINE1,
        line2=LINE2,
        city="Orlando",
        state="FL",
        zip_code="32801",
    )
    session.add(address)
    await session.flush()
    return JobWorld(
        customer=customer,
        other_customer=await _user(session, UserRole.CUSTOMER),
        pro=pro,
        other_pro=await _pro(session),
        pro_without_profile=await _user(session, UserRole.PRO),
        agent=await _user(session, UserRole.AGENT),
        admin=await _user(session, UserRole.ADMIN),
        category_id=category.id,
        address_id=address.id,
    )


async def make_accepted_request(
    session: AsyncSession, world: JobWorld, pro: Pro
) -> tuple[ServiceRequest, Quote]:
    """The customer's request, accepted, with the pro's accepted quote: no job yet."""
    request = ServiceRequest(
        customer_id=world.customer.id,
        address_id=world.address_id,
        category_id=world.category_id,
        description=f"{DESCRIPTION}, call {CUSTOMER_PHONE}",
        origin=RequestOrigin.APP,
        status=RequestStatus.ACCEPTED,
    )
    async with as_status_writer(session):  # the database guard (#163)
        session.add(request)
        await session.flush()
    quote = Quote(
        request_id=request.id,
        pro_id=pro.profile_id,
        amount_cents=PRICE,
        scope="Replace the cartridge",
        duration_minutes=60,
        proposed_start_at=START,
        expires_at=START,
        status=QuoteStatus.ACCEPTED,
    )
    session.add(quote)
    await session.flush()
    return request, quote


async def make_job(
    session: AsyncSession,
    world: JobWorld,
    status: JobStatus = JobStatus.SCHEDULED,
    *,
    pro: Pro | None = None,
    created_at: datetime | None = None,
    **fields: object,
) -> Job:
    """A paid job in `status`: its request (accepted), accepted quote and `created` event."""
    pro = pro or world.pro
    request, quote = await make_accepted_request(session, world, pro)
    job = Job(
        request_id=request.id,
        quote_id=quote.id,
        customer_id=world.customer.id,
        pro_id=pro.profile_id,
        status=status,
        customer_price_cents=PRICE,
        pro_payout_cents=PAYOUT,
        platform_fee_cents=FEE,
        tax_cents=TAX,
        **({"created_at": created_at} if created_at else {}),
        **fields,
    )
    async with as_status_writer(session):
        session.add(job)
        await session.flush()
    session.add(JobEvent(job_id=job.id, type="created", to_status=JobStatus.SCHEDULED))
    await session.flush()
    return job


async def job_row(session: AsyncSession, job_id: uuid.UUID) -> Job:
    statement = select(Job).where(Job.id == job_id).execution_options(populate_existing=True)
    return (await session.scalars(statement)).one()


async def events(session: AsyncSession, job_id: uuid.UUID) -> list[JobEvent]:
    statement = (
        select(JobEvent)
        .where(JobEvent.job_id == job_id)
        .order_by(JobEvent.created_at, JobEvent.id)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())
