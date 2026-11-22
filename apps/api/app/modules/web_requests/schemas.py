import uuid
from datetime import date
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints

from app.modules.addresses.schemas import NO_NUL, AddressIn
from app.modules.auth.schemas import E164_PATTERN, NormalizedEmail
from app.modules.requests.queue import RequestStatus
from app.modules.requests.schemas import UtmIn
from app.modules.requests.service import PreferredPeriod
from app.modules.users.names import PersonName
from app.modules.web_requests.models import CONSENT_VERSION_MAX_LENGTH

# Letters, digits, dot, dash and underscore: an id, never free text.
CONSENT_VERSION_PATTERN: Final = (
    rf"^[A-Za-z0-9][A-Za-z0-9._-]{{0,{CONSENT_VERSION_MAX_LENGTH - 1}}}$"
)
# The honeypot: a field people never see. Bounded so it cannot carry a body of its own.
HONEYPOT_MAX_LENGTH: Final = 200


class WebContactIn(BaseModel):
    """Who the BDC calls back: staff only, never shown to a pro or in a log."""

    model_config = ConfigDict(extra="forbid")

    first_name: PersonName
    email: NormalizedEmail = Field(description="Trimmed and lowercased.")
    phone: str = Field(pattern=E164_PATTERN, description="E.164, with an allowed country code.")


class WebRequestIn(BaseModel):
    """A request made on the web without an account (#86): what the app's create takes, without
    media, plus who to call and the consent the visitor gave."""

    model_config = ConfigDict(extra="forbid")

    description: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=2000, pattern=NO_NUL),
    ]
    category_id: uuid.UUID | None = None
    address: AddressIn
    preferred_date: date | None = Field(default=None, description="Today or later, as a UTC date.")
    preferred_period: PreferredPeriod | None = Field(
        default=None,
        description="When in the preferred date; as POST /v1/requests takes it.",
    )
    intake_answers: dict[str, JsonValue] = Field(
        default_factory=dict,
        description="Answers to the category's intake_questions, checked as POST /v1/requests "
        "checks them (the same schema and size limit).",
    )
    utm: UtmIn | None = None
    contact: WebContactIn
    consent_version: str = Field(
        pattern=CONSENT_VERSION_PATTERN,
        description="The id of the consent words the visitor saw, stored with the time: letters, "
        f'digits, ".", "-" and "_", 1 to {CONSENT_VERSION_MAX_LENGTH} characters.',
    )
    locale: Literal["en", "es"] = Field(default="en", description="The page's language.")
    website: str = Field(
        default="",
        max_length=HONEYPOT_MAX_LENGTH,
        description="The form's honeypot, hidden from people: leave it empty. A request with "
        "it filled in is answered as usual and stored nowhere.",
    )


class WebRequestCreated(BaseModel):
    public_code: str = Field(description="The code the BDC and the customer name it by.")
    status: Literal[RequestStatus.RECEIVED] = Field(
        description="Always received: the BDC reviews it and calls."
    )
