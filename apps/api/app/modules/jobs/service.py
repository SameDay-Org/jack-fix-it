"""JobStateMachine: the only code that changes jobs.status (D12.1, #60; AGENTS.md).

Every change follows TRANSITIONS (transitions.py), locks the job row, writes one job_events row
in the same transaction, and answers:
- 404 for an unknown job, and for a customer or pro who is not the job's own (checked first, so
  a stranger never learns the job's state);
- 409 `invalid_transition` for an edge not in the table, including from a terminal status;
- 403 for an actor kind the edge does not allow.
A rejected transition changes nothing and writes no event.

A job that leaves on_the_way loses the pro's live position (#350, location.py): the machine
deletes it under the row lock, before the caller commits. So it is built with the location
store wherever a job can leave on_the_way; one built without it refuses that move
(RuntimeError, nothing written) instead of leaving a position behind.

The caller owns the transaction: transition() flushes and never commits, so a feature can
change a job together with its own rows (payments, photos, disputes) atomically.

JobScheduler creates a job (#61, once its payment succeeds): inserted in its default status,
scheduled, with a `created` event, in the caller's transaction. Creating is not a status change,
so the database guard lets the insert through.
"""

import uuid
from collections.abc import AsyncIterator, Collection
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Final

from sqlalchemy import Subquery, text
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import ForbiddenError, NotFoundError
from app.modules.jobs.errors import InvalidTransitionError
from app.modules.jobs.location import JobLocationStore, forget_position
from app.modules.jobs.models import Job, JobEvent

# Re-exported: other modules name a job's status through this module (ADR 0003).
from app.modules.jobs.models import JobStatus as JobStatus
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.transitions import CHAT_OPEN, REVIEWABLE, TRANSITIONS, ActorKind
from app.modules.pros.service import ProService
from app.modules.users.types import UserAccount, UserRole

STATUS_CHANGED: Final = "status_changed"
# The first event of every job: no from_status, to_status scheduled.
CREATED: Final = "created"


# The database guard (#163): triggers on service_requests and jobs refuse a status change unless
# this transaction's app.status_writer names that very row ('<table>:<id>'). Only the state
# machines set it, around their own write (the static guard flags it anywhere else).
@asynccontextmanager
async def _status_writer(session: AsyncSession, job: Job) -> AsyncIterator[None]:
    """Lets the block change this one job's status past the database guard.

    The token names the row, so the trigger refuses any other row or table that the block's
    flush might carry; and the unit of work must hold nothing but this job when the window
    opens (transition() drains it first), so that flush writes this row alone. The token is
    local to the transaction (is_local), so it never reaches another one on a pooled
    connection, and it is cleared when the block ends, even when it fails. If the failure
    aborted the transaction, it cannot be cleared here, but it goes with that transaction's
    rollback."""
    _require_clean(session, job)
    # Only here: the static guard allows this flag in this function alone (ALLOW_LIST).
    set_writer = text("SELECT set_config('app.status_writer', :value, true)")
    await session.execute(set_writer, {"value": f"{Job.__tablename__}:{job.id}"})
    try:
        yield
    finally:
        try:
            await session.execute(set_writer, {"value": ""})
        except PendingRollbackError:
            pass  # the flush failed: the transaction, and the flag with it, will roll back
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) != _IN_FAILED_TRANSACTION:
                raise


def _require_clean(session: AsyncSession, job: Job) -> None:
    """Nothing but the target job may be pending when its status window opens."""
    pending = [row for row in session.dirty if row is not job and session.is_modified(row)]
    if session.new or session.deleted or pending:
        raise RuntimeError("pending writes in the unit of work when a status window opens")


# Postgres refuses every statement in a transaction that already failed.
_IN_FAILED_TRANSACTION: Final = "25P02"


@dataclass(frozen=True)
class SystemActor:
    """A worker acting on its own (48 h auto-confirm, transfers): events get no actor_id."""


SYSTEM: Final = SystemActor()


@dataclass(frozen=True)
class AdminDecision:
    """An admin's recorded decision that is carried out later (#76: a dispute resolved with a
    release moves its job disputed -> paid_out once the transfer is made; a full refund moves it
    disputed -> refunded once Stripe gave the money back). Acts as the admin who decided
    (`admin_id`, kept on the dispute), and the event names them."""

    admin_id: uuid.UUID


_ACTOR_KIND_BY_ROLE: Final = {
    UserRole.CUSTOMER: ActorKind.CUSTOMER,
    UserRole.PRO: ActorKind.PRO,
    UserRole.ADMIN: ActorKind.ADMIN,
    # Agents (BDC) take no part in a job's status.
}

# The timestamp each status sets on entry, once.
_ENTRY_TIMESTAMPS: Final = {
    JobStatus.IN_PROGRESS: "started_at",
    JobStatus.COMPLETED: "completed_at",
    JobStatus.CONFIRMED: "confirmed_at",
}


class JobStateMachine:
    def __init__(
        self,
        session: AsyncSession,
        pros: ProService,
        locations: JobLocationStore | None = None,
    ) -> None:
        self._session = session
        self._jobs = JobRepository(session)
        self._pros = pros
        self._locations = locations

    async def transition(
        self,
        job_id: uuid.UUID,
        to: JobStatus,
        actor: UserAccount | SystemActor | AdminDecision,
        *,
        lat: Decimal | None = None,
        lng: Decimal | None = None,
        event_type: str = STATUS_CHANGED,
    ) -> JobStatus:
        """Moves the job to `to` and returns its new status. It returns a value, not the ORM
        row, so no caller holds a Job whose status it could write past the table."""
        # Drain the unit of work first, outside any window: a pending status write anywhere
        # (this job included) hits the database guard here, unauthorized, instead of riding
        # along with this transition's flush or being taken for its starting status.
        await self._session.flush()
        job = await self._jobs.get_for_update(job_id)
        if job is None:
            raise NotFoundError
        kind = await self._actor_kind(job, actor)
        allowed = TRANSITIONS.get((job.status, to))
        if allowed is None:
            raise InvalidTransitionError
        if kind is None or kind not in allowed:
            raise ForbiddenError

        from_status = job.status
        if from_status is JobStatus.ON_THE_WAY:
            # The pro's live position ends with on_the_way (#350): deleted under the row lock,
            # which holds every ping off until the caller commits.
            await forget_position(self._locations, job.id)
        now = datetime.now(UTC)
        timestamp = _ENTRY_TIMESTAMPS.get(to)
        if timestamp is not None and getattr(job, timestamp) is None:
            setattr(job, timestamp, now)
        async with _status_writer(self._session, job):
            job.status = to
            await self._session.flush()
        await self._jobs.add_event(
            JobEvent(
                job_id=job.id,
                type=event_type,
                from_status=from_status,
                to_status=to,
                actor_id=_actor_id(actor),
                lat=lat,
                lng=lng,
            )
        )
        return to

    async def _actor_kind(
        self, job: Job, actor: UserAccount | SystemActor | AdminDecision
    ) -> ActorKind | None:
        """The actor's kind for this job. 404 for a customer or pro who is not the job's own."""
        if isinstance(actor, SystemActor):
            return ActorKind.SYSTEM
        if isinstance(actor, AdminDecision):
            return ActorKind.ADMIN
        kind = _ACTOR_KIND_BY_ROLE.get(actor.role)
        if kind is ActorKind.CUSTOMER and actor.id != job.customer_id:
            raise NotFoundError
        if kind is ActorKind.PRO:
            profile_id = await self._pros.get_profile_id_for_user(actor.id)
            if profile_id != job.pro_id:
                raise NotFoundError
        return kind


def _actor_id(actor: UserAccount | SystemActor | AdminDecision) -> uuid.UUID | None:
    if isinstance(actor, SystemActor):
        return None
    if isinstance(actor, AdminDecision):
        return actor.admin_id
    return actor.id


def job_metric_facts() -> Subquery:
    """Each job's ids, times and money as JobRepository.metric_facts names them, as a subquery
    for the staff metrics' own query (#84)."""
    return JobRepository.metric_facts()


@dataclass(frozen=True)
class NewJob:
    """What a job is created with: its parties and the amounts frozen at payment (#61)."""

    request_id: uuid.UUID
    quote_id: uuid.UUID
    customer_id: uuid.UUID
    pro_id: uuid.UUID
    customer_price_cents: int
    pro_payout_cents: int
    platform_fee_cents: int
    tax_cents: int


class JobScheduler:
    """Creates jobs (#61). The caller owns the transaction: it flushes and never commits."""

    def __init__(self, session: AsyncSession) -> None:
        self._jobs = JobRepository(session)

    async def has_job(self, request_id: uuid.UUID) -> bool:
        """Whether the request has a job already (one per request)."""
        return await self._jobs.exists_for_request(request_id)

    async def schedule(self, new: NewJob) -> uuid.UUID:
        """Inserts the job, scheduled (the column's default), and its `created` event by the
        system; returns the job's id."""
        job = await self._jobs.add(
            Job(
                request_id=new.request_id,
                quote_id=new.quote_id,
                customer_id=new.customer_id,
                pro_id=new.pro_id,
                customer_price_cents=new.customer_price_cents,
                pro_payout_cents=new.pro_payout_cents,
                platform_fee_cents=new.platform_fee_cents,
                tax_cents=new.tax_cents,
            )
        )
        await self._jobs.add_event(
            JobEvent(
                job_id=job.id,
                type=CREATED,
                from_status=None,
                to_status=JobStatus.SCHEDULED,
                actor_id=None,
            )
        )
        return job.id


@dataclass(frozen=True)
class JobParties:
    """Who takes part in a job, for the chat (#71) and the reviews (#77): the customer's and
    the pro's user ids, whether the job still accepts messages (CHAT_OPEN) and whether its
    two sides may review each other (is_reviewable)."""

    job_id: uuid.UUID
    customer_id: uuid.UUID
    pro_user_id: uuid.UUID
    chat_open: bool
    reviewable: bool


def is_reviewable(job: Job) -> bool:
    """Whether the job was confirmed, by the customer (#66) or by the 48 h auto-confirm (#67):
    confirmed, or paid out after that confirmation. A job paid out by an admin's release of a
    dispute was never confirmed (confirmed_at is set on entering confirmed only), and neither
    was any earlier, disputed, refunded or cancelled one. Once true it stays true: confirmed
    leads to paid_out alone, which is terminal, and confirmed_at is never cleared."""
    if job.status is JobStatus.PAID_OUT:
        return job.confirmed_at is not None
    return job.status in REVIEWABLE


@dataclass(frozen=True)
class StaffJobEvent:
    """One line of a job's history as staff read it in the request card (#81): what happened
    and when. Never the check-in's coordinates, and no actor beyond "the system or a person"."""

    type: str
    from_status: JobStatus | None
    to_status: JobStatus | None
    by_system: bool
    created_at: datetime


@dataclass(frozen=True)
class StaffJob:
    """A request's job for the operations queue's card (#81): ids, status and dates. No money,
    no arrival code, no position."""

    id: uuid.UUID
    status: JobStatus
    pro_id: uuid.UUID
    quote_id: uuid.UUID
    started_at: datetime | None
    completed_at: datetime | None
    confirmed_at: datetime | None
    created_at: datetime
    events: tuple[StaffJobEvent, ...]  # oldest first


class JobStaffReader:
    """A request's job for staff, for another module (the operations queue, #81). Reads only:
    the caller checks that the reader is staff."""

    def __init__(self, session: AsyncSession) -> None:
        self._jobs = JobRepository(session)

    @staticmethod
    def queue_facts() -> Subquery:
        """Each job's request (`request_id`), id (`job_id`), accepted quote (`quote_id`) and
        status (`job_status`), as a subquery: the queue reads a request's bucket in its own
        query."""
        return JobRepository.queue_facts()

    async def of_request(self, request_id: uuid.UUID) -> StaffJob | None:
        """The request's job with its history, or None when it has none yet. Two queries."""
        job = await self._jobs.get_of_request(request_id)
        if job is None:
            return None
        return StaffJob(
            id=job.id,
            status=job.status,
            pro_id=job.pro_id,
            quote_id=job.quote_id,
            started_at=job.started_at,
            completed_at=job.completed_at,
            confirmed_at=job.confirmed_at,
            created_at=job.created_at,
            events=tuple(
                StaffJobEvent(
                    type=event.type,
                    from_status=event.from_status,
                    to_status=event.to_status,
                    by_system=event.actor_id is None,
                    created_at=event.created_at,
                )
                for event in await self._jobs.events_of(job.id)
            ),
        )


class JobPartiesReader:
    """The parties of a job, for another module (the chat, the reviews). Reads only."""

    def __init__(self, session: AsyncSession, pros: ProService) -> None:
        self._jobs = JobRepository(session)
        self._pros = pros

    @staticmethod
    def confirmations() -> Subquery:
        """Each job's id (`job_id`) and confirmation time (`confirmed_at`), as a subquery: a
        review's publication window is read in the reviews' own query (#77)."""
        return JobRepository.confirmations()

    async def parties(self, job_id: uuid.UUID, *, lock: bool = False) -> JobParties | None:
        """The job's parties, or None for an unknown job: for staff, who may read any job.
        One statement. With `lock`, the job row is held FOR NO KEY UPDATE until the caller's
        transaction ends: no status change can commit in between, so what `chat_open` says
        stays true until then (a status change waiting on the lock sees the caller's writes;
        one that committed first is what this reads)."""
        return await self._read(job_id, participant=None, lock=lock)

    async def parties_for(
        self, user_id: uuid.UUID, job_id: uuid.UUID, *, lock: bool = False
    ) -> JobParties | None:
        """The job's parties when `user_id` is one of them; None for any other job and for an
        unknown one alike, through the same single statement scoped to the caller: a job of
        others costs what an unknown id costs (#331, Vault round 1). `lock` as for `parties`."""
        return await self._read(job_id, participant=user_id, lock=lock)

    async def _read(
        self, job_id: uuid.UUID, *, participant: uuid.UUID | None, lock: bool
    ) -> JobParties | None:
        found = await self._jobs.get_with_pro_user(
            job_id, self._pros.users(), participant=participant, lock=lock
        )
        if found is None:
            return None
        job, pro_user_id = found
        return JobParties(
            job_id=job.id,
            customer_id=job.customer_id,
            pro_user_id=pro_user_id,
            chat_open=job.status in CHAT_OPEN,
            reviewable=is_reviewable(job),
        )


@dataclass(frozen=True)
class JobPayoutFacts:
    """What the transfer to the pro reads of a job (#68): who is paid, for which request and
    quote, whether the job is confirmed (so waiting for its transfer) or disputed (paid only
    once an admin resolved its dispute with a release, #76) and the pro's payout as frozen at
    payment."""

    job_id: uuid.UUID
    request_id: uuid.UUID
    quote_id: uuid.UUID
    pro_id: uuid.UUID
    confirmed: bool
    disputed: bool
    pro_payout_cents: int


class JobPayouts:
    """A job as its transfer sees it, for the payments module (#68): the read under the job's
    lock, and the one move a transfer makes, confirmed (or disputed, #76) -> paid_out, through
    the machine."""

    def __init__(self, session: AsyncSession, pros: ProService) -> None:
        self._jobs = JobRepository(session)
        self._machine = JobStateMachine(session, pros)

    @staticmethod
    def confirmed() -> Subquery:
        """The id (`job_id`), pro (`pro_id`), quote (`quote_id`) and frozen payout
        (`pro_payout_cents`) of every confirmed job, as a subquery: the transfer sweep reads
        the jobs still to pay in its own query."""
        return JobRepository.confirmed()

    @staticmethod
    def awaiting_transfer(released_disputes: Subquery) -> Subquery:
        """The same columns as `confirmed`, for every job waiting for its transfer: confirmed,
        or disputed with its dispute resolved by a release (`released_disputes`: job_id, #76)."""
        return JobRepository.awaiting_transfer(released_disputes)

    async def locked(self, job_id: uuid.UUID) -> JobPayoutFacts | None:
        """The job, its row locked FOR UPDATE until the caller's transaction ends (the lock
        every status change takes), read as last committed; None for an unknown job."""
        job = await self._jobs.get_for_update(job_id)
        if job is None:
            return None
        return JobPayoutFacts(
            job_id=job.id,
            request_id=job.request_id,
            quote_id=job.quote_id,
            pro_id=job.pro_id,
            confirmed=job.status is JobStatus.CONFIRMED,
            disputed=job.status is JobStatus.DISPUTED,
            pro_payout_cents=job.pro_payout_cents,
        )

    async def paid_out(self, job_id: uuid.UUID, by: SystemActor | AdminDecision = SYSTEM) -> None:
        """-> paid_out once the transfer to the pro was created: confirmed as the system, or
        disputed as the admin whose release it carries out (#76). The machine's transition
        (409 from any other status) with its job_events row. Flushes, never commits."""
        await self._machine.transition(job_id, JobStatus.PAID_OUT, by)

    async def exists(self, job_id: uuid.UUID) -> bool:
        return await self._jobs.get(job_id) is not None


@dataclass(frozen=True)
class JobDisputeFacts:
    """What a dispute reads of a job (#75): its parties, its request (for the push's public
    code), its status and when the pro marked it done (the dispute window starts there); for
    its resolution (#76), the accepted quote (its payment) and the pro's frozen payout."""

    job_id: uuid.UUID
    request_id: uuid.UUID
    customer_id: uuid.UUID
    pro_id: uuid.UUID
    pro_user_id: uuid.UUID
    status: JobStatus
    completed_at: datetime | None
    quote_id: uuid.UUID
    pro_payout_cents: int


class JobDisputes:
    """A job as its dispute sees it, for the disputes module (#75): the read under the job's
    lock, the parties' read, and the one move a report makes, completed -> disputed, through
    the machine with the customer as actor."""

    def __init__(self, session: AsyncSession, pros: ProService) -> None:
        self._jobs = JobRepository(session)
        self._pros = pros
        self._machine = JobStateMachine(session, pros)

    async def locked(self, job_id: uuid.UUID) -> JobDisputeFacts | None:
        """The job, its row locked FOR UPDATE until the caller's transaction ends (the lock
        every status change takes), read as last committed; None for an unknown job."""
        job = await self._jobs.get_for_update(job_id)
        if job is None:
            return None
        pro_user_id = await self._pros.user_id_of(job.pro_id)
        if pro_user_id is None:  # pragma: no cover - jobs.pro_id is a foreign key
            return None
        return _dispute_facts(job, pro_user_id)

    async def of_party(self, user_id: uuid.UUID, job_id: uuid.UUID) -> JobDisputeFacts | None:
        """The job when `user_id` is its customer or its pro; None for a job of others and an
        unknown one alike, through one statement (#331). Unlocked."""
        found = await self._jobs.get_with_pro_user(
            job_id, self._pros.users(), participant=user_id, lock=False
        )
        if found is None:
            return None
        job, pro_user_id = found
        return _dispute_facts(job, pro_user_id)

    async def disputed(self, job_id: uuid.UUID, customer: UserAccount) -> None:
        """completed -> disputed, the customer as actor: the machine's transition (409 from any
        other status, 403 for anyone but the job's customer) with its job_events row. Flushes,
        never commits."""
        await self._machine.transition(job_id, JobStatus.DISPUTED, customer)

    async def read_many(self, job_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, JobDisputeFacts]:
        """The jobs among `job_ids` by id, for staff (#76), who may read any job. One statement,
        unlocked."""
        found = await self._jobs.many_with_pro_user(job_ids, self._pros.users())
        return {job.id: _dispute_facts(job, pro_user_id) for job, pro_user_id in found}

    async def refunded(self, job_id: uuid.UUID, by: AdminDecision) -> None:
        """disputed -> refunded once Stripe gave the customer's money back (#76), as the admin
        whose full-refund decision it carries out (kept on the dispute and its refund, #433
        round 1): the machine's transition (409 from any other status) with its job_events row.
        Flushes, never commits."""
        await self._machine.transition(job_id, JobStatus.REFUNDED, by)


def _dispute_facts(job: Job, pro_user_id: uuid.UUID) -> JobDisputeFacts:
    return JobDisputeFacts(
        job_id=job.id,
        request_id=job.request_id,
        customer_id=job.customer_id,
        pro_id=job.pro_id,
        pro_user_id=pro_user_id,
        status=job.status,
        completed_at=job.completed_at,
        quote_id=job.quote_id,
        pro_payout_cents=job.pro_payout_cents,
    )
