"""Settings, read only from environment variables (plus apps/api/.env for local development)."""

import re
from functools import lru_cache
from typing import Annotated, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from starlette.requests import Request

from app.crypto import KeyringError, OriginalCipher, parse_keyring

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
# Stripe Connect payouts (D7.1, #39): deployed environments must reach Stripe, and Stripe must
# reach the API's public onboarding pages over https.
_STRIPE_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
_STRIPE_SETTINGS: tuple[str, ...] = ("stripe_secret_key", "public_api_url")
# Stripe stays in test mode until launch (ADR 0005): a live key works in production only.
_STRIPE_LIVE_KEY_PREFIXES = ("sk_live_", "rk_live_")
_STRIPE_LIVE_PUBLISHABLE_KEY_PREFIXES = ("pk_live_",)
# A Stripe publishable key, test or live: it is returned to customers (the Payment Sheet), so a
# secret (sk_) or restricted (rk_) key, or anything else, must never pass as one (#58).
_STRIPE_PUBLISHABLE_KEY = re.compile(r"pk_(test|live)_[A-Za-z0-9]+")
# Where a missing chat original key is logged at startup (#72): the API still starts, and no
# original is stored until the key is set (fail closed).
CHAT_ORIGINAL_KEY_EXPECTED_IN = _JWT_SECRET_REQUIRED_IN
# Where the pros' live positions need a Redis of their own, LOCATION_REDIS_URL (#350): the
# API still starts without it, and the position routes answer 503. Elsewhere they use
# REDIS_URL's.
LOCATION_REDIS_REQUIRED_IN = _JWT_SECRET_REQUIRED_IN
_REDIS_URL_SCHEMES = ("redis://", "rediss://", "unix://")


def is_publishable_key(value: str) -> bool:
    """Whether `value` has the shape of a Stripe publishable key (pk_test_ or pk_live_)."""
    return _STRIPE_PUBLISHABLE_KEY.fullmatch(value) is not None


# Stripe keeps an idempotency key at least this long (its documented 24 hours): Stripe's fact,
# not a setting.
STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS = 86_400
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


def check_public_api_url(value: str) -> str:
    """An absolute http(s) URL with no query or fragment, without its trailing slash."""
    url = urlsplit(value)
    if url.scheme not in ("http", "https") or not url.netloc or url.query or url.fragment:
        raise ValueError("PUBLIC_API_URL must be an absolute http(s) URL with no query")
    return value.rstrip("/")


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
    # How long a create's Idempotency-Key answers its retries with the request it made (#264).
    request_idempotency_window_seconds: int = Field(default=86_400, gt=0)
    request_list_default_limit: int = Field(default=20, gt=0)
    request_list_max_limit: int = Field(default=50, gt=0)
    # Reverse geocoding through Google (D8.2, #215): the device position becomes an address.
    # The key is optional in every environment until the Google Cloud account exists (#14);
    # without it POST /v1/geo/reverse answers 503. Seconds one call may take, and lookups per
    # customer per window.
    google_maps_api_key: SecretStr | None = None
    geocoding_timeout_seconds: float = Field(default=5.0, gt=0)
    geo_reverse_limit: int = Field(default=30, gt=0)
    geo_reverse_window_seconds: int = Field(default=600, gt=0)
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
    # Stripe webhooks (D7.3, #40): the endpoint's signing secret (whsec_...). Optional: without
    # it POST /v1/webhooks/stripe answers 503 and Stripe retries. How old a signature may be
    # (Stripe's default tolerance), the largest body read, and the worker's handling: the runs
    # of one event before it is failed, and the delay before a retry, times the attempt number.
    stripe_webhook_secret: SecretStr | None = None
    stripe_webhook_tolerance_seconds: int = Field(default=300, gt=0)
    stripe_webhook_max_body_bytes: int = Field(default=524_288, gt=0)
    stripe_webhook_max_attempts: int = Field(default=5, gt=0)
    stripe_webhook_retry_backoff_seconds: int = Field(default=10, gt=0)
    # Waitlist (D8.4, #46): joins per client IP and per contact (email or phone, hashed), per
    # AUTH_RATE_LIMIT_WINDOW_SECONDS.
    waitlist_join_limit: int = Field(default=5, gt=0)
    # Saved addresses (D8.2, #214): the most one customer may keep in their address book, and
    # how many writes (create, edit, delete together) one customer may make per window.
    saved_addresses_max_per_user: int = Field(default=4, gt=0)
    saved_address_write_limit: int = Field(default=30, gt=0)
    saved_address_write_window_seconds: int = Field(default=600, gt=0)
    # Pro payouts through Stripe Connect Express (D7.1, #39; ADR 0005). Required in staging and
    # production; without the key, the payout endpoints answer 503. Seconds one Stripe call may
    # take, and the SDK's retries of a call that failed on the network, a 409, 429 or 5xx (with
    # the same idempotency key); 0 fails at once, and the app's retry is safe.
    stripe_secret_key: SecretStr | None = None
    # The key the app's Payment Sheet initializes Stripe with (D11.1, #58): not a secret,
    # but one per environment, and pk_test_ until launch like the secret key. Only a pk_ key is
    # accepted: the value is returned to customers, so a secret or restricted key fails at load.
    # Optional, so a deploy never fails for it: without it, the payment endpoint answers 503
    # not_configured.
    stripe_publishable_key: str | None = None
    stripe_timeout_seconds: float = Field(default=10.0, gt=0)
    stripe_max_network_retries: int = Field(default=0, ge=0)
    # Saved cards (#253): how many setup intents, default changes and deletes together one
    # customer may make per window. Each one is a call to Stripe.
    payment_method_write_limit: int = Field(default=20, gt=0)
    payment_method_write_window_seconds: int = Field(default=600, gt=0)
    # The cards are read from Stripe 100 per page, at most this many pages: a customer with
    # more cards gets 503 payments_unavailable, never a partial list.
    payment_method_list_max_pages: int = Field(default=5, gt=0)
    # Default changes and deletes of one customer's wallet run one at a time (a lock per
    # customer, held across the change's Stripe calls). The longest one change may take once
    # the caller is authenticated: its wait for a database connection for the lock, its wait
    # for another one's lock and its own Stripe calls together. Past it, 503
    # payments_unavailable, and the lock is released. Keep it below the app's request timeout.
    payment_method_change_timeout_seconds: float = Field(default=10.0, gt=0)
    # A profile with no stored account whose first create was attempted at least this many
    # seconds ago looks its account up in Stripe instead of creating again: Stripe may forget an
    # idempotency key once it is 24 hours old, so the value stays below that. The lookup lists
    # the platform's accounts, 100 per page, at most this many pages.
    stripe_account_reconcile_after_seconds: int = Field(
        default=72_000, gt=0, lt=STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS
    )
    stripe_account_list_max_pages: int = Field(default=10, gt=0)
    # The same bound for a payment (D11.1, #58): with no stored PaymentIntent and a create
    # attempted at least this many seconds ago, the retry searches Stripe for the intent instead
    # of creating again. Below Stripe's 24-hour key retention, like the account's.
    stripe_payment_intent_reconcile_after_seconds: int = Field(
        default=72_000, gt=0, lt=STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS
    )
    # Unpaid payments (#297): a payment still unpaid (requires_payment or failed) this many
    # seconds after its creation is canceled, so its quote and request reopen and another quote
    # can be accepted. The default (2 h) is provisional, tied to the request expiry and dispatch
    # windows still open in #51 part 2. How often the worker sweeps (a cron, in minutes of the
    # hour) and the longest one run may take; two runs that overlap are safe (each payment is
    # locked and checked again), so the timeout only bounds a stuck run.
    payment_unpaid_cancel_after_seconds: int = Field(default=7_200, gt=0)
    payment_unpaid_sweep_minutes: int = Field(default=10, ge=1, le=60)
    payment_unpaid_sweep_timeout_seconds: int = Field(default=540, gt=0)
    # Job execution (D12.2, #63): wrong arrival codes a pro may enter at check-in before the
    # code locks and the BDC is alerted (Cesar, 2026-10-29: 5).
    arrival_code_max_attempts: int = Field(default=5, gt=0)
    # Job photos (#298): the most a job holds of each kind (before, after).
    job_photo_max_per_kind: int = Field(default=10, gt=0)
    # The oldest job_photo upload a job accepts, by the time its key was issued (#298). At most
    # half of ORPHAN_UPLOAD_MIN_AGE_HOURS (checked below; the api and the worker must share both
    # values): the sweep only deletes older uploads, so a key attach accepted was referenced
    # long before the sweep can pick it (orphans.py).
    job_photo_attach_max_age_minutes: int = Field(default=720, gt=0)
    # Job confirmation (#66, #67; Cesar 2026-10-29, epic #272): once the pro marks the job done,
    # the customer has this many hours to confirm it (or report a problem); a job still completed
    # after them is confirmed by the system. How often the worker sweeps (a cron, in minutes of
    # the hour) and the longest one run may take; two runs that overlap are safe (each job is
    # locked and checked again), so the timeout only bounds a stuck run.
    job_auto_confirm_after_hours: int = Field(default=48, gt=0)
    job_auto_confirm_sweep_minutes: int = Field(default=15, ge=1, le=60)
    job_auto_confirm_sweep_timeout_seconds: int = Field(default=840, gt=0)
    # The pro's live position while on the way (#350; Cesar 2026-11-10): only the latest one
    # of a job is kept, in Redis only, for this many seconds after its write (it is deleted
    # sooner, when the pro checks in or the job leaves on_the_way).
    pro_location_ttl_seconds: int = Field(default=120, gt=0)
    # A position arriving sooner than this after the job's stored one is answered and dropped
    # (0 keeps every one); past the per-pro limit per window, positions get a 429.
    pro_location_min_interval_seconds: float = Field(default=3.0, ge=0)
    pro_location_rate_limit: int = Field(default=60, gt=0)
    pro_location_rate_window_seconds: int = Field(default=60, gt=0)
    # How far the device's time of a position may be ahead of, or behind, the server's.
    pro_location_max_future_seconds: int = Field(default=300, ge=0)
    pro_location_max_age_seconds: int = Field(default=600, gt=0)
    # Longest wait on Redis for one position operation: past it the pro's position is refused
    # (503), the customer reads none, and a check-in or status change goes on without the
    # delete (the position expires on its own). A position is written under the job's row
    # lock, so this also bounds how long one can hold a check-in off.
    pro_location_timeout_seconds: float = Field(default=0.5, gt=0)
    # The Redis the positions live in (#350, Vault round 1): one of their own that keeps
    # nothing but its live keys (no RDB snapshot, no AOF, no slow log), so a position is gone
    # once it is deleted or expires. Required in staging and production: without it the API
    # starts and the position routes answer 503. Development and test use REDIS_URL's.
    location_redis_url: str | None = None
    # The API asks that Redis what it keeps (CONFIG GET) before a position goes in or out,
    # and again once the answer is this many seconds old. In staging and production a Redis
    # that keeps positions, or will not say, is refused (503); elsewhere it is only logged.
    location_redis_recheck_seconds: float = Field(default=60.0, gt=0)
    # For a managed Redis that refuses CONFIG GET: true takes the deployer's word that it
    # keeps nothing. It never overrides an answer: a Redis that says it keeps is refused.
    location_redis_assume_ephemeral: bool = False
    # Job chat (D14.1, #71): messages one user may send in one job's chat per window.
    chat_message_rate_limit: int = Field(default=20, gt=0)
    chat_message_rate_window_seconds: int = Field(default=60, gt=0)
    # Support tickets ("Talk to Jack", #274): tickets one user may write per window.
    support_ticket_create_limit: int = Field(default=5, gt=0)
    support_ticket_create_window_seconds: int = Field(default=3_600, gt=0)
    # The original of a redacted chat message (#72, Cesar 2026-11-07): kept encrypted for staff
    # only (app.crypto), deleted after CHAT_ORIGINAL_RETENTION_DAYS. CHAT_ORIGINAL_KEYS is a JSON
    # object {key_id: base64 32-byte key}; CHAT_ORIGINAL_ACTIVE_KEY_ID names the key new originals
    # use. Unset: no original is stored (never plaintext), and staging and production log
    # chat_original_key_missing at startup.
    chat_original_keys: SecretStr | None = None
    chat_original_active_key_id: str | None = None
    chat_original_retention_days: int = Field(default=90, gt=0)
    # The worker's purge of expired originals: how often, how many rows per transaction, and the
    # longest one run may take.
    chat_original_purge_minutes: int = Field(default=60, ge=1, le=60)
    chat_original_purge_batch: int = Field(default=500, gt=0)
    chat_original_purge_timeout_seconds: int = Field(default=600, gt=0)
    # Repeat offenders (#72, Cesar 2026-11-07): a sender with CHAT_OFFENDER_THRESHOLD redacted
    # messages, across all jobs, within CHAT_OFFENDER_WINDOW_DAYS is flagged for the BDC.
    chat_offender_threshold: int = Field(default=3, gt=0)
    chat_offender_window_days: int = Field(default=7, gt=0)
    # The API's public base URL, such as https://api.example.com: Stripe sends the pro's browser
    # back to its onboarding pages there. Required with Stripe in staging and production (https).
    public_api_url: str | None = None
    # Where those pages send the browser on: the app's link, plus ?result=return or refresh.
    payouts_onboarding_app_url: str = "jackfixit://payouts"
    # Onboarding links one pro may ask for per window.
    payouts_onboarding_link_limit: int = Field(default=10, gt=0)
    payouts_onboarding_link_window_seconds: int = Field(default=600, gt=0)

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
        "stripe_webhook_secret",
        "expo_access_token",
        "google_maps_api_key",
        "stripe_secret_key",
        "stripe_publishable_key",
        "public_api_url",
        "location_redis_url",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("stripe_publishable_key")
    @classmethod
    def _check_publishable_key(cls, value: str | None) -> str | None:
        # The message never repeats the value: it could be a secret key pasted here.
        if value is not None and not is_publishable_key(value):
            raise ValueError(
                "STRIPE_PUBLISHABLE_KEY must be a Stripe publishable key (pk_test_... or "
                "pk_live_...); a secret (sk_) or restricted (rk_) key is refused"
            )
        return value

    @field_validator("location_redis_url")
    @classmethod
    def _check_location_redis_url(cls, value: str | None) -> str | None:
        # The message never repeats the value: the URL holds the Redis password.
        if value is not None and not value.startswith(_REDIS_URL_SCHEMES):
            raise ValueError("LOCATION_REDIS_URL must start with redis://, rediss:// or unix://")
        return value

    @field_validator("public_api_url")
    @classmethod
    def _check_public_api_url(cls, value: str | None) -> str | None:
        return None if value is None else check_public_api_url(value)

    @field_validator("payouts_onboarding_app_url")
    @classmethod
    def _check_app_url(cls, value: str) -> str:
        # The pages append ?result=...: a query or fragment here would break the link.
        if not re.fullmatch(r"[a-z][a-z0-9+.-]*://[^\s?#\"'<>]*", value):
            raise ValueError("PAYOUTS_ONBOARDING_APP_URL must be a URL with no query or fragment")
        return value

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
    def _job_photo_attach_window_before_sweep(self) -> Self:
        # Disjoint windows (#298): an upload old enough to be swept is far too old to attach.
        if 2 * self.job_photo_attach_max_age_minutes > 60 * self.orphan_upload_min_age_hours:
            raise ValueError(
                "JOB_PHOTO_ATTACH_MAX_AGE_MINUTES must be at most half of "
                "ORPHAN_UPLOAD_MIN_AGE_HOURS: the sweep must never reach an upload a job "
                "may still attach"
            )
        return self

    @model_validator(mode="after")
    def _chat_original_keyring(self) -> Self:
        # Parsed here so a malformed keyring stops startup instead of failing each message. The
        # errors name the setting and at most a key id, never a key (app.crypto).
        if self.chat_original_keys is None:
            if self.chat_original_active_key_id is not None:
                raise ValueError("CHAT_ORIGINAL_ACTIVE_KEY_ID is set without CHAT_ORIGINAL_KEYS")
            return self
        if self.chat_original_active_key_id is None:
            raise ValueError("CHAT_ORIGINAL_KEYS is set without CHAT_ORIGINAL_ACTIVE_KEY_ID")
        try:
            self.chat_original_cipher()
        except KeyringError as error:
            raise ValueError(str(error)) from None
        return self

    def chat_original_cipher(self) -> OriginalCipher | None:
        """The cipher of the chat originals; None when no key is configured."""
        if self.chat_original_keys is None or self.chat_original_active_key_id is None:
            return None
        keys = parse_keyring(self.chat_original_keys.get_secret_value())
        return OriginalCipher(keys, self.chat_original_active_key_id)

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

    @model_validator(mode="after")
    def _require_stripe_when_deployed(self) -> Self:
        if self.app_env not in _STRIPE_REQUIRED_IN:
            return self
        missing = [name.upper() for name in _STRIPE_SETTINGS if getattr(self, name) is None]
        if missing:
            raise ValueError(f"{', '.join(missing)} must be set when APP_ENV is {self.app_env}")
        if not (self.public_api_url or "").startswith("https://"):
            raise ValueError(f"PUBLIC_API_URL must use https when APP_ENV is {self.app_env}")
        return self

    @model_validator(mode="after")
    def _refuse_live_stripe_key_outside_production(self) -> Self:
        if self.app_env == "production":
            return self
        key = self.stripe_secret_key.get_secret_value() if self.stripe_secret_key else ""
        if key.startswith(_STRIPE_LIVE_KEY_PREFIXES):
            raise ValueError(
                f"STRIPE_SECRET_KEY is a live key; it is refused when APP_ENV is {self.app_env}"
            )
        publishable = self.stripe_publishable_key or ""
        if publishable.startswith(_STRIPE_LIVE_PUBLISHABLE_KEY_PREFIXES):
            raise ValueError(
                "STRIPE_PUBLISHABLE_KEY is a live key; it is refused when APP_ENV is "
                f"{self.app_env}"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


def get_app_settings(request: Request) -> Settings:
    """FastAPI dependency: the settings the running app was built with."""
    settings: Settings = request.app.state.settings
    return settings
