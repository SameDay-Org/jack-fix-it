import uuid
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.auth.schemas import E164_PATTERN, NormalizedEmail
from app.modules.service_areas.schemas import ZIP_INPUT_PATTERN
from app.modules.waitlist.models import WaitlistSource


class WaitlistJoin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    zip_code: str = Field(pattern=ZIP_INPUT_PATTERN, description="5 digits or ZIP+4.")
    email: NormalizedEmail | None = None
    phone: str | None = Field(
        default=None, pattern=E164_PATTERN, description="E.164, with an allowed country code."
    )
    category_id: uuid.UUID | None = None
    locale: Literal["en", "es"] = "en"
    source: WaitlistSource

    @model_validator(mode="after")
    def _a_contact(self) -> Self:
        if self.email is None and self.phone is None:
            raise ValueError("email or phone is required")
        return self
