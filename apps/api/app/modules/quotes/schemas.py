import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Final

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.modules.addresses.schemas import NO_NUL
from app.modules.categories.schemas import CategorySummary
from app.modules.quotes.models import QuoteStatus
from app.modules.settings.service import INT4_MAX

SCOPE_MAX_LENGTH: Final = 2000  # what's included; the request description has the same bound
APPROACH_MAX_LENGTH: Final = 2000  # "How I'll do the job" (#246), as long as the scope


class QuoteCreate(BaseModel):
    """A pro's fixed-price quote (#50). The server sets the status, the expiry, the pro and the
    request; a client sending any of them gets a 422."""

    model_config = ConfigDict(extra="forbid")

    amount_cents: int = Field(
        gt=0,
        le=INT4_MAX,
        strict=True,
        description="The pro's price in integer cents (USD); the platform may set a lower cap.",
    )
    scope: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, min_length=1, max_length=SCOPE_MAX_LENGTH, pattern=NO_NUL
        ),
    ] = Field(description="What the price includes.")
    approach: (
        Annotated[
            str,
            StringConstraints(
                strip_whitespace=True,
                min_length=1,
                max_length=APPROACH_MAX_LENGTH,
                pattern=NO_NUL,
            ),
        ]
        | None
    ) = Field(
        default=None,
        description="How I'll do the job: optional, apart from what the price includes. "
        "Trimmed; empty or blank is stored as no note (null).",
    )
    duration_minutes: int = Field(
        gt=0, le=INT4_MAX, strict=True, description="Estimated duration of the work."
    )
    proposed_start_at: AwareDatetime = Field(description="When the pro proposes to start.")

    @field_validator("approach", mode="before")
    @classmethod
    def _blank_is_no_note(cls, value: object) -> object:
        # Blank by str.strip, which also drops a few control characters the constraint's
        # strip keeps: a note of only those becomes null too, never a 1-character note.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("proposed_start_at")
    @classmethod
    def _in_the_future(cls, value: datetime) -> datetime:
        if value <= datetime.now(UTC):
            raise ValueError("must be in the future")
        return value


class _QuoteFields(BaseModel):
    """What the pro and the customer both see of a quote. Never the payout or the platform's
    fee: those are the pro's only (QuoteOut)."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    amount_cents: int
    scope: str
    duration_minutes: int
    proposed_start_at: datetime
    expires_at: datetime
    status: QuoteStatus
    created_at: datetime


class QuoteOut(_QuoteFields):
    """The pro's own quote (#50), with what they will receive (#246). Never sent to the
    customer: CustomerQuote does not extend it."""

    approach: str | None = Field(description="How I'll do the job, as the pro wrote it.")
    pro_payout_cents: int = Field(
        description="What the pro will receive: the amount minus the platform's fee. The "
        "customer pays the amount; the platform absorbs the card fee."
    )
    platform_fee_cents: int = Field(
        description="The platform's fee: the amount times the take rate, rounded half up to "
        "the cent."
    )


class QuotePro(BaseModel):
    """The pro behind a quote, as the customer sees them before paying: never a contact, a
    document, the photo or an internal id (the account, Stripe)."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID = Field(description="The pro's profile id.")
    name: str | None = Field(
        description='The first name and the last name\'s initial, e.g. "María P."; null when '
        "the pro has not set both names, or when the name shows a contact detail (an email, a "
        "phone, a domain...): withheld before payment, never partly masked."
    )
    rating_avg: str | None = Field(
        examples=["4.80"],
        description="The average rating as a decimal string; null before the first review.",
    )
    jobs_count: int = Field(description="Jobs completed on the platform.")
    years_of_experience: int | None
    verified: bool = Field(description="The platform approved the pro's verification.")


class ProPublicProfile(QuotePro):
    """The public profile of the pro behind a quote the customer can choose (#53), before
    paying: the card's fields, the bio, the categories and the month the pro joined. Never a
    contact, a document, the photo, the service areas, payouts or an internal id (the account,
    Stripe)."""

    bio: str | None = Field(
        description="What the pro wrote about their work, with contact details masked "
        "(app.redaction), as in a quote's scope: the pro's own email and phone, then every "
        "contact pattern; null when the pro wrote none."
    )
    categories: list[CategorySummary] = Field(
        description="The active categories the pro works in, by slug."
    )
    member_since: date = Field(
        examples=["2026-10-01"],
        description="The first day of the month the pro joined: month precision only.",
    )


class CustomerQuote(_QuoteFields):
    """A quote on the customer's request (#188). `scope` and `approach` arrive with contact
    details masked (app.redaction): the pro's own email and phone, then every contact pattern.
    Never the pro's payout or the platform's fee."""

    approach: str | None = Field(
        description="How the pro will do the job, with contact details masked as in the "
        "scope; null when the pro wrote none."
    )
    pro: QuotePro


class CustomerQuoteList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[CustomerQuote] = Field(
        description="The accepted quote, if any, and the pending ones not yet expired: cheapest "
        "first, then oldest."
    )
