"""What a pro sees of the requests dispatched to them (D9.2, #49).

Every schema here, nested ones included, forbids extra fields and lists what it shows: never
the customer (id, email, phone), the street, coordinates, utm or the BDC's fields. The
customer's free text arrives with contact details masked (app.redaction). Media, in the
detail only, are the privacy-safe copies (#173), signed from their opaque m/ keys: never the
stored originals, whose keys carry the customer's id and whose files carry GPS data.
"""

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from app.modules.requests.service import RequestMediaKind


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OpportunityCategory(_Out):
    """The request's category, as this module shows it: its own strict model, not the shared
    CategorySummary, whose extra fields would not be refused."""

    id: uuid.UUID
    slug: str
    names: dict[str, str] = Field(description="Display name per locale, e.g. en and es.")


class OpportunityLocation(_Out):
    """Where the job is, as much as a pro may see before it is theirs: ZIP and city until the
    job is paid (Cesar, 2026-10-22, #49). Any wider rule changes this schema only."""

    zip_code: str = Field(description="The 5-digit ZIP.")
    city: str | None = Field(
        description="The official city of the ZIP's service area; null when the area is no "
        "longer served. Never the text the customer typed."
    )


class OpportunitySummary(_Out):
    dispatch_id: uuid.UUID
    public_code: str = Field(description="The request's code, e.g. JF-000124.")
    category: OpportunityCategory | None
    description_excerpt: str = Field(description="The start of the customer's description.")
    location: OpportunityLocation
    preferred_date: date | None
    sent_at: datetime
    viewed: bool = Field(description="True once the pro has opened it.")
    text_redacted: bool = Field(
        description="True when contact details were masked in the description (shown as •••)."
    )


class OpportunityPage(_Out):
    items: list[OpportunitySummary]
    next_cursor: str | None = Field(description="Pass as `cursor` for the next page.")


class OpportunityMedia(_Out):
    """A photo or video of the request: its privacy-safe copy (#173), without location or other
    metadata, under a key that names no one."""

    kind: RequestMediaKind
    content_type: str = Field(description="The copy's media type, e.g. image/jpeg.")
    url: str = Field(description="Presigned GET URL.")
    expires_at: datetime


class OpportunityDetail(_Out):
    dispatch_id: uuid.UUID
    public_code: str
    category: OpportunityCategory | None
    description: str
    intake_answers: dict[str, JsonValue]
    location: OpportunityLocation
    preferred_date: date | None
    sent_at: datetime
    viewed_at: datetime | None = Field(description="When the pro first opened it.")
    text_redacted: bool = Field(
        description="True when contact details were masked in the description or the answers "
        "(shown as •••): the customer is reached through the app."
    )
    media: list[OpportunityMedia] = Field(
        description="The photos and videos ready to show, oldest first."
    )
    media_pending: int = Field(
        description="How many more photos and videos are still being prepared."
    )
