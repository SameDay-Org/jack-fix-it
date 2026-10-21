"""Settings, read only from environment variables (plus apps/api/.env for local development)."""

import re
from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from starlette.requests import Request

AppEnv = Literal["development", "test", "staging", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

_ASYNC_SCHEME = "postgresql+asyncpg://"
_SYNC_SCHEMES = ("postgres://", "postgresql://")

# Environments where a missing or weak JWT_SECRET stops startup.
_JWT_SECRET_REQUIRED_IN: tuple[AppEnv, ...] = ("staging", "production")
JWT_SECRET_MIN_LENGTH = 32
# Twilio Verify settings that deployed environments must set (D4.3, #26).
_TWILIO_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
_TWILIO_SETTINGS: tuple[str, ...] = (
    "twilio_account_sid",
    "twilio_auth_token",
    "twilio_verify_service_sid",
)
# Upper bound on passwords (NIST 800-63B allows a cap); also bounds the Argon2 input.
PASSWORD_MAX_LENGTH = 128


def normalize_database_url(url: str) -> str:
    """Railway gives postgres:// or postgresql://; SQLAlchemy async needs postgresql+asyncpg://."""
    if url.startswith(_ASYNC_SCHEME):
        return url
    for scheme in _SYNC_SCHEMES:
        if url.startswith(scheme):
            return _ASYNC_SCHEME + url.removeprefix(scheme)
    raise ValueError(
        "DATABASE_URL must start with postgres://, postgresql:// or postgresql+asyncpg://"
    )


def parse_country_codes(value: str) -> list[str]:
    """Split a CSV of calling codes such as "+1,+52"; ignore blanks."""
    return [code.strip() for code in value.split(",") if code.strip()]


def parse_cors_origins(value: str) -> list[str]:
    """Split a CSV of origins; ignore blanks and trailing slashes."""
    return [origin.strip().rstrip("/") for origin in value.split(",") if origin.strip()]


class Settings(BaseSettings):
    # hide_input_in_errors: a validation error must not print env values such as secrets.
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    app_env: AppEnv = "development"
    log_level: LogLevel = "INFO"
    # "::" listens on IPv6 and IPv4; Railway's private network is reached over IPv6.
    host: str = "::"
    port: int = 8000
    database_url: str
    redis_url: str
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    sentry_dsn: str | None = None
    health_check_timeout_seconds: float = Field(default=2.0, gt=0)
    # Required in staging and production; without it, auth endpoints answer a generic 500.
    jwt_secret: SecretStr | None = None
    access_token_ttl_seconds: int = Field(default=900, gt=0)
    refresh_token_ttl_seconds: int = Field(default=2_592_000, gt=0)
    password_min_length: int = Field(default=10, gt=0, le=PASSWORD_MAX_LENGTH)
    # Unauthenticated auth routes (D4.4, #28): requests per client IP per route per window,
    # and logins per email over the same window.
    auth_rate_limit_requests: int = Field(default=10, gt=0)
    auth_rate_limit_window_seconds: int = Field(default=60, gt=0)
    login_rate_limit_per_email: int = Field(default=5, gt=0)
    # Longest wait on Redis for one limit check; past it the request goes through (fail open).
    rate_limit_timeout_seconds: float = Field(default=0.5, gt=0)
    # Proxies whose X-Forwarded-For uvicorn trusts for the client IP (CSV, or "*").
    forwarded_allow_ips: str = "127.0.0.1"
    # Phone verification by SMS code through Twilio Verify (D4.3, #26). Required in staging and
    # production; without them, the phone endpoints answer a generic 500.
    twilio_account_sid: str | None = None
    twilio_auth_token: SecretStr | None = None
    twilio_verify_service_sid: str | None = None
    twilio_timeout_seconds: float = Field(default=5.0, gt=0)
    # Calling codes a phone may start with (CSV): the service region, never hardcoded.
    phone_allowed_country_codes: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["+1"]
    )
    # Codes sent and codes checked, per user and per phone, per AUTH_RATE_LIMIT_WINDOW_SECONDS.
    phone_otp_send_limit: int = Field(default=3, gt=0)
    phone_otp_check_limit: int = Field(default=5, gt=0)

    @field_validator("database_url")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        return normalize_database_url(value)

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, value: object) -> object:
        return parse_cors_origins(value) if isinstance(value, str) else value

    @field_validator("cors_origins")
    @classmethod
    def _reject_wildcard_origin(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError("CORS_ORIGINS must list explicit origins, not '*'")
        return value

    @field_validator("phone_allowed_country_codes", mode="before")
    @classmethod
    def _split_country_codes(cls, value: object) -> object:
        return parse_country_codes(value) if isinstance(value, str) else value

    @field_validator("phone_allowed_country_codes")
    @classmethod
    def _check_country_codes(cls, value: list[str]) -> list[str]:
        if not value or not all(re.fullmatch(r"\+[1-9]\d{0,3}", code) for code in value):
            raise ValueError("PHONE_ALLOWED_COUNTRY_CODES must list calling codes such as +1")
        return value

    @field_validator(
        "sentry_dsn",
        "jwt_secret",
        "twilio_account_sid",
        "twilio_auth_token",
        "twilio_verify_service_sid",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def _require_jwt_secret_when_deployed(self) -> Self:
        if self.app_env not in _JWT_SECRET_REQUIRED_IN:
            return self
        secret = self.jwt_secret.get_secret_value() if self.jwt_secret else ""
        if len(secret) < JWT_SECRET_MIN_LENGTH:
            raise ValueError(
                f"JWT_SECRET must be set to at least {JWT_SECRET_MIN_LENGTH} characters "
                f"when APP_ENV is {self.app_env}"
            )
        return self

    @model_validator(mode="after")
    def _require_twilio_when_deployed(self) -> Self:
        if self.app_env not in _TWILIO_REQUIRED_IN:
            return self
        missing = [name.upper() for name in _TWILIO_SETTINGS if getattr(self, name) is None]
        if missing:
            raise ValueError(f"{', '.join(missing)} must be set when APP_ENV is {self.app_env}")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


def get_app_settings(request: Request) -> Settings:
    """FastAPI dependency: the settings the running app was built with."""
    settings: Settings = request.app.state.settings
    return settings
