import uuid
from datetime import UTC, datetime
from typing import Annotated, Final

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.modules.addresses.schemas import NO_NUL
from app.modules.quotes.models import QuoteStatus
from app.modules.settings.service import INT4_MAX

SCOPE_MAX_LENGTH: Final = 2000  # what's included; the request description has the same bound


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
    duration_minutes: int = Field(
        gt=0, le=INT4_MAX, strict=True, description="Estimated duration of the work."
    )
    proposed_start_at: AwareDatetime = Field(description="When the pro proposes to start.")

    @field_validator("proposed_start_at")
    @classmethod
    def _in_the_future(cls, value: datetime) -> datetime:
        if value <= datetime.now(UTC):
            raise ValueError("must be in the future")
        return value


class QuoteOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    amount_cents: int
    scope: str
    duration_minutes: int
    proposed_start_at: datetime
    expires_at: datetime
    status: QuoteStatus
    created_at: datetime


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


class CustomerQuote(QuoteOut):
    """A quote on the customer's request (#188). `scope` arrives with contact details masked
    (app.redaction): the pro's own email and phone, then every contact pattern."""

    pro: QuotePro


class CustomerQuoteList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[CustomerQuote] = Field(
        description="The accepted quote, if any, and the pending ones not yet expired: cheapest "
        "first, then oldest."
    )
