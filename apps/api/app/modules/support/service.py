"""Support tickets ("Talk to Jack", #274; Cesar 2026-11-07): a customer or a pro writes to the
team from the app's Help page, and the team works the tickets in the panel.

- Who writes: the app's users (customer, pro). The ticket keeps the writer's role as it was.
  Rate-limited per user (the router).
- The message is stored as typed, not redacted: only staff read it, and the writer may need to
  give a phone or an email to be reached. The writer reads their own tickets back; no other
  user ever sees one.
- `job_id`: only a job the writer takes part in (its customer or its pro, JobPartiesReader).
  Any other job, and an unknown one, is a 422 with one body, so the answer never tells whether
  a job exists.
- Staff (agent, admin) list every ticket, newest first, by status; read one; and change its
  status. Any status may follow any other (a closed ticket can be reopened). A change locks
  the ticket row, writes one audit_log row (the actor, before and after) in the same
  transaction, and commits both: a failed audit write changes nothing. The same status again
  changes nothing and writes nothing. `closed_at` is set while the ticket is closed.
- Lists: newest first by (created_at, id), with a cursor.

Never logged: the message, the writer's name or the app version. Logs carry ids, the role, the
topic and statuses.
"""

import base64
import binascii
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ForbiddenError
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    ActorNotStaffError,
    AuditAction,
    AuditEntity,
    AuditEntityType,
)
from app.modules.jobs.service import JobPartiesReader
from app.modules.pros.service import ProService
from app.modules.support.errors import (
    InvalidTicketInputError,
    InvalidTicketJobError,
    TicketNotFoundError,
)
from app.modules.support.models import SupportTicket, TicketRole, TicketStatus
from app.modules.support.repository import Before, SupportTicketRepository
from app.modules.support.schemas import (
    MySupportTicketOut,
    MySupportTicketPage,
    StaffSupportTicketItem,
    StaffSupportTicketOut,
    StaffSupportTicketPage,
    SupportTicketCreatedOut,
    SupportTicketIn,
)
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)

# The writer's role on the ticket; agents and admins write none.
_WRITER_ROLES = {UserRole.CUSTOMER: TicketRole.CUSTOMER, UserRole.PRO: TicketRole.PRO}


@dataclass(frozen=True)
class SupportConfig:
    list_default_limit: int
    list_max_limit: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "SupportConfig":
        return cls(
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
        )


class SupportTicketService:
    def __init__(self, session: AsyncSession, config: SupportConfig) -> None:
        self._session = session
        self._config = config
        self._tickets = SupportTicketRepository(session)
        self._jobs = JobPartiesReader(session, ProService(session))
        self._users = UserService(session)
        self._audit = AuditService(session)

    async def create(self, user: UserAccount, data: SupportTicketIn) -> SupportTicketCreatedOut:
        """Stores the ticket, open, and commits."""
        role = _WRITER_ROLES.get(user.role)
        if role is None:  # the route takes customers and pros only
            raise ForbiddenError
        # One statement scoped to the caller: a job of others costs what an unknown id costs.
        if data.job_id is not None and await self._jobs.parties_for(user.id, data.job_id) is None:
            raise InvalidTicketJobError
        ticket = await self._tickets.add(
            SupportTicket(
                user_id=user.id,
                role=role,
                topic=data.topic,
                message=data.message,
                job_id=data.job_id,
                app_version=data.app_version,
                platform=data.platform,
            )
        )
        await self._session.commit()
        logger.info(
            "support_ticket_created",
            extra={
                "ticket_id": str(ticket.id),
                "user_id": str(user.id),
                "role": role.value,
                "topic": ticket.topic.value,
                "job_id": str(ticket.job_id) if ticket.job_id else None,
            },
        )
        return SupportTicketCreatedOut(
            id=ticket.id, status=ticket.status, created_at=ticket.created_at
        )

    async def mine(
        self, user: UserAccount, *, limit: int | None, cursor: str | None
    ) -> MySupportTicketPage:
        """The caller's own tickets, newest first."""
        before = _decode_cursor(cursor) if cursor else None
        size = self._size(limit)
        rows = await self._tickets.page_of_user(user.id, limit=size + 1, before=before)
        page, more = rows[:size], len(rows) > size
        return MySupportTicketPage(
            items=[
                MySupportTicketOut(
                    id=ticket.id,
                    topic=ticket.topic,
                    message=ticket.message,
                    job_id=ticket.job_id,
                    status=ticket.status,
                    created_at=ticket.created_at,
                    closed_at=ticket.closed_at,
                )
                for ticket in page
            ],
            next_cursor=_encode_cursor(page[-1]) if more and page else None,
        )

    async def staff_list(
        self, *, status: TicketStatus | None, limit: int | None, cursor: str | None
    ) -> StaffSupportTicketPage:
        """Every ticket for the BDC and admins, newest first: one status, or all of them. Never
        the message: the detail carries it."""
        before = _decode_cursor(cursor) if cursor else None
        size = self._size(limit)
        rows = await self._tickets.page(status=status, limit=size + 1, before=before)
        page, more = rows[:size], len(rows) > size
        names = await self._users.first_names({ticket.user_id for ticket in page})
        return StaffSupportTicketPage(
            items=[_item(ticket, names.get(ticket.user_id)) for ticket in page],
            next_cursor=_encode_cursor(page[-1]) if more and page else None,
        )

    async def staff_get(self, staff: UserAccount, ticket_id: uuid.UUID) -> StaffSupportTicketOut:
        """One ticket with its message, for the BDC and admins."""
        ticket = await self._tickets.get(ticket_id)
        if ticket is None:
            raise TicketNotFoundError
        logger.info(
            "support_ticket_read_by_staff",
            extra={"ticket_id": str(ticket.id), "staff_id": str(staff.id)},
        )
        return await self._detail(ticket)

    async def set_status(
        self, staff: UserAccount, ticket_id: uuid.UUID, status: TicketStatus
    ) -> StaffSupportTicketOut:
        """Moves the ticket to `status`, audited, and commits; the same status again changes
        and writes nothing."""
        ticket = await self._tickets.get_for_update(ticket_id)
        if ticket is None:
            raise TicketNotFoundError
        previous = ticket.status
        if previous == status:
            await self._session.commit()  # nothing changed: only the row lock goes
            return await self._detail(ticket)
        # Read before the ticket changes: a query flushes what is pending, and status and
        # closed_at must reach the database in one statement (closed_at_matches_status).
        closed_at = await self._tickets.now() if status == TicketStatus.CLOSED else None
        ticket.status = status
        ticket.closed_at = closed_at
        await self._tickets.save(ticket)
        try:
            # In the change's transaction: an audit write that fails rolls the change back.
            await self._audit.record_staff_action(
                staff.id,
                AuditAction.SUPPORT_TICKET_SET_STATUS,
                AuditEntity(AuditEntityType.SUPPORT_TICKET, ticket.id),
                {"status": previous.value},
                {"status": status.value},
            )
        except ActorNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "support_ticket_status_changed",
            extra={
                "ticket_id": str(ticket.id),
                "staff_id": str(staff.id),
                "from_status": previous.value,
                "to_status": status.value,
            },
        )
        return await self._detail(ticket)

    async def _detail(self, ticket: SupportTicket) -> StaffSupportTicketOut:
        names = await self._users.first_names({ticket.user_id})
        return StaffSupportTicketOut(
            **_item(ticket, names.get(ticket.user_id)).model_dump(),
            message=ticket.message,
            closed_at=ticket.closed_at,
            app_version=ticket.app_version,
            platform=ticket.platform,
            updated_at=ticket.updated_at,
        )

    def _size(self, limit: int | None) -> int:
        """`limit` above the maximum is capped, not refused."""
        return min(limit or self._config.list_default_limit, self._config.list_max_limit)


def _item(ticket: SupportTicket, first_name: str | None) -> StaffSupportTicketItem:
    return StaffSupportTicketItem(
        id=ticket.id,
        user_id=ticket.user_id,
        user_first_name=first_name,
        role=ticket.role,
        topic=ticket.topic,
        job_id=ticket.job_id,
        status=ticket.status,
        created_at=ticket.created_at,
    )


def _encode_cursor(ticket: SupportTicket) -> str:
    raw = f"{ticket.created_at.isoformat()}|{ticket.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> Before:
    """A cursor only positions the page: whatever it holds, the caller's own list never leaves
    their tickets, and the staff list is open to staff anyway."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, ticket_id = raw.split("|")
        decoded = datetime.fromisoformat(created_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(ticket_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidTicketInputError from None
