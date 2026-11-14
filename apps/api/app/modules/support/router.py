import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Response, status
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import AppUser, PanelUser
from app.modules.support.models import MESSAGE_MAX_LENGTH, TicketStatus
from app.modules.support.schemas import (
    MySupportTicketPage,
    StaffSupportTicketOut,
    StaffSupportTicketPage,
    SupportTicketCreatedOut,
    SupportTicketIn,
    SupportTicketStatusIn,
)
from app.modules.support.service import SupportConfig, SupportTicketService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The app's users write to the team and read their own tickets back (#274).
router = APIRouter(prefix="/support/tickets", tags=["support"])
# The BDC and admins work the tickets in the panel (#274).
staff_router = APIRouter(prefix="/admin/support/tickets", tags=["support"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_support_ticket_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> SupportTicketService:
    return SupportTicketService(session, SupportConfig.from_settings(settings))


Tickets = Annotated[SupportTicketService, Depends(get_support_ticket_service)]
Limit = Annotated[int | None, Query(gt=0, description="Page size; capped.")]
Cursor = Annotated[str | None, Query(max_length=200)]
_IDEMPOTENCY_KEY = TypeAdapter(uuid.UUID)


def _parsed_key(raw: str | None) -> uuid.UUID | None:
    """The Idempotency-Key as the route reads it; None when absent or not a UUID (the route
    answers that one 422)."""
    if raw is None:
        return None
    try:
        return _IDEMPOTENCY_KEY.validate_python(raw)
    except ValidationError:
        return None


async def limit_ticket_creates(
    user: AppUser,
    tickets: Tickets,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    raw_key: Annotated[str | None, Header(alias="Idempotency-Key", include_in_schema=False)] = None,
) -> None:
    """SUPPORT_TICKET_CREATE_LIMIT tickets per user per SUPPORT_TICKET_CREATE_WINDOW_SECONDS.
    A refused attempt (an invalid body, a key that is not a UUID) counts too. A create whose
    Idempotency-Key already wrote one of the user's tickets within the window takes no slot,
    whatever its body: it writes nothing (a retry answers that ticket, another body is a 409),
    and an app retrying after a timeout must not lock its user out. A retry that races its
    first create before that one commits is not seen here, and counts once."""
    key = _parsed_key(raw_key)
    if key is not None and await tickets.is_retry(user, key):
        return
    await enforce_limit(
        limiter,
        "support_ticket_create",
        str(user.id),
        limit=settings.support_ticket_create_limit,
        window_seconds=settings.support_ticket_create_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_APP_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only customers and pros write tickets."),
}
_STAFF_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
}
_TICKET_NOT_FOUND = _error("ticket_not_found: no support ticket with this id.")
IdempotencyKey = Annotated[
    uuid.UUID | None,
    Header(
        alias="Idempotency-Key",
        description=(
            "A UUID the app makes once per draft and sends again with every retry of it. "
            "Within the server's window (24 hours by default) a retry answers 200 with the "
            "ticket the first call wrote, its status as it is now, writes nothing and takes no "
            "rate-limit slot; the same key with another body answers 409 "
            "idempotency_key_reused. Without it every call writes a ticket."
        ),
    ),
]


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SupportTicketCreatedOut,
    summary="Write to the team (Talk to Jack)",
    dependencies=[Depends(limit_ticket_creates)],
    responses={
        status.HTTP_200_OK: {
            "model": SupportTicketCreatedOut,
            "description": (
                "A retry: the caller already wrote a ticket with this Idempotency-Key and this "
                "body within the window. The replay returns that ticket (the same id and "
                "created_at; its status as it is now); nothing is written."
            ),
        },
        **_APP_ACCESS,
        status.HTTP_409_CONFLICT: _error(
            "idempotency_key_reused: the caller already used this Idempotency-Key with a "
            "different body; nothing was changed."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_job: job_id is not a job of which the caller is the customer or the pro "
            "(an unknown job answers the same); validation_error: an unknown topic or "
            f"platform, a message empty, blank or longer than {MESSAGE_MAX_LENGTH} characters, "
            "an app_version out of format, an Idempotency-Key that is not a UUID."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: {
            **_error("rate_limited: too many tickets; retry later."),
            "headers": {
                "Retry-After": {
                    "description": "Seconds until the current limit window ends.",
                    "schema": {"type": "integer"},
                }
            },
        },
    },
)
async def create_ticket(
    data: SupportTicketIn,
    user: AppUser,
    tickets: Tickets,
    response: Response,
    idempotency_key: IdempotencyKey = None,
) -> SupportTicketCreatedOut:
    """Opens a support ticket for the team. The message is kept as typed and read by the team
    only. `job_id` ties the ticket to one of the caller's jobs."""
    created = await tickets.create(user, data, idempotency_key)
    if not created.created:
        response.status_code = status.HTTP_200_OK
    return created.ticket


@router.get(
    "/mine",
    response_model=MySupportTicketPage,
    summary="List my support tickets",
    responses={
        **_APP_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
    },
)
async def list_my_tickets(
    user: AppUser, tickets: Tickets, limit: Limit = None, cursor: Cursor = None
) -> MySupportTicketPage:
    """The caller's own tickets, newest first: the topic, the job, the status and the dates,
    what the app shows after a ticket was sent. Never the message, and never anyone else's."""
    return await tickets.mine(user, limit=limit, cursor=cursor)


@staff_router.get(
    "",
    response_model=StaffSupportTicketPage,
    summary="List support tickets (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an unknown status, a bad cursor or limit."
        ),
    },
)
async def staff_list_tickets(
    user: PanelUser,
    tickets: Tickets,
    status_filter: Annotated[
        TicketStatus | None,
        Query(alias="status", description="Only tickets in this status; all when left out."),
    ] = None,
    limit: Limit = None,
    cursor: Cursor = None,
) -> StaffSupportTicketPage:
    """Every ticket, newest first, for the BDC and admins: the writer's first name and role,
    the topic, the job and the status. The message is in the ticket's detail only."""
    return await tickets.staff_list(status=status_filter, limit=limit, cursor=cursor)


@staff_router.get(
    "/{ticket_id}",
    response_model=StaffSupportTicketOut,
    summary="Read a support ticket (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _TICKET_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a ticket_id that is not a UUID."
        ),
    },
)
async def staff_get_ticket(
    ticket_id: uuid.UUID, user: PanelUser, tickets: Tickets
) -> StaffSupportTicketOut:
    """One ticket with its message as the writer typed it."""
    return await tickets.staff_get(user, ticket_id)


@staff_router.patch(
    "/{ticket_id}",
    response_model=StaffSupportTicketOut,
    summary="Change a support ticket's status (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _TICKET_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an unknown status, a field other than status, or a ticket_id "
            "that is not a UUID."
        ),
    },
)
async def staff_set_ticket_status(
    ticket_id: uuid.UUID, data: SupportTicketStatusIn, user: PanelUser, tickets: Tickets
) -> StaffSupportTicketOut:
    """Moves the ticket to open, in_progress or closed; any status may follow any other. Each
    change is recorded in the audit log with the staff member who made it; the same status
    again changes nothing."""
    return await tickets.set_status(user, ticket_id, data.status)
