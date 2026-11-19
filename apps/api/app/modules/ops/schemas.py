"""The operations queue and the request card as staff read them (#81).

The list carries no contact detail: the customer shows as first name and last initial, the
place as a ZIP. Only the card, an audited read, carries the customer's name, phone, email and
address: the BDC calls them.
"""

import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, StringConstraints

from app.modules.addresses.schemas import NO_NUL, AddressOut
from app.modules.categories.schemas import CategorySummary
from app.modules.jobs.service import JobStatus
from app.modules.ops.models import FOLLOWUP_NOTE_MAX_LENGTH, NOTE_MAX_LENGTH
from app.modules.quotes.service import QuoteStatus
from app.modules.requests.queue import (
    PreferredPeriod,
    QueueBucket,
    RequestMediaKind,
    RequestOrigin,
    RequestStatus,
)
from app.modules.users.types import UserRole


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
    notes: list["NoteOut"] = Field(
        description="The staff's internal notes, oldest first (#82). Never shown to the "
        "customer or the pro."
    )
    followups: list["FollowupOut"] = Field(description="By due time (#82).")
    actions_allowed: bool = Field(
        default=True,
        description="Whether the caller may act on this request now (#82): it is unassigned, "
        "held by them, or they are an admin. The API stays the guard (409 request_held).",
    )
    info_requested_at: datetime | None = Field(
        default=None,
        description="When the BDC asked the customer for more information (#82): the request "
        "waits in reviewing and no re-dispatch takes it until staff resume it, change its "
        "status or assign a pro. Null when it is not on hold.",
    )
    allowed_status_changes: list[RequestStatus] = Field(
        default_factory=list,
        description="The statuses staff may move the request to now (#82), from the request "
        "state machine's staff edges: never finding_pro, which dispatch owns. The API stays "
        "the guard (409 invalid_transition).",
    )


class ClaimOut(BaseModel):
    """Who holds the request after a claim or a release."""

    id: uuid.UUID
    assigned_agent: QueueAgent | None


# --- The BDC's actions (#82) -------------------------------------------------------------------

PlainNote = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=NOTE_MAX_LENGTH, pattern=NO_NUL
    ),
]
FollowupNote = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=FOLLOWUP_NOTE_MAX_LENGTH, pattern=NO_NUL
    ),
]


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: PlainNote = Field(
        description="Plain text, 1 to 2000 characters, kept as written (staff only, never "
        "shown to the customer or the pro, never logged)."
    )


class NoteOut(BaseModel):
    id: uuid.UUID
    author: QueueAgent
    body: str
    created_at: datetime


class ContactedOut(BaseModel):
    """When the BDC first contacted the customer: set once."""

    id: uuid.UUID
    first_contact_at: datetime


class MoreInfoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: PlainNote = Field(
        description="What the BDC asks the customer, kept as an internal note: plain text, 1 to "
        "2000 characters (staff only, never logged)."
    )


class MoreInfoOut(BaseModel):
    """The request on hold in reviewing, and the question as a note."""

    id: uuid.UUID
    status: RequestStatus
    info_requested_at: datetime
    note: "NoteOut"
    customer_notified: bool = Field(
        description="Whether the customer was messaged. Always false today: no channel takes a "
        "staff message to the customer yet, so the agent reaches the customer themselves."
    )


class ResumeOut(BaseModel):
    """The request off hold: the next re-dispatch sweep (REDISPATCH_SWEEP_MINUTES) takes it
    when it is received or reviewing with a category and no offer yet."""

    id: uuid.UUID
    status: RequestStatus
    info_requested_at: None = None


class StatusChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    to: RequestStatus = Field(description="One of the card's allowed_status_changes.")
    reason: PlainNote = Field(
        description="Why, kept as an internal note: plain text, 1 to 2000 characters."
    )


class StatusChangeOut(BaseModel):
    id: uuid.UUID
    status: RequestStatus
    note: "NoteOut"


class ClassifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category_id: uuid.UUID = Field(description="An active category.")


class ClassifyOut(BaseModel):
    id: uuid.UUID
    category: CategorySummary


class FollowupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    due_at: AwareDatetime = Field(
        description="When it is due: in the future, at most OPS_FOLLOWUP_MAX_DAYS ahead."
    )
    note: FollowupNote = Field(description="What to do, 1 to 500 characters (staff only).")
    assigned_to: uuid.UUID | None = Field(
        default=None,
        description="An active agent or admin; the caller by default. Only an admin gives a "
        "follow-up to someone else.",
    )


class FollowupOut(BaseModel):
    id: uuid.UUID
    request_id: uuid.UUID
    assigned_to: QueueAgent
    due_at: datetime
    note: str
    done_at: datetime | None


class FollowupItem(FollowupOut):
    """A follow-up in the list: its request's code and status, never a contact."""

    public_code: str
    request_status: RequestStatus


class FollowupDue(StrEnum):
    # Not done, due before the end of today in BUSINESS_TIME_ZONE: overdue ones included.
    TODAY = "today"
    # Not done, whenever due.
    ALL = "all"


class FollowupsPage(BaseModel):
    items: list[FollowupItem] = Field(description="By due time, the most overdue first.")
    next_cursor: str | None


RequestCard.model_rebuild()


class FollowupsSummary(BaseModel):
    due_today: int = Field(
        description="The caller's open follow-ups due by the end of today in the business time "
        "zone, overdue ones included: the length of GET /v1/admin/followups (due today)."
    )


class StaffMemberOut(BaseModel):
    """An active agent or admin, as the panel's assignee pickers list them (#82): no contact."""

    id: uuid.UUID
    first_name: str | None = Field(description="Null when missing or showing a contact.")
    role: UserRole


class StaffList(BaseModel):
    staff: list[StaffMemberOut] = Field(description="By first name.")
