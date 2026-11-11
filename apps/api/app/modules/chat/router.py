import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import AppUser, PanelUser
from app.modules.chat.schemas import (
    ChatMessageIn,
    ChatOffenderFlagPage,
    ChatPage,
    ChatReadIn,
    ChatReadOut,
    SentMessageOut,
    StaffChatPage,
)
from app.modules.chat.service import ChatConfig, ChatService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The job's customer and pro (#71).
router = APIRouter(prefix="/jobs/{job_id}/messages", tags=["chat"])
# The BDC and admins: read-only (#71).
staff_router = APIRouter(prefix="/admin/jobs/{job_id}/messages", tags=["chat"])
# The BDC and admins: repeat-offender flags (#72).
flags_router = APIRouter(prefix="/admin/chat/flags", tags=["chat"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_chat_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ChatService:
    return ChatService(session, ChatConfig.from_settings(settings))


Chat = Annotated[ChatService, Depends(get_chat_service)]
Limit = Annotated[int | None, Query(gt=0, description="Page size; capped.")]
Cursor = Annotated[str | None, Query(max_length=200)]


async def limit_messages(
    job_id: uuid.UUID,
    user: AppUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """CHAT_MESSAGE_RATE_LIMIT messages per user per job per
    CHAT_MESSAGE_RATE_WINDOW_SECONDS."""
    await enforce_limit(
        limiter,
        "chat_message",
        f"{user.id}:{job_id}",
        limit=settings.chat_message_rate_limit,
        window_seconds=settings.chat_message_rate_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing or expired."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only customers and pros have job chats."),
    status.HTTP_404_NOT_FOUND: _error(
        "not_found: no job with this id of which the caller is the customer or the pro."
    ),
}


@router.get(
    "",
    response_model=ChatPage,
    summary="Read my job's chat",
    responses={
        **_RESPONSES,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
    },
)
async def list_messages(
    job_id: uuid.UUID, user: AppUser, chat: Chat, limit: Limit = None, cursor: Cursor = None
) -> ChatPage:
    """The job's messages, newest first, with the caller's unread count and a receipt on each
    of the caller's own messages (sent, delivered, seen). Listing delivers to the caller the
    other side's messages this page returns, and only those (their sender's receipt turns
    delivered; an older message the page did not return stays sent). It never moves the read
    marker: POST .../read does. Readable in every job status."""
    return await chat.messages(user, job_id, limit=limit, cursor=cursor)


@router.post(
    "",
    response_model=SentMessageOut,
    status_code=status.HTTP_201_CREATED,
    summary="Send a message in my job's chat",
    dependencies=[Depends(limit_messages)],
    responses={
        **_RESPONSES,
        status.HTTP_409_CONFLICT: _error(
            "chat_closed: the job is confirmed, paid out, refunded or cancelled; the chat is "
            "read-only."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an empty or blank body, or longer than 2000 characters."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: {
            **_error("rate_limited: too many messages in this chat; retry later."),
            "headers": {
                "Retry-After": {
                    "description": "Seconds until the current limit window ends.",
                    "schema": {"type": "integer"},
                }
            },
        },
    },
)
async def send_message(
    job_id: uuid.UUID, data: ChatMessageIn, user: AppUser, chat: Chat
) -> SentMessageOut:
    """Stores the message with contact details masked (phones, emails, links, addresses).
    Answers what was stored, with `warning: contact_details_hidden` when something was masked.
    The other side only ever reads the masked text; the original is kept encrypted for staff,
    for a limited time."""
    return await chat.send(user, job_id, data.body)


@router.post(
    "/read",
    response_model=ChatReadOut,
    summary="Mark my job's chat read up to a message",
    responses={
        **_RESPONSES,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_message: up_to is not a message of this chat; validation_error: a bad body."
        ),
    },
)
async def mark_read(job_id: uuid.UUID, data: ChatReadIn, user: AppUser, chat: Chat) -> ChatReadOut:
    """Moves the caller's read marker to the message, only forward: an older one, or the same
    again, changes nothing. Reading implies delivered: every message up to the marker reads as
    seen to its sender, whether or not a listing delivered it. Allowed in every job status."""
    return ChatReadOut(unread_count=await chat.mark_read(user, job_id, data.up_to))


@staff_router.get(
    "",
    response_model=StaffChatPage,
    summary="Read a job's chat (staff)",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing or expired."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
        status.HTTP_404_NOT_FOUND: _error("not_found: no job with this id."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
    },
)
async def staff_list_messages(
    job_id: uuid.UUID, user: PanelUser, chat: Chat, limit: Limit = None, cursor: Cursor = None
) -> StaffChatPage:
    """Any job's messages, newest first, for the BDC and admins, with the original of each
    redacted message while it is kept, and every message's receipt. Read-only: no marker moves,
    and the parties' unread counts and receipts do not change. A response that carries an
    original is recorded in the audit log."""
    return await chat.staff_messages(user, job_id, limit=limit, cursor=cursor)


@flags_router.get(
    "",
    response_model=ChatOffenderFlagPage,
    summary="List repeat-offender flags (staff)",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing or expired."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
    },
)
async def list_offender_flags(
    user: PanelUser,
    chat: Chat,
    open: Annotated[
        bool, Query(description="true: flags not resolved yet; false: resolved ones.")
    ] = True,
    limit: Limit = None,
    cursor: Cursor = None,
) -> ChatOffenderFlagPage:
    """Senders whose chat messages were redacted CHAT_OFFENDER_THRESHOLD times within
    CHAT_OFFENDER_WINDOW_DAYS, newest first: ids, counts and timestamps, never message text."""
    return await chat.offender_flags(open_only=open, limit=limit, cursor=cursor)
