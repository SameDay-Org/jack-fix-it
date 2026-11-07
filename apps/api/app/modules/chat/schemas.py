"""The job chat as its participants and staff see it (#71).

A sender is named by their side only ("me", "customer", "pro"): never a user id, a name, an
email or a phone. Bodies are as stored: already redacted when written.
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
