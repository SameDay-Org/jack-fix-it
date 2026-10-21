"""FastAPI dependencies for auth. Protect a route with `Depends(get_current_user)`."""

from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.db import get_session
from app.integrations.email import EmailSender, get_email_sender
from app.integrations.sms_verify import PhoneVerifier, get_phone_verifier
from app.modules.auth.errors import InvalidTokenError
from app.modules.auth.password_reset import (
    PasswordResetConfig,
    PasswordResetService,
    ResetCodeStore,
    get_reset_code_store,
)
from app.modules.auth.phone_service import PhoneVerificationService
from app.modules.auth.schemas import (
    LoginRequest,
    PasswordForgotRequest,
    PasswordResetRequest,
    PhoneSendRequest,
    PhoneVerifyRequest,
)
from app.modules.auth.service import AuthConfig, AuthService, authenticate_access_token
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.rate_limit import (
    IdentifierHasher,
    RateLimiter,
    client_ip,
    enforce_limit,
    get_identifier_hasher,
    get_rate_limiter,
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
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """Login: the per-IP limit first, then the per-email one (the email normalized, hashed)."""
    await enforce_limit(
        limiter,
        "auth_login_email",
        hasher(data.email),
        limit=settings.login_rate_limit_per_email,
        window_seconds=settings.auth_rate_limit_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


def get_phone_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    users: Annotated[UserService, Depends(get_user_service)],
    verifier: Annotated[PhoneVerifier, Depends(get_phone_verifier)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PhoneVerificationService:
    return PhoneVerificationService(session, users, verifier, settings.phone_allowed_country_codes)


async def _limit_phone(
    limiter: RateLimiter,
    hasher: IdentifierHasher,
    settings: Settings,
    scope: str,
    user: UserAccount,
    phone: str,
    limit: int,
) -> None:
    """Per user first, then per phone; the number enters the key only as a keyed hash."""
    for kind, identifier in (("user", str(user.id)), ("phone", hasher(phone))):
        await enforce_limit(
            limiter,
            f"{scope}_{kind}",
            identifier,
            limit=limit,
            window_seconds=settings.auth_rate_limit_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )


async def limit_phone_send(
    # Same names and models as the route's, so FastAPI resolves them once.
    data: PhoneSendRequest,
    user: CurrentUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    await _limit_phone(
        limiter, hasher, settings, "phone_send", user, data.phone, settings.phone_otp_send_limit
    )


async def limit_phone_verify(
    data: PhoneVerifyRequest,
    user: CurrentUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    await _limit_phone(
        limiter, hasher, settings, "phone_check", user, data.phone, settings.phone_otp_check_limit
    )


def get_password_reset_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    users: Annotated[UserService, Depends(get_user_service)],
    store: Annotated[ResetCodeStore, Depends(get_reset_code_store)],
    sender: Annotated[EmailSender, Depends(get_email_sender)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PasswordResetService:
    return PasswordResetService(
        session,
        users,
        store,
        sender,
        hasher,
        limiter,
        PasswordResetConfig.from_settings(settings),
    )


async def _limit_password(
    request: Request,
    limiter: RateLimiter,
    hasher: IdentifierHasher,
    settings: Settings,
    scope: str,
    email: str,
) -> None:
    """Per IP first, then per email; the address enters the key only as a keyed hash."""
    for kind, identifier in (("ip", client_ip(request)), ("email", hasher(email))):
        await enforce_limit(
            limiter,
            f"{scope}_{kind}",
            identifier,
            limit=settings.password_reset_request_limit,
            window_seconds=settings.auth_rate_limit_window_seconds,
            timeout_seconds=settings.rate_limit_timeout_seconds,
        )


async def limit_password_forgot(
    # Same name and model as the route's body, so FastAPI parses the body once.
    data: PasswordForgotRequest,
    request: Request,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    await _limit_password(request, limiter, hasher, settings, "password_forgot", data.email)


async def limit_password_reset(
    data: PasswordResetRequest,
    request: Request,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    hasher: Annotated[IdentifierHasher, Depends(get_identifier_hasher)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    await _limit_password(request, limiter, hasher, settings, "password_reset", data.email)
