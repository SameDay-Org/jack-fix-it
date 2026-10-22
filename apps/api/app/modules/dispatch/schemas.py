"""What a pro sees of the requests dispatched to them (D9.2, #49).

Every schema forbids extra fields and lists what it shows: never the customer (id, email,
phone), the street, coordinates, utm or the BDC's fields.
"""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from app.modules.categories.schemas import CategorySummary
from app.modules.requests.schemas import MediaOut


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OpportunityLocation(_Out):
    """Where the job is, as much as a pro may see before it is theirs: ZIP and city until the
    job is paid (Cesar, 2026-10-22, #49). Any wider rule changes this schema only."""

    zip_code: str
    city: str


class OpportunitySummary(_Out):
    dispatch_id: uuid.UUID
    public_code: str = Field(description="The request's code, e.g. JF-000124.")
    category: CategorySummary | None
    description_excerpt: str = Field(description="The start of the customer's description.")
    location: OpportunityLocation
    preferred_date: date | None
    media_count: int
    sent_at: datetime
    viewed: bool = Field(description="True once the pro has opened it.")


class OpportunityPage(_Out):
    items: list[OpportunitySummary]
    next_cursor: str | None = Field(description="Pass as `cursor` for the next page.")


class OpportunityDetail(_Out):
    dispatch_id: uuid.UUID
    public_code: str
    category: CategorySummary | None
    description: str
    intake_answers: dict[str, JsonValue]
    location: OpportunityLocation
    preferred_date: date | None
    media: list[MediaOut]
    sent_at: datetime
    viewed_at: datetime | None = Field(description="When the pro first opened it.")
