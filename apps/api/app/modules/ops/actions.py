"""The BDC's actions on a request (D16.4, #82, part 1): an internal note, the first contact,
the category, a follow-up and its completion, and the follow-ups due.

Every write runs in one transaction under the request's row lock (the one the queue's claim
takes, so two staff members acting on one request take turns), and in that transaction:
- the holder rule of #81: an agent acts on a request nobody holds or they hold; one another
  agent holds is a 409 request_held (read it, claim it when it is released, or ask an admin);
  an admin acts on any request;
- the actor is checked again as an active agent or admin, read as last committed and
  share-locked until the commit (AuditService.current_staff): one demoted or suspended since
  they were authenticated gets 403 and nothing is written. Every decision a role makes (the
  holder rule, a follow-up for someone else, marking another's done) takes the role of that
  read, never the one the token was issued with: an admin demoted to agent since is an agent
  (#499 round 1). Each check comes before anything is written;
- one audit_log row with the actor and a before and after of ids, statuses and counts: never
  a note's text or a contact. An audit write that fails changes nothing.

- Note: plain text, 1 to 2000 characters, kept as written. Staff text: the chat redactor does
  not apply, and no customer or pro answer ever carries it. Appended only.
- Contacted: sets first_contact_at once; the queue's first-contact timer reads it. Again keeps
  the first value and writes nothing (no error). The audit row says who.
- Classify: sets the category only while the request is received or reviewing (409 after),
  to an active category (422 otherwise). It runs nothing else: dispatch reads the category
  when the request moves on.
- Follow-up: due in the future and at most OPS_FOLLOWUP_MAX_DAYS ahead; the caller's by
  default, someone else's only when an admin gives it, and only to an active agent or admin
  (also read share-locked, so the assignee cannot be demoted before the commit). Done by its
  assignee or an admin, once: again changes nothing, but the actor is checked first, so one
  revoked since gets 403 and no follow-up (#499 round 1 B3). The request's holder rule does
  not apply to marking one done: the follow-up is its assignee's.
- Who reads a follow-up (#499 round 1 B2): an agent only those assigned to them, an admin
  every one, on the request's card and in the list alike (repository.followups_visible_to).
  Internal notes stay shared by all staff.
- Due: the caller's follow-ups not done, due before the end of today in BUSINESS_TIME_ZONE
  (overdue included) or whenever, by due time, cursor paged. Only an admin may name an
  assignee (another staff member's, or their own): an agent naming one, even themselves, gets
  403. Each names its request by code and status: no contact.

Logs carry ids and actions only: never a note, a name or a contact.
"""

import base64
import binascii
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy import TIMESTAMP, Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ForbiddenError
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    ActorNotStaffError,
    AuditAction,
    AuditEntity,
    AuditEntityType,
    AuditState,
)
from app.modules.categories.service import CategoryService
from app.modules.ops.errors import (
    AssigneeNotStaffError,
    CategoryInactiveError,
    FollowupDueOutOfRangeError,
    FollowupNotFoundError,
    InvalidQueueQueryError,
    QueueRequestNotFoundError,
    RequestHeldError,
    RequestNotClassifiableError,
)
from app.modules.ops.models import RequestFollowup, RequestNote
from app.modules.ops.repository import FollowupRepository, NoteRepository
from app.modules.ops.schemas import (
    ClassifyOut,
    ContactedOut,
    FollowupDue,
    FollowupIn,
    FollowupItem,
    FollowupOut,
    FollowupsPage,
    FollowupsSummary,
    NoteOut,
    QueueAgent,
    StaffList,
    StaffMemberOut,
)
from app.modules.requests.queue import LockedRequest, RequestQueueReader, RequestStatus
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)

# The statuses a category may be set in: before dispatch takes the request.
CLASSIFIABLE: Final = frozenset({RequestStatus.RECEIVED, RequestStatus.REVIEWING})


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class ActionsConfig:
    followup_max_ahead: timedelta
    time_zone: str
    list_default_limit: int
    list_max_limit: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ActionsConfig":
        return cls(
            followup_max_ahead=timedelta(days=settings.ops_followup_max_days),
            time_zone=settings.business_time_zone,
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
        )


class OpsRecords:
    """A request's notes and follow-ups as its card shows them (staff only)."""

    def __init__(self, session: AsyncSession) -> None:
        self._notes = NoteRepository(session)
        self._followups = FollowupRepository(session)
        self._users = UserService(session)

    async def notes_of(self, request_id: uuid.UUID) -> list[NoteOut]:
        """Oldest first."""
        notes = await self._notes.of_request(request_id)
        agents = await self.agents({note.author_id for note in notes})
        return [
            NoteOut(
                id=note.id,
                author=agents[note.author_id],
                body=note.body,
                created_at=note.created_at,
            )
            for note in notes
        ]

    async def followups_of(self, request_id: uuid.UUID, viewer: UserAccount) -> list[FollowupOut]:
        """The ones `viewer` may read (repository.followups_visible_to), by due time. `viewer`
        is the account as the caller's transaction read it."""
        followups = await self._followups.of_request(request_id, viewer)
        agents = await self.agents({row.assigned_to for row in followups})
        return [_followup_out(row, agents[row.assigned_to]) for row in followups]

    async def agents(self, user_ids: set[uuid.UUID]) -> dict[uuid.UUID, QueueAgent]:
        names = await self._users.first_names(user_ids)
        return {user_id: QueueAgent(id=user_id, name=names.get(user_id)) for user_id in user_ids}


class OpsActions:
    def __init__(
        self,
        session: AsyncSession,
        config: ActionsConfig,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._clock = clock
        self._requests = RequestQueueReader(session)
        self._notes = NoteRepository(session)
        self._followups = FollowupRepository(session)
        self._categories = CategoryService(session)
        self._users = UserService(session)
        self._audit = AuditService(session)
        self._records = OpsRecords(session)

    async def add_note(self, staff: UserAccount, request_id: uuid.UUID, body: str) -> NoteOut:
        locked, _ = await self._acting(staff, request_id)
        note = await self._notes.add(
            RequestNote(request_id=locked.id, author_id=staff.id, body=body)
        )
        out = NoteOut(
            id=note.id,
            author=await self._agent(staff.id),
            body=note.body,
            created_at=note.created_at,
        )
        await self._audited(
            staff,
            AuditAction.REQUEST_NOTE_ADD,
            locked.id,
            {},
            {"note_id": str(note.id), "length": len(body)},
        )
        return out

    async def mark_contacted(self, staff: UserAccount, request_id: uuid.UUID) -> ContactedOut:
        locked, _ = await self._acting(staff, request_id)
        if locked.first_contact_at is not None:
            # Again: the first value stands, nothing is written; the row lock goes.
            await self._session.commit()
            return ContactedOut(id=locked.id, first_contact_at=locked.first_contact_at)
        now = self._clock()
        await self._requests.contacted(locked, now)
        await self._audited(
            staff,
            AuditAction.REQUEST_MARK_CONTACTED,
            locked.id,
            {"first_contact_at": None},
            {"first_contact_at": now.isoformat()},
        )
        return ContactedOut(id=locked.id, first_contact_at=now)

    async def classify(
        self, staff: UserAccount, request_id: uuid.UUID, category_id: uuid.UUID
    ) -> ClassifyOut:
        locked, _ = await self._acting(staff, request_id)
        if locked.status not in CLASSIFIABLE:
            await self._session.rollback()
            raise RequestNotClassifiableError
        if not await self._categories.is_active(category_id):
            await self._session.rollback()
            raise CategoryInactiveError
        [category] = await self._categories.summaries([category_id])
        if locked.category_id != category_id:
            before = None if locked.category_id is None else str(locked.category_id)
            await self._requests.classify(locked, category_id)
            await self._audited(
                staff,
                AuditAction.REQUEST_CLASSIFY,
                locked.id,
                {"category_id": before, "status": locked.status.value},
                {"category_id": str(category_id), "status": locked.status.value},
            )
        else:
            await self._session.commit()  # the same category again: nothing written
        return ClassifyOut(id=locked.id, category=category)

    async def schedule_followup(
        self, staff: UserAccount, request_id: uuid.UUID, data: FollowupIn
    ) -> FollowupOut:
        locked, actor = await self._acting(staff, request_id)
        now = self._clock()
        if not now < data.due_at <= now + self._config.followup_max_ahead:
            await self._session.rollback()
            raise FollowupDueOutOfRangeError
        assignee = data.assigned_to or actor.id
        if assignee != actor.id:
            if actor.role is not UserRole.ADMIN:
                await self._session.rollback()
                raise ForbiddenError
            # Share-locked as the actor is: the assignee cannot be demoted before the commit.
            if await self._audit.current_staff(assignee) is None:
                await self._session.rollback()
                raise AssigneeNotStaffError
        followup = await self._followups.add(
            RequestFollowup(
                request_id=locked.id,
                assigned_to=assignee,
                created_by=staff.id,
                due_at=data.due_at,
                note=data.note,
            )
        )
        out = await self._followup_out(followup)
        await self._audited(
            staff,
            AuditAction.REQUEST_FOLLOWUP_SCHEDULE,
            locked.id,
            {},
            {
                "followup_id": str(followup.id),
                "assigned_to": str(assignee),
                "due_at": data.due_at.isoformat(),
            },
        )
        return out

    async def followup_done(
        self, staff: UserAccount, request_id: uuid.UUID, followup_id: uuid.UUID
    ) -> FollowupOut:
        # The actor first (#499 round 1 B3): one revoked since they were authenticated gets
        # 403 before anything of the follow-up is read, a replay of a done one included.
        actor = await self._current(staff)
        followup = await self._followups.for_update(followup_id)
        if followup is None or followup.request_id != request_id:
            await self._session.rollback()
            raise FollowupNotFoundError
        if followup.assigned_to != actor.id and actor.role is not UserRole.ADMIN:
            await self._session.rollback()
            raise ForbiddenError
        if followup.done_at is not None:
            out = await self._followup_out(followup)
            await self._session.commit()  # again: nothing written; the locks go
            return out
        now = self._clock()
        await self._followups.mark_done(followup.id, staff.id, now)
        done = await self._followups.for_update(followup.id)
        if done is None:  # pragma: no cover - rows are never deleted
            raise FollowupNotFoundError
        out = await self._followup_out(done)
        await self._audited(
            staff,
            AuditAction.REQUEST_FOLLOWUP_DONE,
            request_id,
            {"followup_id": str(followup.id), "done_at": None},
            {"followup_id": str(followup.id), "done_at": now.isoformat()},
        )
        return out

    async def staff_members(self, staff: UserAccount) -> StaffList:
        """The active agents and admins, for the panel's assignee pickers. The caller must be
        active staff now. Ends its transaction."""
        try:
            await self._active(staff)
            return StaffList(
                staff=[
                    StaffMemberOut(id=user_id, first_name=first, role=role)
                    for user_id, first, role in await self._users.active_staff()
                ]
            )
        finally:
            await self._session.rollback()

    async def followups_summary(self, staff: UserAccount) -> FollowupsSummary:
        """The caller's open follow-ups due by the end of today in the business time zone,
        overdue ones included: the default list's length, for the panel's badge. Ends its
        transaction."""
        try:
            due = await self._followups.count_open_due(staff.id, await self._end_of_today())
            return FollowupsSummary(due_today=due)
        finally:
            await self._session.rollback()

    async def due_followups(
        self,
        staff: UserAccount,
        *,
        assignee: uuid.UUID | None,
        due: FollowupDue,
        limit: int | None,
        cursor: str | None,
    ) -> FollowupsPage:
        """A staff member's open follow-ups (see the module doc). Ends its transaction."""
        actor = await self._current(staff)
        if assignee is not None and actor.role is not UserRole.ADMIN:
            # The parameter is an admin's, the caller's own id included (#499 round 1 B2).
            await self._session.rollback()
            raise ForbiddenError
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        after = _decode_cursor(cursor) if cursor else None
        due_before = await self._end_of_today() if due is FollowupDue.TODAY else None
        rows = await self._followups.open_due(
            assignee or actor.id, actor, due_before, after, size + 1
        )
        page, more = rows[:size], len(rows) > size
        briefs = await self._requests.briefs([row.request_id for row in page])
        agents = await self._records.agents({row.assigned_to for row in page})
        items = [
            FollowupItem(
                **_followup_out(row, agents[row.assigned_to]).model_dump(),
                public_code=briefs[row.request_id].public_code,
                request_status=briefs[row.request_id].status,
            )
            for row in page
        ]
        # Built before the rollback, which expires the rows.
        next_cursor = _encode_cursor(page[-1]) if more and page else None
        await self._session.rollback()
        return FollowupsPage(items=items, next_cursor=next_cursor)

    async def _acting(
        self, staff: UserAccount, request_id: uuid.UUID
    ) -> tuple[LockedRequest, UserAccount]:
        """The request locked, then the actor as this transaction reads it (share-locked to the
        commit), then the holder rule by that account's role; on a refusal the transaction is
        rolled back first. Returns the locked request and the actor's current account."""
        locked = await self._requests.lock(request_id)
        if locked is None:
            await self._session.rollback()
            raise QueueRequestNotFoundError
        actor = await self._current(staff)
        holder = locked.assigned_agent_id
        if holder is not None and holder != actor.id and actor.role is not UserRole.ADMIN:
            await self._session.rollback()
            raise RequestHeldError
        return locked, actor

    async def _current(self, staff: UserAccount) -> UserAccount:
        """The caller's account as last committed, an active agent or admin, share-locked
        until the transaction ends (AuditService.current_staff); 403, rolled back, for anyone
        else. Decide with ITS role, never `staff.role` (the token's)."""
        actor = await self._audit.current_staff(staff.id)
        if actor is None:
            await self._session.rollback()
            raise ForbiddenError
        return actor

    async def _active(self, staff: UserAccount) -> None:
        await self._current(staff)

    async def _audited(
        self,
        staff: UserAccount,
        action: AuditAction,
        request_id: uuid.UUID,
        before: AuditState,
        after: AuditState,
    ) -> None:
        """The action's audit row in its transaction, then the commit."""
        try:
            await self._audit.record_staff_action(
                staff.id,
                action,
                AuditEntity(AuditEntityType.SERVICE_REQUEST, request_id),
                before,
                after,
            )
        except ActorNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "request_action_by_staff",
            extra={
                "service_request_id": str(request_id),
                "staff_id": str(staff.id),
                "action": action.value,
            },
        )

    async def _end_of_today(self) -> datetime:
        """The end of today in BUSINESS_TIME_ZONE, by Postgres's own time zones (local
        midnight after today: a daylight-saving day is 23 or 25 hours long)."""
        zone = self._config.time_zone
        today = cast(func.timezone(zone, self._clock()), Date)
        end = func.timezone(zone, cast(today + 1, TIMESTAMP))
        value: datetime | None = await self._session.scalar(select(end))
        if value is None:  # pragma: no cover - Postgres answers or raises
            raise InvalidQueueQueryError
        return value

    async def _agent(self, user_id: uuid.UUID) -> QueueAgent:
        return (await self._records.agents({user_id}))[user_id]

    async def _followup_out(self, followup: RequestFollowup) -> FollowupOut:
        return _followup_out(followup, await self._agent(followup.assigned_to))


def _followup_out(followup: RequestFollowup, assignee: QueueAgent) -> FollowupOut:
    return FollowupOut(
        id=followup.id,
        request_id=followup.request_id,
        assigned_to=assignee,
        due_at=followup.due_at,
        note=followup.note,
        done_at=followup.done_at,
    )


def _encode_cursor(followup: RequestFollowup) -> str:
    raw = f"{followup.due_at.isoformat()}|{followup.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        due_at, followup_id = raw.split("|")
        decoded = datetime.fromisoformat(due_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(followup_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidQueueQueryError from None
