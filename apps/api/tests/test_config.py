import pytest
from pydantic import ValidationError

from app.config import normalize_database_url
from tests.conftest import (
    TEST_EMAIL_SETTINGS,
    TEST_RATE_LIMIT_SETTINGS,
    TEST_REFRESH_SETTINGS,
    TEST_STORAGE_SETTINGS,
    TEST_TWILIO_SETTINGS,
    make_settings,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("postgres://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
        ("postgresql://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
        ("postgresql+asyncpg://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
    ],
)
def test_database_url_is_normalized_to_asyncpg(raw: str, expected: str) -> None:
    assert normalize_database_url(raw) == expected
    assert make_settings(database_url=raw).database_url == expected


def test_database_url_with_another_scheme_is_rejected() -> None:
    with pytest.raises(ValidationError, match="DATABASE_URL"):
        make_settings(database_url="mysql://u:p@host/db")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", []),
        ("https://jackfixit.invalid", ["https://jackfixit.invalid"]),
        (
            " https://a.invalid/ ,https://b.invalid:8443,, ",
            ["https://a.invalid", "https://b.invalid:8443"],
        ),
    ],
)
def test_cors_origins_are_parsed_from_csv(
    monkeypatch: pytest.MonkeyPatch, raw: str, expected: list[str]
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", raw)

    assert make_settings().cors_origins == expected


def test_cors_wildcard_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "*")

    with pytest.raises(ValidationError, match="explicit origins"):
        make_settings()


def test_empty_sentry_dsn_disables_sentry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_DSN", "")

    assert make_settings().sentry_dsn is None


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_jwt_secret_required_in_staging_and_production(app_env: str) -> None:
    short = "s" * 31
    with pytest.raises(ValidationError, match="JWT_SECRET") as missing:
        make_settings(app_env=app_env, jwt_secret=None)
    with pytest.raises(ValidationError, match="JWT_SECRET") as too_short:
        make_settings(app_env=app_env, jwt_secret=short)

    # The error names the variable but never prints its value.
    assert short not in str(too_short.value)
    assert "JWT_SECRET" in str(missing.value)
    secret = "s" * 32
    settings = make_settings(
        app_env=app_env,
        jwt_secret=secret,
        **TEST_STORAGE_SETTINGS,
        **TEST_TWILIO_SETTINGS,
        **TEST_RATE_LIMIT_SETTINGS,
        **TEST_REFRESH_SETTINGS,
        **TEST_EMAIL_SETTINGS,
    )
    assert settings.jwt_secret is not None


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_jwt_secret_optional_in_development(app_env: str) -> None:
    assert make_settings(app_env=app_env, jwt_secret=None).jwt_secret is None
    # An empty JWT_SECRET= line in .env means unset.
    assert make_settings(app_env=app_env, jwt_secret="").jwt_secret is None


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_secret_required_in_staging_and_production(app_env: str) -> None:
    deployed = {
        "app_env": app_env,
        "jwt_secret": "s" * 32,
        **TEST_STORAGE_SETTINGS,
        **TEST_TWILIO_SETTINGS,
    }
    short = "k" * 31

    with pytest.raises(ValidationError, match="RATE_LIMIT_KEY_SECRET") as missing:
        make_settings(**deployed)
    with pytest.raises(ValidationError, match="RATE_LIMIT_KEY_SECRET"):
        make_settings(**deployed, rate_limit_key_secret="")
    with pytest.raises(ValidationError, match="RATE_LIMIT_KEY_SECRET") as too_short:
        make_settings(**deployed, rate_limit_key_secret=short)

    # The error names the variable but never prints its value.
    assert short not in str(too_short.value)
    assert "32 characters" in str(missing.value)
    settings = make_settings(
        **deployed, **TEST_RATE_LIMIT_SETTINGS, **TEST_REFRESH_SETTINGS, **TEST_EMAIL_SETTINGS
    )
    assert settings.rate_limit_key_secret is not None


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_rate_limit_key_secret_optional_in_development(app_env: str) -> None:
    assert make_settings(app_env=app_env).rate_limit_key_secret is None
    assert make_settings(app_env=app_env, rate_limit_key_secret="").rate_limit_key_secret is None


def test_rate_limit_key_secret_is_masked() -> None:
    settings = make_settings(**TEST_RATE_LIMIT_SETTINGS)

    assert str(TEST_RATE_LIMIT_SETTINGS["rate_limit_key_secret"]) not in repr(settings)


def test_jwt_secret_is_masked() -> None:
    settings = make_settings(jwt_secret="x" * 40)

    assert "x" * 40 not in repr(settings)


def test_auth_settings_defaults() -> None:
    settings = make_settings()

    assert settings.access_token_ttl_seconds == 900
    assert settings.refresh_token_ttl_seconds == 2_592_000
    assert settings.password_min_length == 10


@pytest.mark.parametrize(
    "field", ["access_token_ttl_seconds", "refresh_token_ttl_seconds", "password_min_length"]
)
@pytest.mark.parametrize("value", [0, -1])
def test_auth_settings_must_be_positive(field: str, value: int) -> None:
    with pytest.raises(ValidationError):
        make_settings(**{field: value})


def test_rate_limit_settings_defaults() -> None:
    settings = make_settings()

    assert settings.auth_rate_limit_requests == 10
    assert settings.auth_rate_limit_window_seconds == 60
    assert settings.login_rate_limit_per_email == 5
    assert settings.rate_limit_timeout_seconds == 0.5
    assert settings.forwarded_allow_ips == "127.0.0.1"


@pytest.mark.parametrize(
    "name",
    [
        "auth_rate_limit_requests",
        "auth_rate_limit_window_seconds",
        "login_rate_limit_per_email",
        "rate_limit_timeout_seconds",
    ],
)
@pytest.mark.parametrize("value", [0, -1])
def test_rate_limit_settings_must_be_positive(name: str, value: int) -> None:
    with pytest.raises(ValidationError, match=name):
        make_settings(**{name: value})


def test_rate_limit_settings_come_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUTH_RATE_LIMIT_REQUESTS", "7")
    monkeypatch.setenv("AUTH_RATE_LIMIT_WINDOW_SECONDS", "30")
    monkeypatch.setenv("LOGIN_RATE_LIMIT_PER_EMAIL", "3")
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "10.0.0.0/8,fd00::/8")

    settings = make_settings()

    assert settings.auth_rate_limit_requests == 7
    assert settings.auth_rate_limit_window_seconds == 30
    assert settings.login_rate_limit_per_email == 3
    assert settings.forwarded_allow_ips == "10.0.0.0/8,fd00::/8"


@pytest.mark.parametrize("app_env", ["staging", "production"])
@pytest.mark.parametrize(
    "missing", ["s3_endpoint_url", "s3_bucket", "s3_access_key_id", "s3_secret_access_key"]
)
def test_s3_settings_required_in_staging_and_production(app_env: str, missing: str) -> None:
    secret_value = "test-secret-access-key-not-real"
    # Twilio is required there too; only the S3 setting under test is missing.
    values = {**TEST_TWILIO_SETTINGS, **TEST_STORAGE_SETTINGS, missing: None}

    with pytest.raises(ValidationError, match=missing.upper()) as error:
        make_settings(app_env=app_env, jwt_secret="s" * 32, **values)

    # The error names the variable but never prints a value.
    assert secret_value not in str(error.value)
    settings = make_settings(
        app_env=app_env,
        jwt_secret="s" * 32,
        **TEST_STORAGE_SETTINGS,
        **TEST_TWILIO_SETTINGS,
        **TEST_RATE_LIMIT_SETTINGS,
        **TEST_REFRESH_SETTINGS,
        **TEST_EMAIL_SETTINGS,
    )
    assert settings.s3_bucket == TEST_STORAGE_SETTINGS["s3_bucket"]


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_s3_settings_optional_in_development(app_env: str) -> None:
    settings = make_settings(app_env=app_env, s3_endpoint_url="", s3_access_key_id="")

    assert settings.s3_endpoint_url is None
    assert settings.s3_access_key_id is None
    assert settings.s3_secret_access_key is None


def test_s3_secrets_are_masked() -> None:
    settings = make_settings(**TEST_STORAGE_SETTINGS)

    assert "test-secret-access-key-not-real" not in repr(settings)
    assert "test-access-key-id" not in repr(settings)


def test_upload_settings_defaults() -> None:
    settings = make_settings()

    assert settings.s3_region == "auto"
    assert settings.upload_url_ttl_seconds == 300
    assert settings.download_url_ttl_seconds == 300
    assert settings.upload_max_image_bytes == 10 * 1024 * 1024
    assert settings.upload_max_video_bytes == 100 * 1024 * 1024
    assert settings.upload_max_document_bytes == 15 * 1024 * 1024


@pytest.mark.parametrize(
    "name",
    [
        "upload_url_ttl_seconds",
        "download_url_ttl_seconds",
        "upload_max_image_bytes",
        "upload_max_video_bytes",
        "upload_max_document_bytes",
    ],
)
def test_upload_settings_must_be_positive(name: str) -> None:
    with pytest.raises(ValidationError, match=name):
        make_settings(**{name: 0})


@pytest.mark.parametrize("app_env", ["staging", "production"])
@pytest.mark.parametrize(
    "missing", ["twilio_account_sid", "twilio_auth_token", "twilio_verify_service_sid"]
)
def test_twilio_settings_required_in_staging_and_production(app_env: str, missing: str) -> None:
    # Storage is required there too; only the Twilio setting under test is missing.
    values = {**TEST_STORAGE_SETTINGS, **TEST_TWILIO_SETTINGS, missing: None}

    with pytest.raises(ValidationError, match=missing.upper()) as error:
        make_settings(app_env=app_env, jwt_secret="s" * 32, **values)

    # The error names the variable but never prints a value.
    assert "test-twilio-auth-token-not-real" not in str(error.value)
    settings = make_settings(
        app_env=app_env,
        jwt_secret="s" * 32,
        **TEST_TWILIO_SETTINGS,
        **TEST_STORAGE_SETTINGS,
        **TEST_RATE_LIMIT_SETTINGS,
        **TEST_REFRESH_SETTINGS,
        **TEST_EMAIL_SETTINGS,
    )
    assert settings.twilio_verify_service_sid == TEST_TWILIO_SETTINGS["twilio_verify_service_sid"]


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_twilio_settings_optional_in_development(app_env: str) -> None:
    settings = make_settings(app_env=app_env, twilio_account_sid="", twilio_auth_token="")

    assert settings.twilio_account_sid is None
    assert settings.twilio_auth_token is None


def test_twilio_auth_token_is_masked() -> None:
    settings = make_settings(**TEST_TWILIO_SETTINGS)

    assert "test-twilio-auth-token-not-real" not in repr(settings)


def test_phone_settings_defaults() -> None:
    settings = make_settings()

    assert settings.phone_allowed_country_codes == ["+1"]
    assert settings.phone_otp_send_limit == 3
    assert settings.phone_otp_check_limit == 5
    assert settings.twilio_timeout_seconds == 5


def test_phone_country_codes_come_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PHONE_ALLOWED_COUNTRY_CODES", " +1, +52 ,")

    assert make_settings().phone_allowed_country_codes == ["+1", "+52"]


@pytest.mark.parametrize("value", ["", "1", "+0", "+12345", "+1,52", "US"])
def test_phone_country_codes_must_be_calling_codes(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("PHONE_ALLOWED_COUNTRY_CODES", value)

    with pytest.raises(ValidationError, match="PHONE_ALLOWED_COUNTRY_CODES"):
        make_settings()


@pytest.mark.parametrize(
    "name", ["phone_otp_send_limit", "phone_otp_check_limit", "twilio_timeout_seconds"]
)
def test_phone_settings_must_be_positive(name: str) -> None:
    with pytest.raises(ValidationError, match=name):
        make_settings(**{name: 0})


@pytest.mark.parametrize("app_env", ["staging", "production"])
@pytest.mark.parametrize("missing", ["resend_api_key", "email_from"])
def test_resend_settings_required_in_staging_and_production(app_env: str, missing: str) -> None:
    # Everything else deployed environments require is set; only the setting under test is not.
    values = {
        **TEST_STORAGE_SETTINGS,
        **TEST_TWILIO_SETTINGS,
        **TEST_RATE_LIMIT_SETTINGS,
        **TEST_REFRESH_SETTINGS,
        **TEST_EMAIL_SETTINGS,
    }

    for absent in (None, ""):
        with pytest.raises(ValidationError, match=missing.upper()) as error:
            make_settings(app_env=app_env, jwt_secret="s" * 32, **{**values, missing: absent})
        # The error names the variable but never prints a value.
        assert "re_test_key_not_real" not in str(error.value)
    settings = make_settings(app_env=app_env, jwt_secret="s" * 32, **values)
    assert settings.email_from == TEST_EMAIL_SETTINGS["email_from"]


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_resend_settings_optional_in_development(app_env: str) -> None:
    settings = make_settings(app_env=app_env, resend_api_key="", email_from="")

    assert settings.resend_api_key is None
    assert settings.email_from is None


def test_resend_api_key_is_masked() -> None:
    settings = make_settings(**TEST_EMAIL_SETTINGS)

    assert "re_test_key_not_real" not in repr(settings)


def test_password_reset_settings_defaults() -> None:
    settings = make_settings()

    assert settings.password_reset_code_ttl_seconds == 900
    assert settings.password_reset_max_attempts == 5
    assert settings.password_reset_request_limit == 3
    assert settings.password_reset_daily_limit == 5
    assert settings.password_reset_daily_window_seconds == 86_400
    assert settings.resend_timeout_seconds == 5
