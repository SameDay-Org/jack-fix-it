import uuid
from datetime import date, datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints

from app.modules.addresses.schemas import NO_NUL, AddressIn, AddressOut
from app.modules.requests.models import RequestMediaKind, RequestStatus

UtmValue = Annotated[str, StringConstraints(max_length=100, pattern=NO_NUL)]


class UtmIn(BaseModel):
    """Campaign attribution. Only these five keys; anything else is a 422."""

    model_config = ConfigDict(extra="forbid")

    source: UtmValue | None = None
    medium: UtmValue | None = None
    campaign: UtmValue | None = None
    term: UtmValue | None = None
    content: UtmValue | None = None


class RequestCreate(BaseModel):
    # extra="forbid": urgency and preferred_contact are not accepted yet (their values come
    # with the request flow, #45), and a client sending them gets a 422, not silence.
    model_config = ConfigDict(extra="forbid")

    description: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=2000, pattern=NO_NUL),
    ]
    category_id: uuid.UUID | None = None
    address: AddressIn
    preferred_date: date | None = Field(default=None, description="Today or later, as a UTC date.")
    intake_answers: dict[str, JsonValue] = Field(
        default_factory=dict,
        description=(
            "Answers to the category's intake questions; a size limit applies. NUL "
            "characters and non-finite numbers are refused."
        ),
    )
    # No per-key length bound: an overlong key fails KEY_PATTERN and answers invalid_media.
    media_keys: list[str] = Field(
        default_factory=list,
        description="Keys of the caller's own request_media uploads (POST /v1/uploads).",
    )
    utm: UtmIn | None = None


class MediaOut(BaseModel):
    kind: RequestMediaKind
    url: str = Field(description="Presigned GET URL.")
    expires_at: datetime


class RequestOut(BaseModel):
    id: uuid.UUID
    public_code: str = Field(description="The code shown to the customer, e.g. JF-000124.")
    status: RequestStatus
    customer_status: str = Field(description="The glossary i18n key the customer sees.")
    category_id: uuid.UUID | None
    description: str
    address: AddressOut
    preferred_date: date | None
    intake_answers: dict[str, JsonValue]
    media: list[MediaOut]
    created_at: datetime


class RequestSummary(BaseModel):
    id: uuid.UUID
    public_code: str
    status: RequestStatus
    customer_status: str
    category_id: uuid.UUID | None
    created_at: datetime
    media_count: int


class RequestPage(BaseModel):
    items: list[RequestSummary]
    next_cursor: str | None = Field(description="Pass as `cursor` for the next page.")
