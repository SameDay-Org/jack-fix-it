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
