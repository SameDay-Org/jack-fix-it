"""The account holder deletes their own account (#97): POST /v1/me/delete.

Committed sessions: each request is its own transaction on its own connection, as in
production. Every row a test makes is deleted after it, by id (the email changes on deletion).
The deletion's audit row is recorded instead of written there (audit_log is append-only, so a
committed row could never be cleaned up); the row itself is proven on the rolled-back session.

The completeness check is a sweep: after a deletion, no text, JSON or bytes column of any
table holds the sentinel values the test planted in every place a person's data goes, except
the rows kept by rule (a review's text), and no other point locates the home.
"""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from redis.exceptions import RedisError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.integrations.storage import (
    DeleteResult,
    ObjectPage,
    StorageUnavailableError,
    StoredObject,
)
from app.integrations.stripe_errors import StripeUnavailableError
from app.modules.accounts.models import AccountDeletion
from app.modules.accounts.tasks import clean_up_deleted_account, retry_account_cleanups
from app.modules.addresses.models import Address, SavedAddress
from app.modules.audit.models import AuditLog
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction, AuditEntity, AuditEntityType, AuditState
from app.modules.auth.models import RefreshToken
from app.modules.categories.models import Category
from app.modules.chat.models import JobMessage
from app.modules.devices.models import Device, DevicePlatform
from app.modules.disputes.models import Dispute, DisputeReason, DisputeStatus
from app.modules.jobs.models import Job, JobEvent, JobStatus
from app.modules.ops.models import RequestFollowup, RequestNote
from app.modules.payments.models import (
    Payment,
    PaymentStatus,
    Refund,
    RefundStatus,
    Transfer,
    TransferStatus,
)
from app.modules.pros.models import (
    ProCategory,
    ProDocument,
    ProDocumentType,
    ProProfile,
    ProVerificationStatus,
)
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.requests.erasure import SAFE_EXTENSIONS
from app.modules.requests.media_copies import safe_key_for
from app.modules.requests.models import (
    MediaSafeStatus,
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    RequestStatus,
    ServiceRequest,
)
from app.modules.reviews.models import Review, ReviewAuthorRole
from app.modules.support.models import SupportTicket, TicketRole, TicketTopic
from app.modules.users.models import User
from app.modules.users.types import DELETED_USER_NAME, ERASED_TEXT, UserRole, UserStatus
from app.modules.waitlist.models import WaitlistEntry, WaitlistSource
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    Committed,
    InMemoryRateLimiter,
    backend_pid,
    make_settings,
    wait_until_blocked,
)
from tests.helpers import as_status_writer
from tests.job_world import headers_for
from tests.test_payment_methods_api import FakeStripePaymentMethods
from tests.test_requests_api import RecordingQueue

PASSWORD = "correct horse battery"
RATE_LIMIT = 4
PRICE, TAX, FEE = 10_000, 700, 1_500


@pytest.fixture
def settings() -> Any:
    # Not the default, so the rate limit test proves it comes from the settings.
    # The worker's second erasure at once: no request of the account is left running here.
    return make_settings(auth_rate_limit_requests=RATE_LIMIT, account_deletion_settle_seconds=0)


@dataclass
class Account:
    id: uuid.UUID
    email: str
    access: str
    refresh: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access}"}


@dataclass
class World:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    customer: Account
    pro: Account
    pro_profile_id: uuid.UUID
    category_id: uuid.UUID
    agent_id: uuid.UUID
    # Planted in every place the customer's data goes, and the pro's: unique to the test.
    sentinel: str
    pro_sentinel: str
    phone: str
    audits: list[tuple[uuid.UUID, AuditAction, AuditEntity, AuditState, AuditState]]
    queue: RecordingQueue
    users: list[uuid.UUID] = field(default_factory=list)


async def sign_up(client: httpx.AsyncClient, role: str, email: str) -> Account:
    response = await client.post(
        "/v1/auth/register", json={"email": email, "password": PASSWORD, "role": role}
    )
    assert response.status_code == 201, response.text
    body = response.json()
    return Account(
        uuid.UUID(body["user"]["id"]), email, body["access_token"], body["refresh_token"]
    )


async def delete_account(
    client: httpx.AsyncClient, account: Account, password: str = PASSWORD
) -> httpx.Response:
    return await client.post("/v1/me/delete", json={"password": password}, headers=account.headers)


@pytest.fixture
async def world(
    committed: Committed, app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[World]:
    limiter = InMemoryRateLimiter(clock=lambda: 1_000.0)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    queue = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: queue
    audits: list[tuple[uuid.UUID, AuditAction, AuditEntity, AuditState, AuditState]] = []

    async def record(
        self: AuditService,
        actor_id: uuid.UUID,
        action: AuditAction,
        entity: AuditEntity,
        before: AuditState,
        after: AuditState,
    ) -> None:
        audits.append((actor_id, action, entity, before, after))

    monkeypatch.setattr(AuditService, "record_party_action", record)
    sentinel = f"zq{uuid.uuid4().hex[:12]}"
    pro_sentinel = f"zp{uuid.uuid4().hex[:12]}"
    phone = f"+1305{uuid.uuid4().int % 10_000_000:07d}"
    client = committed.client
    customer = await sign_up(client, "customer", f"cust-{sentinel}@example.com")
    pro = await sign_up(client, "pro", f"pro-{pro_sentinel}@example.com")
    users = [customer.id, pro.id]
    categories: list[uuid.UUID] = []
    try:
        async with committed.sessions() as session:
            tag = uuid.uuid4().hex[:12]
            category = Category(slug=f"del-{tag}", names={"en": "Plumbing", "es": "Plomería"})
            agent = User(email=f"agent-{tag}@example.com", password_hash="x", role=UserRole.AGENT)
            session.add_all([category, agent])
            await session.flush()
            categories.append(category.id)
            users.append(agent.id)
            profile = ProProfile(
                user_id=pro.id,
                verification_status=ProVerificationStatus.APPROVED,
                payouts_enabled=True,
                years_of_experience=7,
                bio=f"Twenty years of pipes, ask for {pro_sentinel}",
                photo_key=f"u/{pro.id}/profile_photo/{uuid.uuid4().hex}.jpg",
            )
            session.add(profile)
            await session.flush()
            session.add(ProCategory(pro_id=profile.id, category_id=category.id))
            await session.commit()
            profile_id, agent_id = profile.id, agent.id
        yield World(
            client=client,
            sessions=committed.sessions,
            customer=customer,
            pro=pro,
            pro_profile_id=profile_id,
            category_id=categories[0],
            agent_id=agent_id,
            sentinel=sentinel,
            pro_sentinel=pro_sentinel,
            phone=phone,
            audits=audits,
            queue=queue,
            users=users,
        )
    finally:
        async with committed.sessions() as session:
            await purge(session, users, categories)
            await session.commit()


async def purge(session: AsyncSession, users: list[uuid.UUID], categories: list[uuid.UUID]) -> None:
    """Deletes every row these users and categories have anywhere, in dependency order."""
    ids = {"users": users}
    ids["pros"] = list(
        await session.scalars(text("SELECT id FROM pro_profiles WHERE user_id = ANY(:users)"), ids)
    )
    ids["requests"] = list(
        await session.scalars(
            text("SELECT id FROM service_requests WHERE customer_id = ANY(:users)"), ids
        )
    )
    ids["jobs"] = list(
        await session.scalars(
            text("SELECT id FROM jobs WHERE customer_id = ANY(:users) OR pro_id = ANY(:pros)"),
            ids,
        )
    )
    ids["categories"] = categories
    for statement in (
        "DELETE FROM job_message_deliveries WHERE user_id = ANY(:users) OR message_id IN "
        "(SELECT id FROM job_messages WHERE job_id = ANY(:jobs))",
        "DELETE FROM job_chat_reads WHERE user_id = ANY(:users) OR job_id = ANY(:jobs)",
        "DELETE FROM chat_offender_flags WHERE user_id = ANY(:users) OR job_id = ANY(:jobs)",
        "DELETE FROM job_messages WHERE job_id = ANY(:jobs)",
        "DELETE FROM reviews WHERE job_id = ANY(:jobs)",
        "DELETE FROM dispute_photos WHERE dispute_id IN "
        "(SELECT id FROM disputes WHERE job_id = ANY(:jobs))",
        "DELETE FROM refunds WHERE job_id = ANY(:jobs)",
        "DELETE FROM disputes WHERE job_id = ANY(:jobs)",
        "DELETE FROM transfers WHERE job_id = ANY(:jobs) OR pro_id = ANY(:pros)",
        "DELETE FROM job_cancellations WHERE job_id = ANY(:jobs)",
        "DELETE FROM job_photos WHERE job_id = ANY(:jobs)",
        "DELETE FROM job_events WHERE job_id = ANY(:jobs)",
        "DELETE FROM support_tickets WHERE user_id = ANY(:users) OR job_id = ANY(:jobs)",
        "DELETE FROM jobs WHERE id = ANY(:jobs)",
        "DELETE FROM payments WHERE customer_id = ANY(:users) OR request_id = ANY(:requests)",
        "DELETE FROM request_dispatches WHERE request_id = ANY(:requests) OR pro_id = ANY(:pros)",
        "DELETE FROM quotes WHERE request_id = ANY(:requests) OR pro_id = ANY(:pros)",
        "DELETE FROM request_media WHERE request_id = ANY(:requests)",
        "DELETE FROM request_notes WHERE request_id = ANY(:requests)",
        "DELETE FROM request_followups WHERE request_id = ANY(:requests)",
        "DELETE FROM service_requests WHERE id = ANY(:requests)",
        "DELETE FROM addresses WHERE user_id = ANY(:users)",
        "DELETE FROM saved_addresses WHERE user_id = ANY(:users)",
        "DELETE FROM pro_documents WHERE pro_id = ANY(:pros)",
        "DELETE FROM pro_categories WHERE pro_id = ANY(:pros)",
        "DELETE FROM pro_service_areas WHERE pro_id = ANY(:pros)",
        "DELETE FROM pro_profiles WHERE id = ANY(:pros)",
        "DELETE FROM devices WHERE user_id = ANY(:users)",
        "DELETE FROM notification_preferences WHERE user_id = ANY(:users)",
        "DELETE FROM waitlist_entries WHERE user_id = ANY(:users)",
        "DELETE FROM refresh_tokens WHERE user_id = ANY(:users)",
        "DELETE FROM terms_acceptances WHERE user_id = ANY(:users)",
        "DELETE FROM account_deletions WHERE user_id = ANY(:users)",
        "DELETE FROM users WHERE id = ANY(:users)",
        "DELETE FROM categories WHERE id = ANY(:categories)",
    ):
        await session.execute(text(statement), ids)


# The world a test plants, row by row, on a committed session.


async def add_request(
    session: AsyncSession,
    world: World,
    status: RequestStatus = RequestStatus.ACCEPTED,
    *,
    point: bool = True,
) -> ServiceRequest:
    address = Address(
        user_id=world.customer.id,
        line1=f"{world.sentinel} Main St",
        line2=f"Apt {world.sentinel}",
        city="Orlando",
        state="FL",
        zip_code="32801",
        lat=Decimal("28.538336") if point else None,
        lng=Decimal("-81.379234") if point else None,
    )
    session.add(address)
    await session.flush()
    request = ServiceRequest(
        customer_id=world.customer.id,
        address_id=address.id,
        category_id=world.category_id,
        description=f"Leak under the sink, ask for {world.sentinel}",
        intake_answers={"access": f"gate code {world.sentinel}"},
        origin=RequestOrigin.APP,
        status=status,
    )
    async with as_status_writer(session):
        session.add(request)
        await session.flush()
    return request


async def add_quote(
    session: AsyncSession,
    world: World,
    request: ServiceRequest,
    status: QuoteStatus = QuoteStatus.ACCEPTED,
) -> Quote:
    quote = Quote(
        request_id=request.id,
        pro_id=world.pro_profile_id,
        amount_cents=PRICE,
        scope="Replace the cartridge",
        duration_minutes=60,
        proposed_start_at=datetime.now(UTC) + timedelta(days=1),
        expires_at=datetime.now(UTC) + timedelta(days=1),
        status=status,
    )
    session.add(quote)
    await session.flush()
    return quote


@dataclass(frozen=True)
class Paid:
    request: ServiceRequest
    job: Job
    payment: Payment


async def add_job(
    session: AsyncSession,
    world: World,
    status: JobStatus = JobStatus.PAID_OUT,
    *,
    payment: PaymentStatus = PaymentStatus.SUCCEEDED,
) -> Paid:
    request = await add_request(session, world)
    quote = await add_quote(session, world, request)
    paid = Payment(
        request_id=request.id,
        quote_id=quote.id,
        customer_id=world.customer.id,
        amount_cents=PRICE,
        tax_cents=TAX,
        customer_total_cents=PRICE + TAX,
        platform_fee_cents=FEE,
        pro_payout_cents=PRICE - FEE,
        take_rate_bps=1500,
        currency="usd",
        status=payment,
    )
    session.add(paid)
    job = Job(
        request_id=request.id,
        quote_id=quote.id,
        customer_id=world.customer.id,
        pro_id=world.pro_profile_id,
        status=status,
        customer_price_cents=PRICE,
        pro_payout_cents=PRICE - FEE,
        platform_fee_cents=FEE,
        tax_cents=TAX,
    )
    async with as_status_writer(session):
        session.add(job)
        await session.flush()
    session.add_all(
        [
            JobEvent(job_id=job.id, type="created", to_status=JobStatus.SCHEDULED),
            # The pro's check-in, at the customer's door.
            JobEvent(
                job_id=job.id,
                type="checked_in",
                to_status=JobStatus.IN_PROGRESS,
                lat=Decimal("28.538300"),
                lng=Decimal("-81.379200"),
            ),
        ]
    )
    await session.flush()
    return Paid(request, job, paid)


async def row_values(session: AsyncSession, model: Any, row_id: uuid.UUID) -> dict[str, Any]:
    """Every column of the row as last committed, but its updated_at."""
    row = (
        await session.scalars(
            select(model).where(model.id == row_id).execution_options(populate_existing=True)
        )
    ).one()
    return {
        column.key: getattr(row, column.key)
        for column in model.__table__.columns
        if column.key != "updated_at"
    }


async def sweep(session: AsyncSession, *needles: str) -> set[tuple[str, str]]:
    """(table, column) of every text, JSON or bytes column, in any table, holding a needle."""
    columns = (
        await session.execute(
            text(
                "SELECT table_name, column_name, data_type FROM information_schema.columns "
                "WHERE table_schema = 'public' AND data_type IN "
                "('text', 'character varying', 'character', 'json', 'jsonb', 'bytea')"
            )
        )
    ).all()
    found: set[tuple[str, str]] = set()
    for table, column, data_type in columns:
        quoted = f'"{column}"'  # a column may be a reserved word (notification_preferences.group)
        value = f"encode({quoted}, 'escape')" if data_type == "bytea" else f"{quoted}::text"
        for needle in needles:
            # The names come from information_schema; the needle is bound.
            query = f'SELECT 1 FROM "{table}" WHERE {value} ILIKE :pattern LIMIT 1'  # noqa: S608
            statement = text(query)
            if await session.scalar(statement, {"pattern": f"%{needle}%"}):
                found.add((table, column))
    return found


async def plant_everything(session: AsyncSession, world: World) -> Paid:
    """The customer's data in every place it goes, around one paid-out job."""
    customer_id = world.customer.id
    await session.execute(
        update(User)
        .where(User.id == customer_id)
        .values(
            first_name=f"Ann{world.sentinel}",
            last_name=f"Lee{world.sentinel}",
            phone=world.phone,
            phone_verified_at=datetime.now(UTC),
            home_city=f"Town{world.sentinel}",
            home_state="FL",
            photo_key=f"u/{customer_id}/profile_photo/{uuid.uuid4().hex}.jpg",
        )
    )
    session.add(
        SavedAddress(
            user_id=customer_id,
            label="Home",
            line1=f"{world.sentinel} Oak Ave",
            city="Orlando",
            state="FL",
            zip_code="32801",
            lat=Decimal("28.5"),
            lng=Decimal("-81.3"),
        )
    )
    paid = await add_job(session, world)
    session.add_all(
        [
            RequestMedia(
                request_id=paid.request.id,
                kind=RequestMediaKind.PHOTO,
                file_key=f"u/{customer_id}/request_media/{uuid.uuid4().hex}.jpg",
                safe_key=f"m/{uuid.uuid4().hex}.jpg",
                safe_status=MediaSafeStatus.READY,
            ),
            RequestMedia(
                request_id=paid.request.id,
                kind=RequestMediaKind.PHOTO,
                file_key=f"u/{customer_id}/request_media/{uuid.uuid4().hex}.jpg",
            ),
            Device(
                user_id=customer_id,
                expo_push_token=f"ExponentPushToken[{world.sentinel}]",
                platform=DevicePlatform.IOS,
                last_seen_at=datetime.now(UTC),
            ),
            # Signed in, and signed out with the same email.
            WaitlistEntry(
                user_id=customer_id,
                zip_code="00009",
                phone=world.phone,
                source=next(iter(WaitlistSource)),
            ),
            WaitlistEntry(
                zip_code="00010", email=world.customer.email, source=next(iter(WaitlistSource))
            ),
            SupportTicket(
                user_id=customer_id,
                role=TicketRole.CUSTOMER,
                topic=next(iter(TicketTopic)),
                message=f"Please call me back, I am {world.sentinel}",
            ),
            JobMessage(
                job_id=paid.job.id,
                sender_id=customer_id,
                body="Call me at [phone removed]",
                redacted=True,
                original_ciphertext=b"\x00" * 12
                + f"Call me at {world.sentinel}".encode()
                + b"\x00" * 16,
                original_key_id="k1",
                original_expires_at=datetime.now(UTC) + timedelta(days=90),
            ),
            RequestNote(
                request_id=paid.request.id,
                author_id=world.agent_id,
                body=f"Called {world.sentinel} at {world.phone}",
            ),
            RequestFollowup(
                request_id=paid.request.id,
                assigned_to=world.agent_id,
                created_by=world.agent_id,
                due_at=datetime.now(UTC) + timedelta(days=1),
                note=f"Call {world.sentinel} back",
            ),
            # Kept by rule (a review is the pro's rating), stored redacted already.
            Review(
                job_id=paid.job.id,
                author_id=customer_id,
                target_id=world.pro.id,
                author_role=ReviewAuthorRole.CUSTOMER,
                overall=5,
                comment=f"Great work, thanks from {world.sentinel}",
            ),
        ]
    )
    await session.flush()
    return paid


# What a deletion erases, and what it keeps.


async def test_a_customers_personal_data_is_gone_and_the_money_records_stay(world: World) -> None:
    async with world.sessions() as session:
        paid = await plant_everything(session, world)
        transfer = Transfer(
            job_id=paid.job.id,
            payment_id=paid.payment.id,
            pro_id=world.pro_profile_id,
            amount_cents=PRICE - FEE,
            currency="usd",
            status=TransferStatus.CREATED,
            stripe_transfer_id=f"tr_{uuid.uuid4().hex}",
            idempotency_key=f"transfer:{paid.job.id}",
        )
        session.add(transfer)
        await session.commit()
        kept = {
            (model, row_id): await row_values(session, model, row_id)
            for model, row_id in (
                (Job, paid.job.id),
                (Payment, paid.payment.id),
                (Transfer, transfer.id),
            )
        }
        media = (
            await session.execute(
                select(RequestMedia.id, RequestMedia.file_key, RequestMedia.safe_key).where(
                    RequestMedia.request_id == paid.request.id
                )
            )
        ).all()
        # Each original and safe copy; for the copy still being made, every key it can get.
        media_keys = {file_key for _, file_key, _ in media} | {
            safe_key for _, _, safe_key in media if safe_key
        }
        media_keys |= {
            safe_key_for(media_id, extension)
            for media_id, _, safe_key in media
            if safe_key is None
            for extension in SAFE_EXTENSIONS
        }
        before = await row_values(session, User, world.customer.id)
        # Planted: the sweep sees it before.
        assert ("users", "first_name") in await sweep(session, world.sentinel, world.phone)

    response = await delete_account(world.client, world.customer)

    assert response.status_code == 204, response.text
    async with world.sessions() as session:
        # Only the review's text is left, as the rule keeps it.
        assert await sweep(session, world.sentinel, world.phone) == {("reviews", "comment")}
        user = await row_values(session, User, world.customer.id)
        assert user["status"] is UserStatus.DELETED
        assert user["deleted_at"] is not None
        assert user["email"].endswith("@deleted.invalid")
        assert user["email"] != before["email"]
        for name in ("first_name", "last_name", "phone", "phone_verified_at", "home_city",
                     "home_state", "photo_key"):  # fmt: skip
            assert user[name] is None, name
        assert user["public_code"] != before["public_code"]
        assert user["password_hash"] != before["password_hash"]
        assert user["role"] is UserRole.CUSTOMER
        for (model, row_id), values in kept.items():
            assert await row_values(session, model, row_id) == values, model
        address = await row_values(session, Address, paid.request.address_id)
        assert (address["line1"], address["line2"], address["lat"], address["lng"]) == (
            ERASED_TEXT,
            None,
            None,
            None,
        )
        assert (address["city"], address["state"], address["zip_code"]) == (
            "Orlando",
            "FL",
            "32801",
        )
        request = await row_values(session, ServiceRequest, paid.request.id)
        assert (request["description"], request["intake_answers"]) == (ERASED_TEXT, {})
        points = (
            await session.execute(
                select(JobEvent.lat, JobEvent.lng).where(JobEvent.job_id == paid.job.id)
            )
        ).all()
        assert points
        assert all(point == (None, None) for point in points)
        cleanup = (
            await session.scalars(
                select(AccountDeletion).where(AccountDeletion.user_id == world.customer.id)
            )
        ).one()
        assert set(cleanup.storage_keys) == media_keys | {before["photo_key"]}
        assert cleanup.cards_detached_at is not None  # no Stripe Customer, nothing to detach
        assert cleanup.storage_deleted_at is None  # the worker's part
        # A copy was being made: the files' last pass waits for it to end.
        assert cleanup.storage_settled_after > datetime.now(UTC)
    [(actor, action, entity, audit_before, audit_after)] = world.audits
    assert (actor, action, entity) == (
        world.customer.id,
        AuditAction.ACCOUNT_DELETE,
        AuditEntity(AuditEntityType.USER, world.customer.id),
    )
    assert audit_before == {"role": "customer", "status": "active"}
    assert audit_after["status"] == "deleted"
    assert all(isinstance(value, int) for key, value in audit_after.items() if key != "status")
    assert world.queue.jobs == {
        f"account-cleanup:{world.customer.id}": (
            "clean_up_deleted_account",
            (str(world.customer.id),),
        )
    }

    # The pro of that past job still sees it, with the customer shown as deleted.
    pro_view = await world.client.get(f"/v1/pros/me/jobs/{paid.job.id}", headers=world.pro.headers)
    assert pro_view.status_code == 200, pro_view.text
    assert pro_view.json()["customer_first_name"] == DELETED_USER_NAME
    assert pro_view.json()["address"]["line1"] == ERASED_TEXT
    assert world.sentinel not in pro_view.text


async def test_a_pros_profile_and_documents_go_and_the_customer_still_sees_the_job(
    world: World,
) -> None:
    async with world.sessions() as session:
        paid = await add_job(session, world)
        document_key = f"u/{world.pro.id}/pro_document/{uuid.uuid4().hex}.pdf"
        session.add(
            ProDocument(
                pro_id=world.pro_profile_id, doc_type=ProDocumentType.ID, file_key=document_key
            )
        )
        await session.commit()
        photo_key = (await row_values(session, ProProfile, world.pro_profile_id))["photo_key"]

    response = await delete_account(world.client, world.pro)

    assert response.status_code == 204, response.text
    async with world.sessions() as session:
        assert await sweep(session, world.pro_sentinel) == set()
        profile = await row_values(session, ProProfile, world.pro_profile_id)
        assert (profile["bio"], profile["photo_key"]) == (None, None)
        for model in (ProDocument, ProCategory):
            rows = await session.scalars(select(model).where(model.pro_id == world.pro_profile_id))
            assert list(rows) == [], model
        cleanup = (
            await session.scalars(
                select(AccountDeletion).where(AccountDeletion.user_id == world.pro.id)
            )
        ).one()
        assert set(cleanup.storage_keys) == {document_key, photo_key}
    customer_view = await world.client.get(
        f"/v1/requests/{paid.request.id}/job", headers=world.customer.headers
    )
    assert customer_view.status_code == 200, customer_view.text
    assert customer_view.json()["pro"]["name"] == DELETED_USER_NAME


async def test_a_customers_open_requests_are_cancelled(world: World) -> None:
    async with world.sessions() as session:
        open_ids = [
            (await add_request(session, world, status)).id
            for status in (
                RequestStatus.RECEIVED,
                RequestStatus.FINDING_PRO,
                RequestStatus.QUOTE_READY,
            )
        ]
        await session.commit()

    assert (await delete_account(world.client, world.customer)).status_code == 204

    async with world.sessions() as session:
        statuses = await session.scalars(
            select(ServiceRequest.status).where(ServiceRequest.id.in_(open_ids))
        )
        assert set(statuses) == {RequestStatus.CANCELLED}
    assert world.audits[0][4]["requests_cancelled"] == len(open_ids)


# What refuses a deletion: each case leaves the account exactly as it was.


async def customer_scheduled_job(session: AsyncSession, world: World) -> None:
    await add_job(session, world, JobStatus.SCHEDULED)


async def customer_completed_job(session: AsyncSession, world: World) -> None:
    await add_job(session, world, JobStatus.COMPLETED)


async def customer_open_dispute(session: AsyncSession, world: World) -> None:
    paid = await add_job(session, world, JobStatus.DISPUTED)
    session.add(
        Dispute(
            job_id=paid.job.id,
            opened_by=world.customer.id,
            reason_code=next(iter(DisputeReason)),
            description="Not fixed",
            status=DisputeStatus.OPEN,
        )
    )


async def customer_refund_pending(session: AsyncSession, world: World) -> None:
    paid = await add_job(session, world, JobStatus.CANCELLED)
    session.add(
        Refund(
            job_id=paid.job.id,
            payment_id=paid.payment.id,
            amount_cents=PRICE,
            currency="usd",
            status=RefundStatus.PENDING,
            idempotency_key=f"cancel:{paid.job.id}:refund",
        )
    )


async def customer_payment_in_progress(session: AsyncSession, world: World) -> None:
    request = await add_request(session, world)
    quote = await add_quote(session, world, request)
    session.add(
        Payment(
            request_id=request.id,
            quote_id=quote.id,
            customer_id=world.customer.id,
            amount_cents=PRICE,
            tax_cents=TAX,
            customer_total_cents=PRICE + TAX,
            platform_fee_cents=FEE,
            pro_payout_cents=PRICE - FEE,
            take_rate_bps=1500,
            currency="usd",
            status=PaymentStatus.PROCESSING,
        )
    )


async def pro_confirmed_job(session: AsyncSession, world: World) -> None:
    await add_job(session, world, JobStatus.CONFIRMED)


async def pro_transfer_pending(session: AsyncSession, world: World) -> None:
    paid = await add_job(session, world)
    session.add(
        Transfer(
            job_id=paid.job.id,
            payment_id=paid.payment.id,
            pro_id=world.pro_profile_id,
            amount_cents=PRICE - FEE,
            currency="usd",
            status=TransferStatus.FAILED,
            idempotency_key=f"transfer:{paid.job.id}",
        )
    )


async def pro_pending_quote(session: AsyncSession, world: World) -> None:
    request = await add_request(session, world, RequestStatus.QUOTE_READY)
    await add_quote(session, world, request, QuoteStatus.PENDING)


async def pro_accepted_quote_being_paid(session: AsyncSession, world: World) -> None:
    request = await add_request(session, world)
    await add_quote(session, world, request)


@pytest.mark.parametrize(
    ("who", "plant", "code"),
    [
        ("customer", customer_scheduled_job, "active_job"),
        ("customer", customer_completed_job, "active_job"),
        ("customer", customer_open_dispute, "open_dispute"),
        ("customer", customer_refund_pending, "refund_pending"),
        ("customer", customer_payment_in_progress, "payment_in_progress"),
        ("pro", pro_confirmed_job, "active_job"),
        ("pro", pro_transfer_pending, "payout_pending"),
        ("pro", pro_pending_quote, "active_quote"),
        ("pro", pro_accepted_quote_being_paid, "active_quote"),
    ],
)
async def test_a_deletion_waits_while_something_is_in_flight(
    world: World,
    who: str,
    plant: Callable[[AsyncSession, World], Any],
    code: str,
) -> None:
    account = world.customer if who == "customer" else world.pro
    async with world.sessions() as session:
        await plant(session, world)
        await session.commit()
        before = await row_values(session, User, account.id)

    response = await delete_account(world.client, account)

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == code
    async with world.sessions() as session:
        assert await row_values(session, User, account.id) == before
        rows = await session.scalars(
            select(AccountDeletion).where(AccountDeletion.user_id == account.id)
        )
        assert list(rows) == []
    assert world.audits == []
    assert (await world.client.get("/v1/auth/me", headers=account.headers)).status_code == 200


async def test_a_wrong_password_is_refused_and_tries_are_limited(world: World) -> None:
    async with world.sessions() as session:
        before = await row_values(session, User, world.customer.id)

    responses = [
        await delete_account(world.client, world.customer, "not the password")
        for _ in range(RATE_LIMIT + 1)
    ]

    assert [r.status_code for r in responses] == [403] * RATE_LIMIT + [429]
    assert responses[0].json()["error"]["code"] == "invalid_password"
    async with world.sessions() as session:
        assert await row_values(session, User, world.customer.id) == before
    assert world.audits == []


async def test_a_staff_account_is_refused(world: World) -> None:
    response = await world.client.post(
        "/v1/me/delete",
        json={"password": PASSWORD},
        headers=headers_for(world.agent_id, UserRole.AGENT),
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "staff_account"


# After a deletion.


async def test_a_deleted_account_cannot_sign_in_and_its_email_signs_up_anew(world: World) -> None:
    second_session = await world.client.post(
        "/v1/auth/login", json={"email": world.customer.email, "password": PASSWORD}
    )
    assert second_session.status_code == 200
    assert (await delete_account(world.client, world.customer)).status_code == 204
    # Read before any refresh: a refresh of a deleted account would revoke its family itself.
    async with world.sessions() as session:
        sessions = list(
            await session.scalars(
                select(RefreshToken.revoked_at).where(RefreshToken.user_id == world.customer.id)
            )
        )
    assert len(sessions) == 2
    assert all(at is not None for at in sessions)  # every session of the account ended

    login = await world.client.post(
        "/v1/auth/login", json={"email": world.customer.email, "password": PASSWORD}
    )
    refreshed = await world.client.post(
        "/v1/auth/refresh", json={"refresh_token": world.customer.refresh}
    )
    me = await world.client.get("/v1/auth/me", headers=world.customer.headers)
    again = await sign_up(world.client, "customer", world.customer.email)
    world.users.append(again.id)

    assert (login.status_code, login.json()["error"]["code"]) == (401, "invalid_credentials")
    assert refreshed.status_code == 401
    assert (me.status_code, me.json()["error"]["code"]) == (401, "invalid_token")
    assert again.id != world.customer.id
    assert (await world.client.get("/v1/auth/me", headers=again.headers)).status_code == 200


async def test_a_replay_after_the_deletion_changes_nothing(world: World) -> None:
    assert (await delete_account(world.client, world.customer)).status_code == 204
    async with world.sessions() as session:
        before = await row_values(session, User, world.customer.id)

    replay = await delete_account(world.client, world.customer)

    assert (replay.status_code, replay.json()["error"]["code"]) == (401, "invalid_token")
    async with world.sessions() as session:
        assert await row_values(session, User, world.customer.id) == before
    assert len(world.audits) == 1


async def test_two_deletions_at_once_delete_once(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The first holds the user's row; the second, authenticated already, waits for it (Postgres
    # reports the wait), then finds the account deleted and answers the same.
    from app.modules.users.service import UserService

    original = UserService.get_for_update
    entered: list[str] = []
    first_locked = asyncio.Event()
    second_waiting = asyncio.Event()
    pids: dict[str, int] = {}

    async def interleaved(self: UserService, user_id: uuid.UUID) -> Any:
        # The order of arrival, taken before any await: one first, one second.
        role = "first" if not entered else "second"
        entered.append(role)
        if role == "first":
            locked = await original(self, user_id)
            pids["first"] = await backend_pid(self._session)
            first_locked.set()
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                await second_waiting.wait()
            await wait_until_blocked(world.sessions, waiter=pids["second"], holder=pids["first"])
            return locked
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            await first_locked.wait()
        # Read inside the transaction that will wait: it keeps its connection until its end.
        pids["second"] = await backend_pid(self._session)
        second_waiting.set()
        return await original(self, user_id)

    monkeypatch.setattr(UserService, "get_for_update", interleaved)

    first, second = await asyncio.gather(
        delete_account(world.client, world.customer), delete_account(world.client, world.customer)
    )

    assert (first.status_code, second.status_code) == (204, 204)
    assert len(world.audits) == 1
    async with world.sessions() as session:
        rows = await session.scalars(
            select(AccountDeletion).where(AccountDeletion.user_id == world.customer.id)
        )
        assert len(list(rows)) == 1


# The worker's part (accounts.cleanup): the cards in Stripe and the files in storage.


@dataclass
class FakeStorage:
    """The storage port's listing and delete: `objects` are what it holds, each delete is
    recorded; `failure` makes every call raise it."""

    objects: set[str] = field(default_factory=set)
    deleted: list[list[str]] = field(default_factory=list)
    failure: Exception | None = None

    def list_older_than(self, prefix: str, before: datetime) -> Iterator[ObjectPage]:
        if self.failure is not None:
            raise self.failure
        listed = [StoredObject(key, datetime.now(UTC)) for key in sorted(self.objects)]
        yield ObjectPage(objects=[o for o in listed if o.key.startswith(prefix)], newer=0)

    def delete_many(self, keys: Any) -> DeleteResult:
        if self.failure is not None:
            raise self.failure
        self.deleted.append(sorted(keys))
        self.objects -= set(keys)
        return DeleteResult(deleted=len(keys), failed=0)


def worker_ctx(
    world: World, settings: Any, storage: FakeStorage, methods: FakeStripePaymentMethods
) -> dict[str, Any]:
    return {
        "session_factory": world.sessions,
        "settings": settings,
        "storage": storage,
        "stripe_payment_methods": methods,
    }


async def cleanup_row(world: World, user_id: uuid.UUID) -> AccountDeletion:
    async with world.sessions() as session:
        statement = (
            select(AccountDeletion)
            .where(AccountDeletion.user_id == user_id)
            .execution_options(populate_existing=True)
        )
        return (await session.scalars(statement)).one()


async def with_card_and_photo(world: World, methods: FakeStripePaymentMethods) -> tuple[str, str]:
    """The customer's Stripe Customer, with two cards, and an ID photo: (customer id, key)."""
    customer_id = f"cus_{uuid.uuid4().hex[:14]}"
    photo_key = f"u/{world.customer.id}/profile_photo/{uuid.uuid4().hex}.jpg"
    async with world.sessions() as session:
        await session.execute(
            update(User)
            .where(User.id == world.customer.id)
            .values(stripe_customer_id=customer_id, photo_key=photo_key)
        )
        await session.commit()
    methods.add_card(customer_id)
    methods.add_card(customer_id)
    return customer_id, photo_key


async def make_due(world: World, user_id: uuid.UUID, settings: Any) -> None:
    """As if the retry wait had passed since the last attempt, and any copy had ended."""
    past = datetime.now(UTC) - timedelta(minutes=settings.account_deletion_retry_after_minutes + 1)
    async with world.sessions() as session:
        await session.execute(
            update(AccountDeletion)
            .where(AccountDeletion.user_id == user_id)
            .values(last_attempt_at=past, storage_settled_after=past, erase_settled_after=past)
        )
        await session.commit()


async def test_the_worker_detaches_the_cards_and_deletes_the_files(
    world: World, settings: Any
) -> None:
    methods, storage = FakeStripePaymentMethods(), FakeStorage()
    customer_id, photo_key = await with_card_and_photo(world, methods)
    assert (await delete_account(world.client, world.customer)).status_code == 204
    pending = await cleanup_row(world, world.customer.id)
    assert (pending.cards_detached_at, pending.storage_deleted_at) == (None, None)

    await clean_up_deleted_account(
        worker_ctx(world, settings, storage, methods), str(world.customer.id)
    )

    assert methods.attached(customer_id) == []
    assert storage.deleted == [[photo_key]]
    done = await cleanup_row(world, world.customer.id)
    assert done.cards_detached_at is not None
    assert done.storage_deleted_at is not None
    assert done.storage_keys == []  # the keys name the user: not kept once the files are gone
    assert (done.attempts, done.last_error) == (1, None)
    # Nothing left: another run does nothing.
    calls = len(methods.calls)
    await clean_up_deleted_account(
        worker_ctx(world, settings, storage, methods), str(world.customer.id)
    )
    assert (len(methods.calls), len(storage.deleted)) == (calls, 1)
    assert (await cleanup_row(world, world.customer.id)).attempts == 1


async def test_what_the_worker_could_not_do_is_finished_by_the_sweep(
    world: World, settings: Any
) -> None:
    methods = FakeStripePaymentMethods(errors={"list_cards": StripeUnavailableError()})
    storage = FakeStorage(failure=StorageUnavailableError("down: test"))
    customer_id, photo_key = await with_card_and_photo(world, methods)
    assert (await delete_account(world.client, world.customer)).status_code == 204
    ctx = worker_ctx(world, settings, storage, methods)

    await clean_up_deleted_account(ctx, str(world.customer.id))
    failed = await cleanup_row(world, world.customer.id)
    # Within the retry wait neither the sweep nor another task takes it (the claim).
    await retry_account_cleanups(ctx)
    await clean_up_deleted_account(ctx, str(world.customer.id))
    waited = await cleanup_row(world, world.customer.id)
    methods.errors.clear()
    storage.failure = None
    await make_due(world, world.customer.id, settings)
    await retry_account_cleanups(ctx)

    assert (failed.cards_detached_at, failed.storage_deleted_at) == (None, None)
    assert failed.last_error == "StripeUnavailableError"
    assert waited.attempts == failed.attempts == 1
    assert methods.attached(customer_id) == []
    assert storage.deleted == [[photo_key]]
    done = await cleanup_row(world, world.customer.id)
    assert done.cards_detached_at is not None
    assert done.storage_deleted_at is not None
    assert (done.attempts, done.last_error) == (2, None)


async def test_a_copy_still_being_made_keeps_the_files_last_pass_for_after_it(
    world: World, settings: Any
) -> None:
    methods, storage = FakeStripePaymentMethods(), FakeStorage()
    async with world.sessions() as session:
        paid = await add_job(session, world)
        pending = RequestMedia(
            request_id=paid.request.id,
            kind=RequestMediaKind.PHOTO,
            file_key=f"u/{world.customer.id}/request_media/{uuid.uuid4().hex}.jpg",
        )
        session.add(pending)
        await session.commit()
    assert (await delete_account(world.client, world.customer)).status_code == 204
    ctx = worker_ctx(world, settings, storage, methods)

    await clean_up_deleted_account(ctx, str(world.customer.id))
    early = await cleanup_row(world, world.customer.id)
    await make_due(world, world.customer.id, settings)
    await retry_account_cleanups(ctx)

    expected = sorted(
        [pending.file_key, *(safe_key_for(pending.id, ext) for ext in SAFE_EXTENSIONS)]
    )
    # The first pass deleted them, but the copy could still upload: it was not the last.
    assert early.storage_deleted_at is None
    assert early.storage_keys == expected
    assert storage.deleted == [expected, expected]
    assert (await cleanup_row(world, world.customer.id)).storage_deleted_at is not None


async def test_a_lost_queue_leaves_the_cleanup_to_the_sweep(
    world: World, settings: Any, caplog: pytest.LogCaptureFixture
) -> None:
    world.queue.failure = RedisError("down: test")
    methods, storage = FakeStripePaymentMethods(), FakeStorage()

    with caplog.at_level(logging.ERROR):
        response = await delete_account(world.client, world.customer)
    await retry_account_cleanups(worker_ctx(world, settings, storage, methods))

    assert response.status_code == 204
    assert [r for r in caplog.records if r.message == "account_cleanup_enqueue_failed"]
    done = await cleanup_row(world, world.customer.id)
    assert (done.cards_detached_at is not None, done.storage_deleted_at is not None) == (True, True)


# The audit row itself, on the rolled-back session (committed tests record it instead).


async def test_the_deletion_is_audited_with_ids_and_counts_only(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    app.dependency_overrides[get_rate_limiter] = lambda: InMemoryRateLimiter(clock=lambda: 1_000.0)
    app.dependency_overrides[get_job_queue] = lambda: RecordingQueue()
    email = f"audit-{uuid.uuid4().hex[:12]}@example.com"
    account = await sign_up(db_client, "customer", email)

    response = await delete_account(db_client, account)

    assert response.status_code == 204, response.text
    [row] = await db_session.scalars(
        select(AuditLog).where(AuditLog.action == "user.delete", AuditLog.entity_id == account.id)
    )
    assert (row.actor_user_id, row.entity_type, row.reason) == (account.id, "user", None)
    assert row.before == {"role": "customer", "status": "active"}
    assert row.after is not None
    assert row.after["status"] == "deleted"
    assert email not in json.dumps([row.before, row.after])


# What the review of #97 found: writes that land after the deletion, files nothing references,
# a request accepted with nothing paid, another account's entries, a deleted pro's quote.


async def test_a_write_that_lands_after_the_deletion_is_erased_by_the_second_pass(
    world: World, settings: Any
) -> None:
    # A request the account sent before the deletion committed waits on its lock, then writes:
    # done here by hand, after the commit, as such a request would.
    assert (await delete_account(world.client, world.customer)).status_code == 204
    async with world.sessions() as session:
        await session.execute(
            update(User)
            .where(User.id == world.customer.id)
            .values(first_name=f"Ann{world.sentinel}", phone=world.phone)
        )
        late = await add_request(session, world, RequestStatus.RECEIVED)
        session.add_all(
            [
                Device(
                    user_id=world.customer.id,
                    expo_push_token=f"ExponentPushToken[{world.sentinel}]",
                    platform=DevicePlatform.ANDROID,
                    last_seen_at=datetime.now(UTC),
                ),
                SavedAddress(
                    user_id=world.customer.id,
                    label="Work",
                    line1=f"{world.sentinel} Pine Rd",
                    city="Orlando",
                    state="FL",
                    zip_code="32801",
                ),
            ]
        )
        await session.commit()
        assert ("users", "first_name") in await sweep(session, world.sentinel, world.phone)

    await clean_up_deleted_account(
        worker_ctx(world, settings, FakeStorage(), FakeStripePaymentMethods()),
        str(world.customer.id),
    )

    async with world.sessions() as session:
        assert await sweep(session, world.sentinel, world.phone) == set()
        status = await session.scalar(
            select(ServiceRequest.status).where(ServiceRequest.id == late.id)
        )
        assert status is RequestStatus.CANCELLED
    row = await cleanup_row(world, world.customer.id)
    assert row.erased_again_at is not None


async def test_every_upload_under_the_accounts_prefix_goes_but_job_and_dispute_photos(
    world: World, settings: Any
) -> None:
    mine, theirs = world.customer.id, world.pro.id
    replaced = f"u/{mine}/profile_photo/{uuid.uuid4().hex}.jpg"  # an ID photo replaced since
    draft = f"u/{mine}/request_media/{uuid.uuid4().hex}.jpg"  # removed before the request
    evidence = f"u/{mine}/dispute_photo/{uuid.uuid4().hex}.jpg"
    other = f"u/{theirs}/profile_photo/{uuid.uuid4().hex}.jpg"
    storage = FakeStorage(objects={replaced, draft, evidence, other})
    assert (await delete_account(world.client, world.customer)).status_code == 204

    await clean_up_deleted_account(
        worker_ctx(world, settings, storage, FakeStripePaymentMethods()), str(mine)
    )

    assert storage.objects == {evidence, other}
    assert (await cleanup_row(world, mine)).storage_deleted_at is not None


async def test_an_accepted_request_with_nothing_paid_is_cancelled_and_frees_its_pro(
    world: World,
) -> None:
    async with world.sessions() as session:
        request = await add_request(session, world)  # accepted: the payment sheet never ran
        quote = await add_quote(session, world, request)
        await session.commit()

    customer = await delete_account(world.client, world.customer)
    pro = await delete_account(world.client, world.pro)

    assert (customer.status_code, pro.status_code) == (204, 204), (customer.text, pro.text)
    async with world.sessions() as session:
        status = await session.scalar(
            select(ServiceRequest.status).where(ServiceRequest.id == request.id)
        )
        quote_status = await session.scalar(select(Quote.status).where(Quote.id == quote.id))
    assert status is RequestStatus.CANCELLED
    assert quote_status is QuoteStatus.ACCEPTED  # kept untouched: the request holds it no more


async def test_another_accounts_waitlist_entry_with_the_same_email_stays(world: World) -> None:
    async with world.sessions() as session:
        # The pro, signed in, typed the customer's email (a household member).
        session.add(
            WaitlistEntry(
                user_id=world.pro.id,
                zip_code="00011",
                email=world.customer.email,
                source=next(iter(WaitlistSource)),
            )
        )
        await session.commit()

    assert (await delete_account(world.client, world.customer)).status_code == 204

    async with world.sessions() as session:
        owners = list(
            await session.scalars(
                select(WaitlistEntry.user_id).where(WaitlistEntry.zip_code == "00011")
            )
        )
    assert owners == [world.pro.id]


async def test_a_deleted_pros_quote_is_never_hired(world: World) -> None:
    assert (await delete_account(world.client, world.pro)).status_code == 204
    async with world.sessions() as session:
        # A quote a request in flight inserted after the deletion.
        request = await add_request(session, world, RequestStatus.QUOTE_READY)
        await add_quote(session, world, request, QuoteStatus.PENDING)
        await session.commit()

    listed = await world.client.get(
        f"/v1/requests/{request.id}/quotes", headers=world.customer.headers
    )

    assert listed.status_code == 200, listed.text
    assert listed.json()["items"] == []
