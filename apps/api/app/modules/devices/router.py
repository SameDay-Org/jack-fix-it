from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import AppUser
from app.modules.devices.schemas import DeviceRegistration, DeviceRemoval
from app.modules.devices.service import DeviceService

router = APIRouter(prefix="/devices", tags=["devices"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_device_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> DeviceService:
    return DeviceService(session, settings.push_max_devices_per_user)


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only customers and pros receive pushes."),
    status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
        "validation_error: not an Expo push token, or an unknown platform."
    ),
}


@router.put(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Register this device for pushes",
    responses={status.HTTP_204_NO_CONTENT: {"description": "Registered."}, **_ACCESS},
)
async def register_device(
    data: DeviceRegistration,
    user: AppUser,
    devices: Annotated[DeviceService, Depends(get_device_service)],
) -> None:
    """Registers the app's Expo push token for the caller; call it at every start.

    A token already registered to someone else (the phone changed hands) moves to the caller.
    Past PUSH_MAX_DEVICES_PER_USER, the caller's least recently seen device is dropped.
    """
    await devices.register(user, data)


@router.delete(
    "",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Stop pushes to this device",
    responses={
        status.HTTP_204_NO_CONTENT: {
            "description": "Always, whether or not the token was registered to the caller."
        },
        **_ACCESS,
    },
)
async def unregister_device(
    data: DeviceRemoval,
    user: AppUser,
    devices: Annotated[DeviceService, Depends(get_device_service)],
) -> None:
    """Removes the caller's token; the app calls it on logout. The token travels in the body,
    never in the path, because paths are logged."""
    await devices.unregister(user, data.expo_push_token)
