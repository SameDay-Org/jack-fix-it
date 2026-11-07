"""The job chat as its participants and staff see it (#71).

A sender is named by their side only ("me", "customer", "pro"): never a user id, a name, an
email or a phone. Bodies are as stored: already redacted when written. Only staff see the
original of a redacted message (#72), and only while it is kept.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.chat.models import MESSAGE_MAX_LENGTH


class Sender(StrEnum):
    ME = "me"
    CUSTOMER = "customer"
    PRO = "pro"


class ChatWarning(StrEnum):
    """Why the sender should look at what was stored; the app shows its own copy (#74)."""

    CONTACT_DETAILS_HIDDEN = "contact_details_hidden"


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChatMessageOut(_Out):
    id: uuid.UUID
    sender: Sender = Field(
        description="me for the caller's own messages, else the other side: customer or pro."
    )
    body: str = Field(
        description="The text as stored: contact details (phones, emails, links, addresses) "
        "were replaced by ••• when it was sent."
    )
    redacted: bool = Field(description="True when something in the text was masked.")
    created_at: datetime


class SentMessageOut(ChatMessageOut):
    warning: ChatWarning | None = Field(
        description="contact_details_hidden when something in the text was masked (redacted is "
        "true): the app tells the sender that contact details are not shared in the chat. Null "
        "otherwise."
    )


class ChatPage(_Out):
    items: list[ChatMessageOut] = Field(description="Newest first.")
    next_cursor: str | None = Field(description="Pass as `cursor` for older messages.")
    unread_count: int = Field(
        description="The other side's messages after the caller's read marker (all of the "
        "chat, not only this page)."
    )


class StaffChatMessageOut(_Out):
    id: uuid.UUID
    sender: Sender = Field(description="customer or pro.")
    body: str
    redacted: bool
    original: str | None = Field(
        description="What the sender typed, for a redacted message whose original is still kept "
        "(encrypted, for CHAT_ORIGINAL_RETENTION_DAYS); null otherwise, or when it cannot be "
        "read. Every response that carries one is audited."
    )
    created_at: datetime


class StaffChatPage(_Out):
    items: list[StaffChatMessageOut] = Field(description="Newest first.")
    next_cursor: str | None = Field(description="Pass as `cursor` for older messages.")


class ChatMessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=1, max_length=MESSAGE_MAX_LENGTH, pattern=NO_NUL
        ),
    ] = Field(
        description="The text, trimmed. Contact details in it are masked before it is stored; "
        "only the masked text is kept."
    )


class ChatReadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    up_to: uuid.UUID = Field(
        description="The newest message the caller has seen. The marker only moves forward: an "
        "older message changes nothing."
    )


class ChatReadOut(_Out):
    unread_count: int = Field(description="The caller's unread count once the marker moved.")


class ChatOffenderFlagOut(_Out):
    id: uuid.UUID
    user_id: uuid.UUID = Field(description="The sender whose messages were redacted.")
    job_id: uuid.UUID = Field(description="The job of the redaction that opened the flag.")
    window_count: int = Field(
        description="The most redacted messages of the sender seen within one window "
        "(CHAT_OFFENDER_WINDOW_DAYS) while the flag is open."
    )
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None


class ChatOffenderFlagPage(_Out):
    items: list[ChatOffenderFlagOut] = Field(description="Newest first.")
    next_cursor: str | None = Field(description="Pass as `cursor` for older flags.")
