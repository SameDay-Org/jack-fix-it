import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.categories.schemas import CategorySummary
from app.modules.pros.models import ProVerificationStatus
from app.modules.service_areas.schemas import ServiceAreaOut

MAX_YEARS_OF_EXPERIENCE = 80  # the pro_profiles CHECK


class PhotoOut(BaseModel):
    url: str = Field(description="Presigned GET URL.")
    expires_at: datetime


class ProProfileOut(BaseModel):
    bio: str | None
    years_of_experience: int | None
    photo: PhotoOut | None
    verification_status: ProVerificationStatus
    payouts_enabled: bool
    categories: list[CategorySummary]
    service_areas: list[ServiceAreaOut]


class ProProfileUpdate(BaseModel):
    """Only the fields sent change. Verification, payouts, rating and job count are set by the
    platform: sending them is a 422 (extra="forbid")."""

    model_config = ConfigDict(extra="forbid")

    bio: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000, pattern=NO_NUL)]
        | None
    ) = Field(default=None, description="An empty string or null clears it.")
    years_of_experience: int | None = Field(default=None, ge=0, le=MAX_YEARS_OF_EXPERIENCE)
    photo_key: str | None = Field(
        default=None,
        description="Key of the caller's own profile_photo upload (POST /v1/uploads); null clears.",
    )
    category_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description="Replaces the set: active categories, no duplicates, up to PRO_MAX_CATEGORIES.",
    )
    service_area_ids: list[uuid.UUID] = Field(
        default_factory=list,
        description=(
            "Replaces the set: active service areas, no duplicates, up to PRO_MAX_SERVICE_AREAS."
        ),
    )
