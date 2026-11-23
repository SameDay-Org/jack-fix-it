from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.config import TERMS_VERSION_PATTERN
from app.modules.terms.models import VERSION_MAX_LENGTH
from app.modules.terms.types import TermsKind


class TermsDocumentOut(BaseModel):
    kind: TermsKind = Field(description="terms, privacy or pro_agreement (pros only).")
    version: str = Field(description="The version in force: the id of the text the app shows.")
    accepted: bool = Field(description="Whether the caller accepted this version.")
    accepted_at: datetime | None = Field(
        description="When the caller first accepted this version; null until then."
    )


class TermsOut(BaseModel):
    terms_required: bool = Field(
        description="True while a document below is not accepted: the app asks for it before "
        "anything else. False when nothing is in force yet."
    )
    documents: list[TermsDocumentOut] = Field(
        description="The documents in force for the caller's role, with a version published."
    )


class TermsAcceptanceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: TermsKind
    version: str = Field(
        pattern=TERMS_VERSION_PATTERN,
        max_length=VERSION_MAX_LENGTH,
        description="The version the app showed, as GET /v1/me/terms gave it.",
    )
