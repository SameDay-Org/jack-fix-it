from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.auth.schemas import NormalizedEmail
from app.modules.interest.models import CONSENT_VERSION_MAX_LENGTH, InterestSource

# Letters, digits, dot, dash and underscore: an id, never free text.
CONSENT_VERSION_PATTERN: Final = (
    rf"^[A-Za-z0-9][A-Za-z0-9._-]{{0,{CONSENT_VERSION_MAX_LENGTH - 1}}}$"
)


class InterestJoin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: NormalizedEmail = Field(
        description="Trimmed and lowercased before it is checked and stored."
    )
    locale: Literal["en", "es"] = Field(default="en", description="The page's language.")
    source: InterestSource = Field(
        default=InterestSource.SHOWCASE, description="Where the form was: showcase only."
    )
    consent_version: str = Field(
        pattern=CONSENT_VERSION_PATTERN,
        description="The id of the consent words the visitor saw, stored with the time of the "
        'join (e.g. "interest-2026-11-19"): letters, digits, ".", "-" and "_", 1 to '
        f"{CONSENT_VERSION_MAX_LENGTH} characters.",
    )
