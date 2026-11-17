"""The operations queue and the request card as staff read them (#81).

The list carries no contact detail: the customer shows as first name and last initial, the
place as a ZIP. Only the card, an audited read, carries the customer's name, phone, email and
address: the BDC calls them.
"""

import uuid
from datetime import date, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, JsonValue

from app.modules.addresses.schemas import AddressOut
from app.modules.categories.schemas import CategorySummary
from app.modules.jobs.service import JobStatus
from app.modules.quotes.service import QuoteStatus
from app.modules.requests.queue import (
    PreferredPeriod,
    QueueBucket,
    RequestMediaKind,
    RequestOrigin,
    RequestStatus,
)


class BucketFilter(StrEnum):
    """The list's `bucket`: one of the queue's buckets, or every request."""

    PROBLEMS = "problems"
    URGENT = "urgent"
    NEW = "new"
    WAITING_CUSTOMER = "waiting_customer"
    WAITING_PRO = "waiting_pro"
    QUOTE_READY = "quote_ready"
    SCHEDULED_TODAY = "scheduled_today"
    ALL = "all"


class AssignedFilter(StrEnum):
    ME = "me"
    UNASSIGNED = "unassigned"
    ANY = "any"


class QueueAgent(BaseModel):
    id: uuid.UUID
    name: str | None = Field(description="The staff member's first name; null without one.")


class QueueItem(BaseModel):
    """A request in the queue: no phone, email, last name or street."""

    id: uuid.UUID
    public_code: str = Field(description="The code the customer also sees, e.g. JF-000124.")
    customer_name: str | None = Field(
        description='First name and last initial ("Ana P."); null when a name is missing or '
        "shows a contact detail."
    )
    category: CategorySummary | None = Field(description="Null until the request is classified.")
    zip_code: str = Field(description="The 5-digit ZIP of the address.")
    status: RequestStatus
    customer_status: str = Field(description="The glossary i18n key the customer sees.")
    origin: RequestOrigin
    urgency: str | None
    bucket: QueueBucket = Field(
        description="The one bucket the request is in, by precedence: problems, urgent, new, "
        "waiting_customer, waiting_pro, quote_ready, scheduled_today; other when none applies."
    )
    created_at: datetime
    first_contact_due_at: datetime = Field(
        description="created_at plus the first-contact time (OPS_FIRST_CONTACT_SLA_MINUTES)."
    )
    first_contact_at: datetime | None = Field(description="Null until the BDC made contact.")
    assigned_agent: QueueAgent | None = Field(description="Who holds the request, if anyone.")
    media_count: int = Field(description="Photos and videos attached.")


class QueuePage(BaseModel):
    items: list[QueueItem] = Field(
        description="Inside a bucket: the request waiting longest first. With bucket=all: the "
        "newest first."
    )
    next_cursor: str | None = Field(description="Pass as `cursor` for the next page.")


class QueueSummary(BaseModel):
    """How many requests each bucket holds now, and every request under `all`."""

    problems: int
    urgent: int
    new: int
    waiting_customer: int
    waiting_pro: int
    quote_ready: int
    scheduled_today: int
    all: int
    first_contact_sla_minutes: int = Field(description="The first-contact time in use.")


class CardCustomer(BaseModel):
    """Who to call. PII: the card alone carries it."""

    id: uuid.UUID
    first_name: str | None
    last_name: str | None
    phone: str | None = Field(description="E.164, when the account has one.")
    email: str
    language: str = Field(description="The language the request was written in, e.g. en or es.")


class CardMedia(BaseModel):
    """A photo or video's privacy-safe copy: no location or other metadata."""

    kind: RequestMediaKind
    content_type: str
    url: str = Field(description="Presigned GET URL; short-lived.")
    expires_at: datetime


class CardQuote(BaseModel):
    id: uuid.UUID
    pro_name: str | None = Field(description='The pro\'s first name and last initial ("María P.").')
    amount_cents: int = Field(description="The quote's price in USD cents.")
    status: QuoteStatus
    proposed_start_at: datetime
    created_at: datetime


class CardJobEvent(BaseModel):
    type: str
    from_status: JobStatus | None
    to_status: JobStatus | None
    by_system: bool = Field(description="True for a change no person made (e.g. auto-confirm).")
    created_at: datetime


class CardJob(BaseModel):
    id: uuid.UUID
    status: JobStatus
    scheduled_start_at: datetime | None = Field(description="The accepted quote's start.")
    started_at: datetime | None
    completed_at: datetime | None
    confirmed_at: datetime | None
    events: list[CardJobEvent] = Field(description="The job's history, oldest first.")


class RequestCard(QueueItem):
    """One request for the BDC: everything in the list, plus who to call and where, what was
    asked, the media, the quotes and the job. Reading it is recorded in the audit log."""

    customer: CardCustomer
    address: AddressOut = Field(description="As the customer typed it.")
    description: str = Field(description="As the customer typed it: it may hold contacts.")
    intake_answers: dict[str, JsonValue]
    preferred_date: date | None
    preferred_period: PreferredPeriod | None
    preferred_contact: str | None
    media: list[CardMedia]
    media_pending: int = Field(description="Copies still being made; not shown yet.")
    quotes: list[CardQuote] = Field(description="Newest first.")
    job: CardJob | None = Field(description="Null until the request is paid.")
    next_action: str | None
    last_contact_at: datetime | None
    updated_at: datetime


class ClaimOut(BaseModel):
    """Who holds the request after a claim or a release."""

    id: uuid.UUID
    assigned_agent: QueueAgent | None
