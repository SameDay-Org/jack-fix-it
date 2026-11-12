"""Support tickets as their writer and staff see them ("Talk to Jack", #274).

The message is the writer's own text, stored as typed: the writer reads it back in their own
list, and staff read it in the panel. No other user ever does.
"""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.support.models import (
    APP_VERSION_MAX_LENGTH,
    MESSAGE_MAX_LENGTH,
    TicketPlatform,
    TicketRole,
    TicketStatus,
    TicketTopic,
)

Message = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=MESSAGE_MAX_LENGTH, pattern=NO_NUL
    ),
]
# What a version string looks like ("1.4.0", "1.4.0 (52)", "1.4.0-beta.2"): [A-Z] and [0-9],
# not \w or \d, which also match non-ASCII letters and digits. Staff read it as typed.
AppVersion = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=APP_VERSION_MAX_LENGTH,
        pattern=r"^[0-9A-Za-z][0-9A-Za-z .()+_-]*$",
    ),
]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SupportTicketIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: TicketTopic = Field(description="What the ticket is about.")
    message: Message = Field(
        description="The text, trimmed. Stored as typed and read by the team only: a phone or "
        "an email written here is kept, so the team can reach the writer."
    )
    job_id: uuid.UUID | None = Field(
        default=None,
        description="The job the ticket is about: one of which the caller is the customer or "
        "the pro. Leave out when the ticket is about no job.",
    )
    app_version: AppVersion | None = Field(
        default=None, description='The app\'s version, e.g. "1.4.0 (52)".'
    )
    platform: TicketPlatform | None = Field(
        default=None, description="The device the ticket was written on."
    )


class SupportTicketCreatedOut(_Out):
    id: uuid.UUID
    status: TicketStatus = Field(description="open: a new ticket waits for the team.")
    created_at: datetime


class MySupportTicketOut(_Out):
    id: uuid.UUID
    topic: TicketTopic
    message: str = Field(description="The caller's own text, as stored.")
    job_id: uuid.UUID | None
    status: TicketStatus
    created_at: datetime
    closed_at: datetime | None = Field(description="Set while the ticket is closed.")


class MySupportTicketPage(_Out):
    items: list[MySupportTicketOut] = Field(description="Newest first.")
    next_cursor: str | None = Field(description="Pass as `cursor` for older tickets.")


class StaffSupportTicketItem(_Out):
    id: uuid.UUID
    user_id: uuid.UUID = Field(description="Who wrote the ticket.")
    user_first_name: str | None = Field(
        description="The writer's first name alone; null when they have none or it shows a "
        "contact detail."
    )
    role: TicketRole = Field(description="The writer's role when they wrote the ticket.")
    topic: TicketTopic
    job_id: uuid.UUID | None = Field(description="The job the ticket is about, if any.")
    status: TicketStatus
    created_at: datetime


class StaffSupportTicketPage(_Out):
    items: list[StaffSupportTicketItem] = Field(description="Newest first.")
    next_cursor: str | None = Field(description="Pass as `cursor` for older tickets.")


class StaffSupportTicketOut(StaffSupportTicketItem):
    message: str = Field(description="The writer's text, as typed: it may hold contact details.")
    closed_at: datetime | None = Field(description="Set while the ticket is closed.")
    app_version: str | None
    platform: TicketPlatform | None
    updated_at: datetime


class SupportTicketStatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: TicketStatus = Field(
        description="The ticket's new status. Any status may follow any other (a closed ticket "
        "can be reopened); the same status again changes nothing."
    )
