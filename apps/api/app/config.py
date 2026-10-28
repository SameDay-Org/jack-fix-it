"""Settings, read only from environment variables (plus apps/api/.env for local development)."""

import re
from functools import lru_cache
from typing import Annotated, Literal, Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from starlette.requests import Request

AppEnv = Literal["development", "test", "staging", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
# What the orphan upload sweep does (#191): nothing, count only, or delete.
OrphanUploadMode = Literal["off", "dry_run", "delete"]

_ASYNC_SCHEME = "postgresql+asyncpg://"
_SYNC_SCHEMES = ("postgres://", "postgresql://")

# Environments where a missing or weak JWT_SECRET stops startup.
_JWT_SECRET_REQUIRED_IN: tuple[AppEnv, ...] = ("staging", "production")
JWT_SECRET_MIN_LENGTH = 32
# Object storage settings that deployed environments must set (D6.2, #35).
_STORAGE_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
_STORAGE_SETTINGS: tuple[str, ...] = (
    "s3_endpoint_url",
    "s3_bucket",
    "s3_access_key_id",
    "s3_secret_access_key",
)
MIB = 1024 * 1024
# Twilio Verify settings that deployed environments must set (D4.3, #26).
_TWILIO_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
_TWILIO_SETTINGS: tuple[str, ...] = (
    "twilio_account_sid",
    "twilio_auth_token",
    "twilio_verify_service_sid",
)
# The HMAC key for PII in rate-limit keys (#137): required where a weak one stops startup.
RATE_LIMIT_KEY_SECRET_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
RATE_LIMIT_KEY_SECRET_MIN_LENGTH = 32
# The HMAC key that derives each rotated refresh token (#152): required when deployed.
REFRESH_ROTATION_SECRET_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
REFRESH_ROTATION_SECRET_MIN_LENGTH = 32
# Email through Resend (D4.3, #27): deployed environments must be able to send.
_EMAIL_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
_EMAIL_SETTINGS: tuple[str, ...] = ("resend_api_key", "email_from")
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


def parse_codecs(value: str) -> list[str]:
    """Split a CSV of ffmpeg codec names such as "h264,hevc"; ignore blanks and case."""
    return [codec.strip().lower() for codec in value.split(",") if codec.strip()]


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
    # Longest wait on Redis for one limit check (past it the request goes through: fail open)
    # or one password-reset code operation (past it the reset fails).
    rate_limit_timeout_seconds: float = Field(default=0.5, gt=0)
    # Longest wait on Redis to queue background work: dispatch from a request (#48) and the event
    # pushes (#55); past it the action still succeeds and the failure is logged.
    job_enqueue_timeout_seconds: float = Field(default=2.0, gt=0)
    # Keys the HMAC that turns an email or phone into a rate-limit key (#137). Required in
    # staging and production; elsewhere a documented, non-secret development key is used.
    rate_limit_key_secret: SecretStr | None = None
    # Keys the HMAC that derives a rotated refresh token from the one it replaces (#152), so
    # a retry after a lost response gets the same successor without storing it. Required in
    # staging and production; elsewhere a documented, non-secret development key is used.
    refresh_rotation_secret: SecretStr | None = None
    # Seconds after a rotation during which the old refresh token, presented again, gets the
    # same successor instead of revoking the session (#152). 0 turns the grace window off.
    refresh_reuse_grace_seconds: int = Field(default=30, ge=0)
    # Proxies whose X-Forwarded-For uvicorn trusts for the client IP (CSV, or "*").
    forwarded_allow_ips: str = "127.0.0.1"
    # Object storage, S3-compatible (R2 or Railway Buckets), reached only through presigned URLs.
    # Required in staging and production; without it, upload endpoints answer a generic 500.
    s3_endpoint_url: str | None = None
    s3_bucket: str | None = None
    s3_access_key_id: SecretStr | None = None
    s3_secret_access_key: SecretStr | None = None
    s3_region: str = "auto"  # what R2 expects
    # The worker's own transfers (#173): seconds to connect, and to wait for each read.
    s3_connect_timeout_seconds: float = Field(default=10.0, gt=0)
    s3_read_timeout_seconds: float = Field(default=60.0, gt=0)
    upload_url_ttl_seconds: int = Field(default=300, gt=0)
    download_url_ttl_seconds: int = Field(default=300, gt=0)
    upload_max_image_bytes: int = Field(default=10 * MIB, gt=0)
    upload_max_video_bytes: int = Field(default=100 * MIB, gt=0)
    upload_max_document_bytes: int = Field(default=15 * MIB, gt=0)
    # The worker's sweep of uploads no row references (#191): what it does (dry_run only counts
    # and logs; delete removes them), the age an upload must reach before it may count as
    # orphaned, how often it runs (a cron, in minutes of the hour), and the longest one run may
    # take (ARQ stops it there; the next run starts over).
    orphan_upload_mode: OrphanUploadMode = "dry_run"
    orphan_upload_min_age_hours: int = Field(default=24, ge=1)
    orphan_upload_sweep_minutes: int = Field(default=60, ge=1, le=60)
    orphan_upload_sweep_timeout_seconds: int = Field(default=1_800, gt=0)
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
    # Email through Resend (D4.3, #27). Required in staging and production; without them, the
    # reset code is never sent (logged as an error).
    resend_api_key: SecretStr | None = None
    # The sender, e.g. "Jack Fix It <no-reply@...>" on a domain verified in Resend.
    email_from: str | None = None
    resend_timeout_seconds: float = Field(default=5.0, gt=0)
    # Password reset by emailed code (#27): how long a code lives, how many tries it allows,
    # and forgot/reset requests per IP and per email per AUTH_RATE_LIMIT_WINDOW_SECONDS.
    password_reset_code_ttl_seconds: int = Field(default=900, gt=0)
    password_reset_max_attempts: int = Field(default=5, gt=0)
    password_reset_request_limit: int = Field(default=3, gt=0)
    # New codes per account per window (Cesar, 2026-10-21): with the tries per code, this bounds
    # the guesses against one account per day (5 codes x 5 tries = 25 by default).
    password_reset_daily_limit: int = Field(default=5, gt=0)
    password_reset_daily_window_seconds: int = Field(default=86_400, gt=0)
    # Service requests (D8.1, #42): limits on what one request may carry, how often a customer
    # may create one, and how many a list page holds.
    request_intake_max_bytes: int = Field(default=16_384, gt=0)
    request_media_max_items: int = Field(default=10, gt=0)
    request_create_limit: int = Field(default=10, gt=0)
    request_create_window_seconds: int = Field(default=3_600, gt=0)
    request_list_default_limit: int = Field(default=20, gt=0)
    request_list_max_limit: int = Field(default=50, gt=0)
    # Privacy-safe copies of request photos and videos (#173), made by the worker. Runs one
    # sanitize job gets, the delay before a retry, the longest one step of a file's copy may take
    # (its download, image transform, ffmpeg or ffprobe run, or upload), the most pixels an image
    # may decode to (more is a decompression bomb: the file fails), the re-encode quality of
    # JPEG and WebP copies, and the ffmpeg binary.
    media_sanitize_max_tries: int = Field(default=5, gt=0)
    media_sanitize_retry_seconds: int = Field(default=30, gt=0)
    media_sanitize_timeout_seconds: float = Field(default=120.0, gt=0)
    media_max_image_pixels: int = Field(default=50_000_000, gt=0)
    media_jpeg_quality: int = Field(default=85, ge=1, le=95)
    ffmpeg_path: str = Field(default="ffmpeg", min_length=1)
    ffprobe_path: str = Field(default="ffprobe", min_length=1)
    # The only video and audio codecs a safe copy may carry (CSV of ffmpeg codec names): a remux
    # copies the streams as they are, and an image codec (MJPEG, PNG) keeps its EXIF.
    media_video_codecs: Annotated[list[str], NoDecode] = Field(default=["h264", "hevc"])
    media_audio_codecs: Annotated[list[str], NoDecode] = Field(default=["aac", "mp3", "opus"])
    # The longest one sanitize job may run (every media of one request), past which ARQ stops it
    # and never runs it again. So the job's work ends MEDIA_SANITIZE_SETTLE_SECONDS before, and a
    # file it has no time for goes on in its next try (see media_sanitize_min_job_seconds).
    media_sanitize_job_timeout_seconds: int = Field(default=1_800, gt=0)
    # The longest one database step of the job may take: its pending-row query, or one write.
    media_sanitize_overhead_seconds: float = Field(default=30.0, gt=0)
    # The end of each try, kept for after its work: asking ARQ for the next try or, on the last
    # one, failing what is left in one write. It also covers ARQ's own start of the job.
    media_sanitize_settle_seconds: float = Field(default=60.0, gt=0)
    # Characters of a request's description shown in a pro's opportunities list (#49).
    opportunity_excerpt_chars: int = Field(default=160, gt=0)
    # Pro profile (D6.1, #36): the most categories and service areas one pro may list.
    pro_max_categories: int = Field(default=5, gt=0)
    pro_max_service_areas: int = Field(default=50, gt=0)
    # Push notifications through Expo (D10.3, #54). The access token is optional everywhere:
    # Expo accepts unauthenticated sends unless the project turns on enhanced security.
    expo_access_token: SecretStr | None = None
    # Longest wait on Expo or Redis for one push operation.
    push_send_timeout_seconds: float = Field(default=5.0, gt=0)
    # How often the worker asks Expo for delivery receipts (a cron, in minutes of the hour).
    push_receipt_check_minutes: int = Field(default=15, ge=1, le=60)
    # How long a sent ticket waits for its receipt; Expo keeps receipts for about a day.
    push_ticket_ttl_seconds: int = Field(default=86_400, gt=0)
    # Delay before a failed send is retried, times the attempt number.
    push_retry_backoff_seconds: int = Field(default=30, gt=0)
    # Sends of one message to one device before a retryable error (a busy Expo, a rate limit)
    # counts as final; also the most runs ARQ gives one send_push job.
    push_max_attempts: int = Field(default=5, gt=0)
    push_max_devices_per_user: int = Field(default=10, gt=0)
    # Quote expiry (D9.4, #51): how often the worker expires quotes past their expires_at (a
    # cron, in minutes of the hour), and the longest one run may take. Two runs that overlap
    # are safe (each request is locked), so the timeout only bounds a stuck run.
    quote_expiry_sweep_minutes: int = Field(default=5, ge=1, le=60)
    quote_expiry_timeout_seconds: int = Field(default=240, gt=0)
    # Waitlist (D8.4, #46): joins per client IP and per contact (email or phone, hashed), per
    # AUTH_RATE_LIMIT_WINDOW_SECONDS.
    waitlist_join_limit: int = Field(default=5, gt=0)
    # Saved addresses (D8.2, #214): the most one customer may keep in their address book, and
    # how many writes (create, edit, delete together) one customer may make per window.
    saved_addresses_max_per_user: int = Field(default=4, gt=0)
    saved_address_write_limit: int = Field(default=30, gt=0)
    saved_address_write_window_seconds: int = Field(default=600, gt=0)

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

    @field_validator("media_video_codecs", "media_audio_codecs", mode="before")
    @classmethod
    def _split_codecs(cls, value: object) -> object:
        return parse_codecs(value) if isinstance(value, str) else value

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
        "s3_endpoint_url",
        "s3_bucket",
        "s3_access_key_id",
        "s3_secret_access_key",
        "twilio_account_sid",
        "twilio_auth_token",
        "twilio_verify_service_sid",
        "rate_limit_key_secret",
        "refresh_rotation_secret",
        "resend_api_key",
        "email_from",
        "expo_access_token",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @property
    def media_sanitize_row_budget_seconds(self) -> float:
        """The longest one file's copy may take: its download, three ffprobe runs, one ffmpeg
        run and its upload, each within MEDIA_SANITIZE_TIMEOUT_SECONDS, then its write."""
        return 6 * self.media_sanitize_timeout_seconds + self.media_sanitize_overhead_seconds

    @property
    def media_sanitize_min_job_seconds(self) -> float:
        """The shortest job timeout: the pending-row query, one whole file, and the settle
        reserve. The job starts a file on the same terms (app/modules/requests/media_copies.py),
        so with it the first file always has its whole budget."""
        return (
            self.media_sanitize_overhead_seconds
            + self.media_sanitize_row_budget_seconds
            + self.media_sanitize_settle_seconds
        )

    @model_validator(mode="after")
    def _media_job_fits_one_file(self) -> Self:
        # The reserve covers a database step the deadline cut (its connection's cleanup) and
        # the final try's write that fails what is left: up to one database step each.
        if self.media_sanitize_settle_seconds < 2 * self.media_sanitize_overhead_seconds:
            raise ValueError(
                "MEDIA_SANITIZE_SETTLE_SECONDS must be at least 2 x "
                "MEDIA_SANITIZE_OVERHEAD_SECONDS: a cut database step's cleanup and the last "
                "try's write that fails what is left run within it"
            )
        if self.media_sanitize_job_timeout_seconds < self.media_sanitize_min_job_seconds:
            raise ValueError(
                "MEDIA_SANITIZE_JOB_TIMEOUT_SECONDS must cover one file: at least "
                "6 x MEDIA_SANITIZE_TIMEOUT_SECONDS + 2 x MEDIA_SANITIZE_OVERHEAD_SECONDS "
                "+ MEDIA_SANITIZE_SETTLE_SECONDS"
            )
        return self

    @model_validator(mode="after")
    def _list_default_within_max(self) -> Self:
        if self.request_list_default_limit > self.request_list_max_limit:
            raise ValueError("REQUEST_LIST_DEFAULT_LIMIT must not exceed REQUEST_LIST_MAX_LIMIT")
        return self

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
    def _require_storage_when_deployed(self) -> Self:
        if self.app_env not in _STORAGE_REQUIRED_IN:
            return self
        missing = [name.upper() for name in _STORAGE_SETTINGS if getattr(self, name) is None]
        if missing:
            raise ValueError(f"{', '.join(missing)} must be set when APP_ENV is {self.app_env}")
        return self

    @model_validator(mode="after")
    def _require_twilio_when_deployed(self) -> Self:
        if self.app_env not in _TWILIO_REQUIRED_IN:
            return self
        missing = [name.upper() for name in _TWILIO_SETTINGS if getattr(self, name) is None]
        if missing:
            raise ValueError(f"{', '.join(missing)} must be set when APP_ENV is {self.app_env}")
        return self

    @model_validator(mode="after")
    def _require_rate_limit_key_secret_when_deployed(self) -> Self:
        if self.app_env not in RATE_LIMIT_KEY_SECRET_REQUIRED_IN:
            return self
        secret = self.rate_limit_key_secret
        if secret is None or len(secret.get_secret_value()) < RATE_LIMIT_KEY_SECRET_MIN_LENGTH:
            raise ValueError(
                f"RATE_LIMIT_KEY_SECRET must be set to at least "
                f"{RATE_LIMIT_KEY_SECRET_MIN_LENGTH} characters when APP_ENV is {self.app_env}"
            )
        return self

    @model_validator(mode="after")
    def _require_refresh_rotation_secret_when_deployed(self) -> Self:
        if self.app_env not in REFRESH_ROTATION_SECRET_REQUIRED_IN:
            return self
        secret = self.refresh_rotation_secret
        if secret is None or len(secret.get_secret_value()) < REFRESH_ROTATION_SECRET_MIN_LENGTH:
            raise ValueError(
                f"REFRESH_ROTATION_SECRET must be set to at least "
                f"{REFRESH_ROTATION_SECRET_MIN_LENGTH} characters when APP_ENV is {self.app_env}"
            )
        return self

    @model_validator(mode="after")
    def _require_email_when_deployed(self) -> Self:
        if self.app_env not in _EMAIL_REQUIRED_IN:
            return self
        missing = [name.upper() for name in _EMAIL_SETTINGS if getattr(self, name) is None]
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
