"""What the customer and the pro see of a paid job (D12.2, #63).

Every schema forbids extra fields and lists what it shows. Never a phone or an email on either
side (contacts are never exchanged off the app). The customer never sees the pro's payout or
the platform's fee; the pro never sees the arrival code, the customer's last name or contacts.
"""

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

from app.modules.jobs.models import JobPhotoKind, JobStatus
from app.modules.quotes.schemas import QuotePro

# "On my way" asks how far the pro is: from 5 minutes to 4 hours (#63).
ETA_MIN_MINUTES: Final = 5
ETA_MAX_MINUTES: Final = 240
# A device's accuracy radius past this is not a position worth showing (#350).
ACCURACY_MAX_M: Final = 10_000


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class JobTimelineEntry(_Out):
    """One event of the job's history: what happened and when. No actor, no location."""

    type: str = Field(
        examples=["status_changed"],
        description="created, status_changed, eta_updated or checked_in; more come with later "
        "steps.",
    )
    status: JobStatus | None = Field(
        description="The status the job moved to, for created and status_changed; null otherwise."
    )
    at: datetime


class JobPhotoOut(_Out):
    """One photo of the job, signed for a short while."""

    id: uuid.UUID
    content_type: str = Field(examples=["image/jpeg"])
    url: str = Field(description="A signed GET URL, valid until expires_at.")
    expires_at: datetime


class PhotoKindCounts(_Out):
    """A count of the job's photos per kind."""

    before: int
    after: int


class ProJobPhotos(_Out):
    """The pro's own photos of the job, oldest first: each as its privacy-safe copy once it is
    made, else the pro's original."""

    before: list[JobPhotoOut]
    after: list[JobPhotoOut]
    pending: PhotoKindCounts = Field(
        description="Listed photos whose privacy-safe copy is still being made: the customer "
        "does not see them yet."
    )
    failed: PhotoKindCounts = Field(
        description="Listed photos whose privacy-safe copy could not be made: the customer "
        "never sees them."
    )


class CustomerJobPhotos(_Out):
    """The pro's photos of the job, oldest first: only their privacy-safe copies (no location or
    camera details)."""

    before: list[JobPhotoOut]
    after: list[JobPhotoOut]
    pending: int = Field(
        description="Photos not listed yet: their privacy-safe copy is still being made."
    )


class CustomerJob(_Out):
    """The customer's job on their request, once paid."""

    id: uuid.UUID
    status: JobStatus
    customer_status: str = Field(
        examples=["customerStatus.professionalOnTheWay"],
        description="The i18n key of the status the customer sees (docs/glossary.md).",
    )
    scheduled_start_at: datetime = Field(description="The accepted quote's proposed start.")
    pro: QuotePro = Field(description="The pro's public card, as the quote list shows it.")
    eta_at: datetime | None = Field(
        description="When the pro expects to arrive: set by On my way; null before."
    )
    arrival_code: str | None = Field(
        examples=["0427"],
        description="The 4 digits the customer gives the pro on arrival: only while the job is "
        "on the way and the pro has not checked in; null before and after.",
    )
    confirm_by: datetime | None = Field(
        description="While the job is completed: when it is confirmed automatically if the "
        "customer neither confirms it nor reports a problem (the pro's Job's done plus "
        "JOB_AUTO_CONFIRM_AFTER_HOURS). Null in every other status."
    )
    timeline: list[JobTimelineEntry] = Field(description="The job's history, oldest first.")
    photos: CustomerJobPhotos
    amount_cents: int = Field(description="The price paid for the service.")
    tax_cents: int
    customer_total_cents: int = Field(description="What the customer paid: amount plus tax.")
    unread_messages: int = Field(
        description="The pro's chat messages the customer has not marked read (#71)."
    )


class JobCategory(_Out):
    id: uuid.UUID
    slug: str
    names: dict[str, str] = Field(description="Display name per locale, e.g. en and es.")


class JobAddress(_Out):
    """Where the job is: the pro of a paid job sees the whole address, to get there."""

    line1: str
    line2: str | None
    city: str
    state: str
    zip_code: str


class ProJob(_Out):
    """The pro's own job. Never the arrival code, the customer's last name or contacts."""

    id: uuid.UUID
    status: JobStatus
    scheduled_start_at: datetime = Field(description="The accepted quote's proposed start.")
    category: JobCategory | None
    description: str = Field(
        description="The customer's description, contact details masked as in the opportunity."
    )
    address: JobAddress | None = Field(
        description="The request's whole address; null once the job is cancelled or refunded."
    )
    customer_first_name: str | None = Field(
        description="The customer's first name only; null when it is not set or shows a "
        "contact detail."
    )
    eta_at: datetime | None = Field(description="The ETA the pro gave at On my way.")
    checked_in_at: datetime | None = Field(
        description="When the pro checked in with the customer's arrival code (Arrived)."
    )
    arrival_code_locked: bool = Field(
        description="True after too many wrong arrival codes: check-in is refused until "
        "support resolves it."
    )
    started_at: datetime | None = Field(description="When the work started (Working).")
    completed_at: datetime | None = Field(
        description="When the pro marked the job done: the customer's confirmation window opens."
    )
    confirm_by: datetime | None = Field(
        description="While the job is completed: when it is confirmed automatically if the "
        "customer neither confirms it nor reports a problem (the pro's Job's done plus "
        "JOB_AUTO_CONFIRM_AFTER_HOURS). Null in every other status."
    )
    photos: ProJobPhotos
    pro_payout_cents: int = Field(description="What the pro receives for the job.")
    unread_messages: int = Field(
        description="The customer's chat messages the pro has not marked read (#71)."
    )


class ProJobPage(_Out):
    items: list[ProJob]
    next_cursor: str | None = Field(description="Pass as `cursor` for the next page.")


class OnTheWayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    eta_minutes: int = Field(
        ge=ETA_MIN_MINUTES,
        le=ETA_MAX_MINUTES,
        strict=True,
        description="Minutes until the pro expects to arrive.",
    )


class CheckInIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    arrival_code: Annotated[str, StringConstraints(pattern=r"^[0-9]{4}$")] = Field(
        description="The 4 digits the customer gives the pro."
    )
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False, description="The pro's latitude.")
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False, description="The pro's longitude.")


class ProLocationIn(BaseModel):
    """One fix of the pro's device while on the way (#350). Numbers only: a string or a boolean
    is refused, not converted."""

    model_config = ConfigDict(extra="forbid")

    lat: float = Field(
        ge=-90, le=90, strict=True, allow_inf_nan=False, description="Latitude, in degrees."
    )
    lng: float = Field(
        ge=-180, le=180, strict=True, allow_inf_nan=False, description="Longitude, in degrees."
    )
    accuracy_m: float | None = Field(
        default=None,
        ge=0,
        le=ACCURACY_MAX_M,
        strict=True,
        allow_inf_nan=False,
        description="The fix's accuracy radius in meters; null or left out when unknown.",
    )
    heading_deg: float | None = Field(
        default=None,
        ge=0,
        le=360,
        strict=True,
        allow_inf_nan=False,
        description="Direction of travel, in degrees clockwise from north; null or left out "
        "when unknown.",
    )
    recorded_at: AwareDatetime = Field(
        description="When the device took the fix, with its UTC offset. Refused when too far "
        "from the server's time (ahead or behind)."
    )


class ProPosition(_Out):
    """Where the pro was at `updated_at` (#350)."""

    lat: float
    lng: float
    accuracy_m: float | None = Field(description="Accuracy radius in meters, when known.")
    heading_deg: float | None = Field(
        description="Direction of travel, in degrees clockwise from north, when known."
    )
    updated_at: datetime = Field(description="When the server received this position.")


class ProLocationOut(_Out):
    position: ProPosition | None = Field(
        description="The pro's latest position. null whenever there is none to show: the pro "
        "is not on the way (not yet, arrived, or the job moved on), has sent none yet, or "
        "the last one is too old."
    )


class JobPhotosIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: JobPhotoKind = Field(
        description="before: while on the way or working; after: while working."
    )
    upload_keys: list[Annotated[str, StringConstraints(min_length=1, max_length=256)]] = Field(
        min_length=1,
        description="Keys of the caller's own job_photo uploads (POST /v1/uploads), in the "
        "order to show them.",
    )
