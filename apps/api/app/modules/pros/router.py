from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import Storage, get_storage
from app.modules.auth.permissions import ProUser
from app.modules.categories.service import CategoryService
from app.modules.pros.schemas import ProProfileOut, ProProfileUpdate
from app.modules.pros.service import ProProfileConfig, ProProfileService
from app.modules.service_areas.service import ServiceAreaService

router = APIRouter(prefix="/pros", tags=["pros"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_pro_profile_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[Storage, Depends(get_storage)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ProProfileService:
    return ProProfileService(
        session,
        CategoryService(session),
        ServiceAreaService(session),
        storage,
        ProProfileConfig.from_settings(settings),
    )


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only pros have a pro profile."),
}


@router.get("/me", response_model=ProProfileOut, summary="Get my pro profile", responses=_ACCESS)
async def get_my_profile(
    user: ProUser, profiles: Annotated[ProProfileService, Depends(get_pro_profile_service)]
) -> ProProfileOut:
    """The caller's own profile, with a presigned URL for the photo. The first call creates an
    empty profile, pending verification."""
    return await profiles.get_own(user)


@router.patch(
    "/me",
    response_model=ProProfileOut,
    summary="Edit my pro profile",
    responses={
        **_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "invalid_media: photo_key is not the caller's own profile_photo upload; "
            "invalid_category / invalid_service_area: an unknown or inactive id; "
            "validation_error: any other invalid field (duplicates or too many ids, bio length, "
            "years out of range, fields the platform sets such as verification_status)."
        ),
    },
)
async def update_my_profile(
    data: ProProfileUpdate,
    user: ProUser,
    profiles: Annotated[ProProfileService, Depends(get_pro_profile_service)],
) -> ProProfileOut:
    """Changes only the fields sent, in one transaction. category_ids and service_area_ids
    replace the whole set. Upload the photo first (POST /v1/uploads, purpose profile_photo)."""
    return await profiles.update_own(user, data)
