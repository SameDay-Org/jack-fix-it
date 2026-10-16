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
