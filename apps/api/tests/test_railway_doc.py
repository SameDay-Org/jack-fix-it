"""docs/railway.md lists every variable staging and production require, for api and worker (#144).

The required set is not written down here: it is found by asking Settings itself. Starting from
a complete production configuration, each setting is left out in turn; the ones whose absence
fails validation are the ones a deployed service cannot start without. So a new validator, or a
new required field, fails this test until the doc lists it.
"""

import re
import typing
from pathlib import Path

import pytest
from pydantic import SecretStr, ValidationError

from app.config import Settings
from tests.conftest import (
    TEST_EMAIL_SETTINGS,
    TEST_JWT_SECRET,
    TEST_RATE_LIMIT_SETTINGS,
    TEST_STORAGE_SETTINGS,
    TEST_TWILIO_SETTINGS,
)

RAILWAY_DOC = Path(__file__).resolve().parents[3] / "docs" / "railway.md"
SERVICES = ("api", "worker")
# Fixture values only: a complete production configuration.
PRODUCTION: dict[str, object] = {
    "app_env": "production",
    "database_url": "postgresql://test:test@localhost:5432/test",
    "redis_url": "redis://localhost:6379/0",
    "jwt_secret": TEST_JWT_SECRET,
    **TEST_STORAGE_SETTINGS,
    **TEST_TWILIO_SETTINGS,
    **TEST_RATE_LIMIT_SETTINGS,
    **TEST_EMAIL_SETTINGS,
}
ROW = re.compile(r"^\|\s*`([A-Z0-9_]+)`\s*\|(.*)\|\s*$")


def service_table(service: str) -> dict[str, list[str]]:
    """{variable: [other cells]} from the table under `### <service>` in the Variables section."""
    text = RAILWAY_DOC.read_text(encoding="utf-8")
    variables = text.split("\n## Variables\n", 1)[1].split("\n## ", 1)[0]
    section = variables.split(f"\n### {service}\n", 1)[1].split("\n### ", 1)[0]
    rows: dict[str, list[str]] = {}
    for line in section.splitlines():
        match = ROW.match(line)
        if match:
            rows[match.group(1)] = [cell.strip() for cell in match.group(2).split("|")]
    return rows


@pytest.fixture
def isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """No setting may come from the process environment: only the values a test passes."""
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)


def deployed_required() -> set[str]:
    Settings(_env_file=None, **PRODUCTION)  # type: ignore[arg-type]  # pydantic-settings init kwargs
    required: set[str] = set()
    for name in Settings.model_fields:
        values = {key: value for key, value in PRODUCTION.items() if key != name}
        try:
            Settings(_env_file=None, **values)  # type: ignore[arg-type]  # as above
        except ValidationError:
            required.add(name.upper())
    return required


def is_secret(name: str) -> bool:
    annotation = Settings.model_fields[name.lower()].annotation
    return annotation is SecretStr or SecretStr in typing.get_args(annotation)


def test_required_set_is_found_from_settings(isolated_env: None) -> None:
    # Guards the detection itself: these are known to be required when deployed.
    required = deployed_required()

    assert {
        "DATABASE_URL",
        "REDIS_URL",
        "JWT_SECRET",
        "RATE_LIMIT_KEY_SECRET",
        "S3_SECRET_ACCESS_KEY",
        "TWILIO_AUTH_TOKEN",
        "RESEND_API_KEY",
        "EMAIL_FROM",
    } <= required
    # Settings with a working default are not required.
    assert not {"APP_ENV", "LOG_LEVEL", "S3_REGION", "RATE_LIMIT_TIMEOUT_SECONDS"} & required


@pytest.mark.parametrize("service", SERVICES)
def test_every_required_variable_is_listed(isolated_env: None, service: str) -> None:
    listed = set(service_table(service))

    missing = deployed_required() - listed

    assert not missing, f"docs/railway.md, {service}: add {sorted(missing)}"


@pytest.mark.parametrize("service", SERVICES)
def test_listed_variables_are_settings_and_secrets_are_marked(service: str) -> None:
    rows = service_table(service)

    assert rows, f"no table under ### {service}"
    for name, cells in rows.items():
        assert name.lower() in Settings.model_fields, f"{service}: {name} is not a setting"
        value, secret, source = cells
        assert value, f"{service}: {name} needs a value"
        assert source, f"{service}: {name} needs a source task"
        if is_secret(name):
            assert secret.startswith("yes"), f"{service}: {name} is a secret"


def test_worker_lists_app_env() -> None:
    # The worker must run in the same environment as the api, or it skips the validators.
    assert "APP_ENV" in service_table("worker")
