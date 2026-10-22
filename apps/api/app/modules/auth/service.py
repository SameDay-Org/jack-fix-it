"""Register and login start a session (access + refresh token); refresh rotates it; logout ends it.

A session is a family of refresh tokens: each refresh spends the presented token and issues the
next one. A spent token presented again means it leaked, so its whole family is revoked.
"""

import asyncio
import hmac
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import REFRESH_ROTATION_SECRET_REQUIRED_IN, Settings
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
from app.modules.auth.schemas import (
    AuthResponse,
    LoginRequest,
    MeUpdateRequest,
    RegisterRequest,
)
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
    refresh_rotation_key: str
    refresh_reuse_grace_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "AuthConfig":
        # Settings already requires the secret in staging and production. Elsewhere a missing
        # one is a server misconfiguration: a generic, logged 500, never a client error.
        if settings.jwt_secret is None:
            raise RuntimeError("JWT_SECRET is not set; auth endpoints are unavailable")
        if settings.refresh_rotation_secret is not None:
            rotation_key = settings.refresh_rotation_secret.get_secret_value()
        elif settings.app_env in REFRESH_ROTATION_SECRET_REQUIRED_IN:
            # Settings already refuses this; a hand-built Settings must not reach the fallback.
            raise RuntimeError("REFRESH_ROTATION_SECRET is not set")
        else:
            rotation_key = security.DEVELOPMENT_ROTATION_KEY
        return cls(
            jwt_secret=settings.jwt_secret.get_secret_value(),
            access_token_ttl_seconds=settings.access_token_ttl_seconds,
            refresh_token_ttl_seconds=settings.refresh_token_ttl_seconds,
            password_min_length=settings.password_min_length,
            refresh_rotation_key=rotation_key,
            refresh_reuse_grace_seconds=settings.refresh_reuse_grace_seconds,
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
            email=data.email,
            password_hash=password_hash,
            role=data.role,
            locale=data.locale,
            first_name=data.first_name,
            last_name=data.last_name,
        )
        return await self._start_session(user)

    async def update_me(self, user: UserAccount, data: MeUpdateRequest) -> UserOut:
        """Sets the caller's own names and commits. Names are never logged."""
        account = await self._users.update_names(
            user.id, first_name=data.first_name, last_name=data.last_name
        )
        await self._session.commit()
        return UserOut.model_validate(account)

    async def login(self, data: LoginRequest) -> AuthResponse:
        credentials = await self._users.get_credentials_by_email(data.email)
        # One Argon2 verify on every path, so the timing does not tell whether the email exists.
        # No lock before it: a wrong password never waits on, or holds, the user row, so
        # concurrency cannot tell a known email from an unknown one either.
        stored_hash = credentials.password_hash if credentials else security.DUMMY_PASSWORD_HASH
        matches = await asyncio.to_thread(security.verify_password, stored_hash, data.password)
        if credentials is None or not matches:
            reason = "unknown_email" if credentials is None else "bad_password"
            logger.info("auth_login_failed", extra={"reason": reason})
            raise InvalidCredentialsError
        # The password matched: lock the user row until the session is committed, and check
        # that nothing changed since the verify. A password reset that committed meanwhile
        # changed the hash, so this login fails; one that starts now waits for this session,
        # then revokes it. A rehash below can never overwrite a newer password.
        locked = await self._users.get_credentials_by_email(data.email, lock=True)
        if locked is None or locked.password_hash != stored_hash:
            logger.info("auth_login_failed", extra={"reason": "changed_during_login"})
            raise InvalidCredentialsError
        user = locked.account
        if user.status is UserStatus.SUSPENDED:
            raise AccountSuspendedError
        if security.password_needs_rehash(stored_hash):
            new_hash = await asyncio.to_thread(security.hash_password, data.password)
            await self._users.update_password_hash(user.id, new_hash)
        return await self._start_session(user)

    async def refresh(self, refresh_token: str) -> AuthResponse:
        """Rotates the refresh token: the old one is spent, its successor joins the family.

        The successor is derived from the old token (successor_refresh_token), so presenting the
        old token again within REFRESH_REUSE_GRACE_SECONDS, while the successor is still unused,
        returns that same successor: the app retried after losing the response (#152). Any other
        reuse of a rotated token is theft, and the family is revoked.
        """
        now = datetime.now(UTC)
        token = await self._refresh_tokens.get_by_hash_for_update(
            security.hash_refresh_token(refresh_token)
        )
        if token is None:
            raise InvalidRefreshTokenError
        if token.revoked_at is not None:
            if token.replaced_by_id is not None:
                replay = await self._grace_replay(token, refresh_token, now)
                if replay is not None:
                    return replay
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
        new_refresh_token = security.successor_refresh_token(
            refresh_token, self._config.refresh_rotation_key
        )
        replacement = await self._add_refresh_token(user, token.family_id, new_refresh_token, now)
        token.revoked_at = now
        token.replaced_by_id = replacement.id
        return await self._issue_tokens(user, new_refresh_token, now)

    async def _grace_replay(
        self, token: RefreshToken, presented: str, now: datetime
    ) -> AuthResponse | None:
        """The same successor again, if `token` was rotated within the grace window and that
        successor is still unused and unexpired; None otherwise (the caller treats it as reuse).

        The family lock taken by get_by_hash_for_update serializes concurrent retries. No row is
        created and no expiry changes: the client simply gets back what it lost.
        """
        grace = self._config.refresh_reuse_grace_seconds
        if token.revoked_at is None or token.replaced_by_id is None or grace <= 0:
            return None
        if now - token.revoked_at > timedelta(seconds=grace):
            return None
        successor = await self._refresh_tokens.get_by_id(token.replaced_by_id)
        if successor is None or successor.revoked_at is not None or successor.expires_at <= now:
            return None
        raw = security.successor_refresh_token(presented, self._config.refresh_rotation_key)
        if not hmac.compare_digest(security.hash_refresh_token(raw), successor.token_hash):
            return None  # a successor issued before #152 was random: it cannot be re-derived
        user = await self._users.get_by_id(token.user_id)
        if user is None or user.status is not UserStatus.ACTIVE:
            return None
        logger.info(
            "auth_refresh_grace_replay",
            extra={"user_id": str(token.user_id), "family_id": str(token.family_id)},
        )
        return await self._issue_tokens(user, raw, now)

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
