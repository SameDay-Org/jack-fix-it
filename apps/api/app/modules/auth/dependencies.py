"""FastAPI dependencies for auth. Protect a route with `Depends(get_current_user)`."""

from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.modules.auth.errors import InvalidTokenError
from app.modules.auth.service import AuthConfig, AuthService, authenticate_access_token
from app.modules.users.models import User
from app.modules.users.service import UserService

# auto_error=False: a missing or non-Bearer header becomes our 401 invalid_token, not FastAPI's.
_bearer = HTTPBearer(auto_error=False, bearerFormat="JWT")


def get_auth_config(settings: Annotated[Settings, Depends(get_app_settings)]) -> AuthConfig:
    return AuthConfig.from_settings(settings)


def get_user_service(session: Annotated[AsyncSession, Depends(get_session)]) -> UserService:
    return UserService(session)


def get_auth_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    users: Annotated[UserService, Depends(get_user_service)],
    config: Annotated[AuthConfig, Depends(get_auth_config)],
) -> AuthService:
    return AuthService(session, users, config)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    users: Annotated[UserService, Depends(get_user_service)],
    config: Annotated[AuthConfig, Depends(get_auth_config)],
) -> User:
    """The active user of `Authorization: Bearer <access token>`, or 401 invalid_token."""
    if credentials is None:
        raise InvalidTokenError
    return await authenticate_access_token(credentials.credentials, users=users, config=config)


CurrentUser = Annotated[User, Depends(get_current_user)]
