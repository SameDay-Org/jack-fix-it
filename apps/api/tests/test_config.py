import pytest
from pydantic import ValidationError

from app.config import normalize_database_url
from tests.conftest import make_settings


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
    assert make_settings(app_env=app_env, jwt_secret=secret).jwt_secret is not None


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_jwt_secret_optional_in_development(app_env: str) -> None:
    assert make_settings(app_env=app_env, jwt_secret=None).jwt_secret is None
    # An empty JWT_SECRET= line in .env means unset.
    assert make_settings(app_env=app_env, jwt_secret="").jwt_secret is None


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
    assert settings.forwarded_allow_ips == "127.0.0.1"


@pytest.mark.parametrize(
    "name",
    ["auth_rate_limit_requests", "auth_rate_limit_window_seconds", "login_rate_limit_per_email"],
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
