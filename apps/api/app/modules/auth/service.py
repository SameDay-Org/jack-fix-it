"""Register and login: verify the password, then start a session (access + refresh token)."""

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.auth import security
from app.modules.auth.errors import (
    AccountSuspendedError,
    InvalidCredentialsError,
    InvalidTokenError,
    PasswordTooShortError,
)
from app.modules.auth.models import RefreshToken
from app.modules.auth.repository import RefreshTokenRepository
from app.modules.auth.schemas import AuthResponse, LoginRequest, RegisterRequest
from app.modules.users.models import User, UserStatus
from app.modules.users.schemas import UserOut
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthConfig:
    jwt_secret: str
    access_token_ttl_seconds: int
    refresh_token_ttl_seconds: int
    password_min_length: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "AuthConfig":
        # Settings already requires the secret in staging and production. Elsewhere a missing
        # one is a server misconfiguration: a generic, logged 500, never a client error.
        if settings.jwt_secret is None:
            raise RuntimeError("JWT_SECRET is not set; auth endpoints are unavailable")
        return cls(
            jwt_secret=settings.jwt_secret.get_secret_value(),
            access_token_ttl_seconds=settings.access_token_ttl_seconds,
            refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
            password_min_length=settings.password_min_length,
        )


class AuthService:
    def __init__(self, session: AsyncSession, users: UserService, config: AuthConfig) -> None:
        self._session = session
        self._users = users
        self._refresh_tokens = RefreshTokenRepository(session)
        self._config = config

    async def register(self, data: RegisterRequest) -> AuthResponse:
        if len(data.password) < self._config.password_min_length:
            raise PasswordTooShortError
        password_hash = await asyncio.to_thread(security.hash_password, data.password)
        user = await self._users.create_user(
            email=data.email, password_hash=password_hash, role=data.role, locale=data.locale
        )
        return await self._start_session(user)

    async def login(self, data: LoginRequest) -> AuthResponse:
        user = await self._users.get_by_email(data.email)
        # One Argon2 verify on every path, so the timing does not tell whether the email exists.
        stored_hash = user.password_hash if user else security.DUMMY_PASSWORD_HASH
        matches = await asyncio.to_thread(security.verify_password, stored_hash, data.password)
        if user is None or not matches:
            reason = "unknown_email" if user is None else "bad_password"
            logger.info("auth_login_failed", extra={"reason": reason})
            raise InvalidCredentialsError
        if user.status is UserStatus.SUSPENDED:
            logger.info("auth_login_failed", extra={"reason": "account_suspended"})
            raise AccountSuspendedError
        if security.password_needs_rehash(user.password_hash):
            new_hash = await asyncio.to_thread(security.hash_password, data.password)
            await self._users.update_password_hash(user, new_hash)
        return await self._start_session(user)

    async def _start_session(self, user: User) -> AuthResponse:
        """Issues an access token and the first refresh token of a new family, then commits."""
        now = datetime.now(UTC)
        refresh_token = security.new_refresh_token()
        await self._refresh_tokens.add(
            RefreshToken(
                user_id=user.id,
                family_id=uuid.uuid4(),
                token_hash=security.hash_refresh_token(refresh_token),
                expires_at=now + timedelta(seconds=self._config.refresh_token_ttl_seconds),
            )
        )
        access_token = security.create_access_token(
            user_id=user.id,
            role=user.role,
            secret=self._config.jwt_secret,
            ttl_seconds=self._config.access_token_ttl_seconds,
            now=now,
        )
        await self._session.commit()
        return AuthResponse(
            user=UserOut.model_validate(user),
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=self._config.access_token_ttl_seconds,
        )


async def authenticate_access_token(token: str, *, users: UserService, config: AuthConfig) -> User:
    """The active user the access token belongs to. Raises InvalidTokenError otherwise."""
    try:
        claims = security.decode_access_token(token, secret=config.jwt_secret)
    except security.InvalidAccessTokenError:
        raise InvalidTokenError from None
    user = await users.get_by_id(claims.user_id)
    if user is None or user.status is not UserStatus.ACTIVE:
        raise InvalidTokenError
    return user
