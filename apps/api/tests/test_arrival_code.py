"""The arrival code (D12.2, #63): tries counted under the row lock on real commits, compared in
constant time, and never in logs or Sentry."""

import asyncio
import hmac
import json
import logging
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from sqlalchemy import URL, delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.errors import AppError
from app.integrations.storage import Storage
from app.modules.addresses.models import Address
from app.modules.jobs.errors import ArrivalCodeInvalidError, ArrivalCodeLockedError
from app.modules.jobs.execution import JobExecutionConfig, JobExecutionService
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter, init_sentry
from tests.conftest import make_settings
from tests.helpers import as_status_writer
from tests.job_world import JobWorld, build_world, make_job, record_pushes
from tests.test_requests_api import RecordingQueue
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

__all__ = ["sentry_transport"]  # a fixture, used by name

CODE = "0427"
CONFIG = JobExecutionConfig(
    max_attempts=5,
    list_default_limit=20,
    list_max_limit=50,
    photo_max_per_kind=10,
    photo_attach_max_age=timedelta(minutes=720),
    photo_url_ttl_seconds=300,
    enqueue_timeout_seconds=1.0,
)


def no_storage() -> Storage:
    raise AssertionError("these jobs have no photo to sign")


UUID = re.compile(
    r"[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}"
)


@dataclass(frozen=True)
class CommittedJob:
    sessions: async_sessionmaker[AsyncSession]
    job_id: uuid.UUID
    pro: UserAccount


@pytest.fixture
async def committed_job(test_database_url: URL) -> AsyncIterator[CommittedJob]:
    """A job on the way with its arrival code, and its parties, all committed; deleted after."""
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        customer = User(email=f"c63-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
        pro_user = User(email=f"p63-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        session.add_all([customer, pro_user])
        await session.flush()
        profile = ProProfile(user_id=pro_user.id)
        address = Address(
            user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
        )
        session.add_all([profile, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            description="Fix the faucet",
            origin=RequestOrigin.APP,
            status=RequestStatus.ACCEPTED,
        )
        async with as_status_writer(session):
            session.add(request)
            await session.flush()
        quote = Quote(
            request_id=request.id,
            pro_id=profile.id,
            amount_cents=10_000,
            scope="Faucet",
            duration_minutes=60,
            proposed_start_at=datetime.now(UTC) + timedelta(days=1),
            expires_at=datetime.now(UTC),
            status=QuoteStatus.ACCEPTED,
        )
        session.add(quote)
        await session.flush()
        job = Job(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=customer.id,
            pro_id=profile.id,
            status=JobStatus.ON_THE_WAY,
            customer_price_cents=10_000,
            pro_payout_cents=8_500,
            platform_fee_cents=1_500,
            tax_cents=0,
            arrival_code=CODE,
        )
        async with as_status_writer(session):
            session.add(job)
            await session.flush()
        await session.commit()
        ids = (customer.id, pro_user.id, profile.id, address.id, request.id, quote.id, job.id)
        pro = UserAccount(
            id=pro_user.id,
            email=pro_user.email,
            role=pro_user.role,
            locale=pro_user.locale,
            status=pro_user.status,
            public_code=pro_user.public_code,
            created_at=pro_user.created_at,
        )
    try:
        yield CommittedJob(sessions=sessions, job_id=job.id, pro=pro)
    finally:
        customer_id, pro_user_id, profile_id, address_id, request_id, quote_id, job_id = ids
        async with sessions() as session:
            await session.execute(delete(JobEvent).where(JobEvent.job_id == job_id))
            await session.execute(delete(Job).where(Job.id == job_id))
            await session.execute(delete(Quote).where(Quote.id == quote_id))
            await session.execute(delete(ServiceRequest).where(ServiceRequest.id == request_id))
            await session.execute(delete(Address).where(Address.id == address_id))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile_id))
            await session.execute(delete(User).where(User.id.in_([customer_id, pro_user_id])))
            await session.commit()
        await engine.dispose()


async def test_concurrent_wrong_codes_cannot_exceed_five(committed_job: CommittedJob) -> None:
    # Eight wrong codes at once, each on its own connection and transaction.
    tries = 8

    async def wrong_try() -> AppError:
        async with committed_job.sessions() as session:
            service = JobExecutionService(session, CONFIG, no_storage)
            try:
                await service.check_in(
                    committed_job.pro, committed_job.job_id, "9999", 0.0, 0.0, RecordingQueue()
                )
            except (ArrivalCodeInvalidError, ArrivalCodeLockedError) as error:
                return error
            raise AssertionError("a wrong code was accepted")

    outcomes = await asyncio.gather(*(wrong_try() for _ in range(tries)))

    invalid = sorted(
        e.headers["Arrival-Code-Attempts-Remaining"]
        for e in outcomes
        if isinstance(e, ArrivalCodeInvalidError) and e.headers
    )
    locked = [e for e in outcomes if isinstance(e, ArrivalCodeLockedError)]
    # Each try saw the count the previous one committed: 4, 3, 2, 1 left, then locked.
    assert invalid == ["1", "2", "3", "4"]
    assert len(locked) == tries - 4
    async with committed_job.sessions() as check:
        job = (await check.scalars(select(Job).where(Job.id == committed_job.job_id))).one()
    assert job.arrival_code_attempts == 5
    assert job.arrival_code_locked_at is not None
    assert job.checked_in_at is None


async def test_the_code_is_compared_in_constant_time(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY, arrival_code=CODE)
    pro = await _account(db_session, world)
    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def compare_digest(a: bytes, b: bytes) -> bool:
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr("app.modules.jobs.execution.hmac.compare_digest", compare_digest)
    service = JobExecutionService(db_session, CONFIG, no_storage)

    with pytest.raises(ArrivalCodeInvalidError):
        await service.check_in(pro, job.id, "9999", 0.0, 0.0, RecordingQueue())
    await service.check_in(pro, job.id, CODE, 0.0, 0.0, RecordingQueue())

    assert calls == [(CODE.encode(), b"9999"), (CODE.encode(), CODE.encode())]


async def _account(session: AsyncSession, world: JobWorld) -> UserAccount:
    user = await session.get(User, world.pro.id)
    assert user is not None
    return UserAccount(
        id=user.id,
        email=user.email,
        role=user.role,
        locale=user.locale,
        status=user.status,
        public_code=user.public_code,
        created_at=user.created_at,
    )


def _without_ids(text: str) -> str:
    return UUID.sub("<id>", text)


def _shows(code: str, text: str) -> bool:
    """The code as a value of its own: not inside a longer run of digits or letters."""
    return re.search(rf"(?<![0-9A-Za-z]){code}(?![0-9A-Za-z])", _without_ids(text)) is not None


async def test_arrival_code_never_logged_or_in_sentry(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    sentry_transport: MemoryTransport,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    init_sentry(make_settings(sentry_dsn=TEST_DSN))
    sentry_sdk.get_isolation_scope().clear_breadcrumbs()
    # A known code, so the scan below can look for it; the wrong ones are scanned too.
    monkeypatch.setattr("app.modules.jobs.execution.secrets.randbelow", lambda _: 7391)
    issued, wrong = "7391", "5286"
    world = await build_world(db_session)
    job = await make_job(db_session, world)
    base = f"/v1/pros/me/jobs/{job.id}"
    here = {"lat": 28.5, "lng": -81.3}
    queue = record_pushes(app)  # the On my way push (#65)

    with caplog.at_level(logging.DEBUG):
        moved = await db_client.post(
            f"{base}/on-the-way", json={"eta_minutes": 15}, headers=world.pro.headers
        )
        shown = await db_client.get(
            f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
        )
        for _ in range(5):  # the fifth locks and logs an ERROR, which Sentry captures
            await db_client.post(
                f"{base}/check-in",
                json={"arrival_code": wrong, **here},
                headers=world.pro.headers,
            )
        locked = await db_client.post(
            f"{base}/check-in", json={"arrival_code": issued, **here}, headers=world.pro.headers
        )
    sentry_sdk.flush()

    assert moved.status_code == 200, moved.text
    assert shown.json()["arrival_code"] == issued  # the customer's own view has it
    assert locked.status_code == 423
    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"logentry"' in p]
    assert any(e["logentry"]["message"] == "arrival_code_locked" for e in events)
    wire = "\n".join(payloads)
    formatter = JsonFormatter()
    logs = "\n".join(formatter.format(r) + r.getMessage() for r in caplog.records)
    assert "arrival_code_locked" in logs
    for code in (issued, wrong):
        assert not _shows(code, wire), code
        assert not _shows(code, logs), code
    # Neither does any response to the pro.
    assert not _shows(issued, moved.text)
    # Nor the push to the customer (#65): it points to the app instead.
    assert list(queue.jobs) == [f"push:job_on_the_way:{job.id}"]
    assert not _shows(issued, repr(queue.jobs))
