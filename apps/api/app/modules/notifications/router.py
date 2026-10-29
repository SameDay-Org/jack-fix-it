from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.dependencies import CurrentUser
from app.modules.notifications.preferences_service import NotificationPreferenceService
from app.modules.notifications.schemas import (
    MAX_CHANGES,
    NotificationPreferences,
    NotificationPreferencesPatch,
)

router = APIRouter(prefix="/me/notification-preferences", tags=["notifications"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_notification_preference_service(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> NotificationPreferenceService:
    return NotificationPreferenceService(session)


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
}


@router.get(
    "",
    response_model=NotificationPreferences,
    summary="Get my notification preferences",
    responses=_ACCESS,
)
async def get_notification_preferences(
    user: CurrentUser,
    preferences: Annotated[
        NotificationPreferenceService, Depends(get_notification_preference_service)
    ],
) -> NotificationPreferences:
    """Every group with each of its channels: `enabled` is the caller's choice, or the default
    when they never changed it. A `locked` channel is always on (account and security)."""
    return await preferences.get(user.id)


@router.patch(
    "",
    response_model=NotificationPreferences,
    summary="Change my notification preferences",
    responses={
        **_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "preference_locked: a change turns off a locked channel; validation_error: an "
            "unknown group or channel, a channel its group does not have, a group and channel "
            f"twice, no change or more than {MAX_CHANGES}. Either way nothing is stored."
        ),
    },
)
async def update_notification_preferences(
    data: NotificationPreferencesPatch,
    user: CurrentUser,
    preferences: Annotated[
        NotificationPreferenceService, Depends(get_notification_preference_service)
    ],
) -> NotificationPreferences:
    """Applies the changes all or nothing and returns every preference, as GET does. Turning a
    locked channel on is accepted and changes nothing. Pushes muted while a group was off are
    not sent when it is turned back on."""
    return await preferences.update(user.id, data)
