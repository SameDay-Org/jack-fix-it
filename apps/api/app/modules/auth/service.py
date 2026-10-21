"""Register and login start a session (access + refresh token); refresh rotates it; logout ends it.

A session is a family of refresh tokens: each refresh spends the presented token and issues the
next one. A spent token presented again means it leaked, so its whole family is revoked.
"""

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
    InvalidRefreshTokenError,
    InvalidTokenError,
    PasswordTooShortError,
)
from app.modules.auth.models import RefreshToken
from app.modules.auth.repository import RefreshTokenRepository
from app.modules.auth.schemas import AuthResponse, LoginRequest, RegisterRequest
from app.modules.users.schemas import UserOut
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserStatus

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
        credentials = await self._users.get_credentials_by_email(data.email)
        # One Argon2 verify on every path, so the timing does not tell whether the email exists.
        stored_hash = credentials.password_hash if credentials else security.DUMMY_PASSWORD_HASH
        matches = await asyncio.to_thread(security.verify_password, stored_hash, data.password)
        if credentials is None or not matches:
            reason = "unknown_email" if credentials is None else "bad_password"
            logger.info("auth_login_failed", extra={"reason": reason})
            raise InvalidCredentialsError
        user = credentials.account
        if user.status is UserStatus.SUSPENDED:
            raise AccountSuspendedError
        if security.password_needs_rehash(stored_hash):
            new_hash = await asyncio.to_thread(security.hash_password, data.password)
            await self._users.update_password_hash(user.id, new_hash)
        return await self._start_session(user)

    async def refresh(self, refresh_token: str) -> AuthResponse:
        """Rotates the refresh token: the old one is spent, a new one joins its family."""
        now = datetime.now(UTC)
        token = await self._refresh_tokens.get_by_hash_for_update(
            security.hash_refresh_token(refresh_token)
        )
        if token is None:
            raise InvalidRefreshTokenError
        if token.revoked_at is not None:
            if token.replaced_by_id is not None:
                # Already rotated, so a copy leaked: the owner or a thief holds the newest token.
                logger.warning(
                    "auth_refresh_reuse_detected",
                    extra={"user_id": str(token.user_id), "family_id": str(token.family_id)},
                )
                await self._revoke_family(token.family_id, now)
            raise InvalidRefreshTokenError
        if token.expires_at <= now:
            raise InvalidRefreshTokenError
        user = await self._users.get_by_id(token.user_id)
        if user is None or user.status is not UserStatus.ACTIVE:
            await self._revoke_family(token.family_id, now)
            raise InvalidRefreshTokenError
        new_refresh_token = security.new_refresh_token()
        replacement = await self._add_refresh_token(user, token.family_id, new_refresh_token, now)
        token.revoked_at = now
        token.replaced_by_id = replacement.id
        return await self._issue_tokens(user, new_refresh_token, now)

    async def logout(self, refresh_token: str) -> None:
        """Revokes the session of a known token. An unknown token is ignored, without a sign."""
        token = await self._refresh_tokens.get_by_hash_for_update(
            security.hash_refresh_token(refresh_token)
        )
        if token is not None:
            await self._revoke_family(token.family_id, datetime.now(UTC))

    async def _start_session(self, user: UserAccount) -> AuthResponse:
        """Issues an access token and the first refresh token of a new family, then commits."""
        now = datetime.now(UTC)
        refresh_token = security.new_refresh_token()
        await self._add_refresh_token(user, uuid.uuid4(), refresh_token, now)
        return await self._issue_tokens(user, refresh_token, now)

    async def _add_refresh_token(
        self, user: UserAccount, family_id: uuid.UUID, refresh_token: str, now: datetime
    ) -> RefreshToken:
        return await self._refresh_tokens.add(
            RefreshToken(
                user_id=user.id,
                family_id=family_id,
                token_hash=security.hash_refresh_token(refresh_token),
                expires_at=now + timedelta(seconds=self._config.refresh_token_ttl_seconds),
            )
        )

    async def _issue_tokens(
        self, user: UserAccount, refresh_token: str, now: datetime
    ) -> AuthResponse:
        """Creates the access token, commits the refresh token rows and builds the response."""
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

    async def _revoke_family(self, family_id: uuid.UUID, now: datetime) -> None:
        """Commits at once: on a failed refresh the revocation must outlive the error."""
        await self._refresh_tokens.revoke_family(family_id, now)
        await self._session.commit()


async def authenticate_access_token(
    token: str, *, users: UserService, config: AuthConfig
) -> UserAccount:
    """The active user the access token belongs to. Raises InvalidTokenError otherwise."""
    try:
        claims = security.decode_access_token(token, secret=config.jwt_secret)
    except security.InvalidAccessTokenError:
        raise InvalidTokenError from None
    user = await users.get_by_id(claims.user_id)
    if user is None or user.status is not UserStatus.ACTIVE:
        raise InvalidTokenError
    return user
