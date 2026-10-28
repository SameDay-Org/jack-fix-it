import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.addresses.schemas import (
    LABEL_MAX_LENGTH,
    SavedAddressIn,
    SavedAddressList,
    SavedAddressOut,
    SavedAddressPatch,
)
from app.modules.addresses.service import SavedAddressService
from app.modules.auth.permissions import CustomerUser
from app.modules.service_areas.service import ServiceAreaService

router = APIRouter(prefix="/addresses", tags=["addresses"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_saved_address_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> SavedAddressService:
    return SavedAddressService(
        session, ServiceAreaService(session), settings.saved_addresses_max_per_user
    )


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only customers keep saved addresses."),
}
_NOT_FOUND = _error(
    "address_not_found: no saved address of the caller with this id (another user's id "
    "answers the same)."
)
_LABEL_TAKEN = (
    "address_label_taken: the caller already has an address with this label, ignoring case"
)
_FIELDS = (
    f"validation_error: a label empty, longer than {LABEL_MAX_LENGTH} characters, with a "
    "control or format character or a contact detail; an address field out of format; lat or "
    "lng alone or out of range"
)


@router.get(
    "",
    response_model=SavedAddressList,
    summary="List my saved addresses",
    responses=_ACCESS,
)
async def list_saved_addresses(
    user: CustomerUser,
    addresses: Annotated[SavedAddressService, Depends(get_saved_address_service)],
) -> SavedAddressList:
    """The caller's address book: the default first, then the oldest first. `served` tells
    whether the ZIP has an active service area; when it does not, offer the waitlist."""
    return await addresses.list_own(user)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SavedAddressOut,
    summary="Save an address",
    responses={
        **_ACCESS,
        status.HTTP_409_CONFLICT: _error(
            "address_limit_reached: the caller already keeps the most addresses allowed; "
            f"{_LABEL_TAKEN}."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(f"{_FIELDS}."),
    },
)
async def create_saved_address(
    data: SavedAddressIn,
    user: CustomerUser,
    addresses: Annotated[SavedAddressService, Depends(get_saved_address_service)],
) -> SavedAddressOut:
    """Adds an address to the caller's book. The first one is the default; `is_default` makes
    the new one the default instead. An unserved ZIP is saved too, with `served` false."""
    return await addresses.create(user, data)


@router.patch(
    "/{address_id}",
    response_model=SavedAddressOut,
    summary="Edit a saved address",
    responses={
        **_ACCESS,
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_409_CONFLICT: _error(f"{_LABEL_TAKEN}."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            f"{_FIELDS}; is_default false (make another address the default instead); a "
            "required field null; an address_id that is not a UUID."
        ),
    },
)
async def update_saved_address(
    address_id: uuid.UUID,
    data: SavedAddressPatch,
    user: CustomerUser,
    addresses: Annotated[SavedAddressService, Depends(get_saved_address_service)],
) -> SavedAddressOut:
    """Changes any subset of the fields of one of the caller's addresses. `is_default: true`
    moves the default here. A request created from this address keeps its own copy."""
    return await addresses.update(user, address_id, data)


@router.delete(
    "/{address_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Delete a saved address",
    responses={
        status.HTTP_204_NO_CONTENT: {
            "description": "Deleted. If it was the default, the oldest remaining address is."
        },
        **_ACCESS,
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an address_id that is not a UUID."
        ),
    },
)
async def delete_saved_address(
    address_id: uuid.UUID,
    user: CustomerUser,
    addresses: Annotated[SavedAddressService, Depends(get_saved_address_service)],
) -> None:
    """Removes one of the caller's addresses. Requests created from it are not affected."""
    await addresses.delete(user, address_id)
