"""FastAPI dependencies for auth. Protect a route with `Depends(get_current_user)`."""

from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.modules.auth.errors import InvalidTokenError
from app.modules.auth.schemas import LoginRequest
from app.modules.auth.service import AuthConfig, AuthService, authenticate_access_token
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.rate_limit import (
    RateLimiter,
    enforce_limit,
    get_rate_limiter,
    hashed_identifier,
    limit_per_ip,
)

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
) -> UserAccount:
    """The active user of `Authorization: Bearer <access token>`, or 401 invalid_token."""
    if credentials is None:
        raise InvalidTokenError
    return await authenticate_access_token(credentials.credentials, users=users, config=config)


CurrentUser = Annotated[UserAccount, Depends(get_current_user)]


# Rate limits on the unauthenticated routes (D4.4, #28): register and login run Argon2.
limit_register = limit_per_ip("auth_register")
limit_login_per_ip = limit_per_ip("auth_login")
limit_refresh = limit_per_ip("auth_refresh")
limit_logout = limit_per_ip("auth_logout")


async def limit_login(
    # Same name and model as the login route's body, so FastAPI parses the body once.
    data: LoginRequest,
    _: Annotated[None, Depends(limit_login_per_ip)],
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """Login: the per-IP limit first, then the per-email one (the email normalized, hashed)."""
    await enforce_limit(
        limiter,
        "auth_login_email",
        hashed_identifier(data.email),
        limit=settings.login_rate_limit_per_email,
        window_seconds=settings.auth_rate_limit_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )
