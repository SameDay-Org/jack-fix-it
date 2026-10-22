"""docs/railway.md lists every variable staging and production require, for api and worker (#144).

The required set is not written down here: it is found by asking Settings itself. Starting from
a complete configuration for staging, and again for production, each setting is left out in
turn; the ones whose absence fails validation in either environment are the ones a deployed
service cannot start without. So a new validator, or a new required field, fails this test until
the doc lists it, even when only one of the two environments requires it.
"""

import re
import typing
from collections.abc import Mapping
from pathlib import Path
from typing import Self

import pytest
from pydantic import SecretStr, ValidationError, model_validator

from app.config import Settings
from tests.conftest import (
    TEST_EMAIL_SETTINGS,
    TEST_JWT_SECRET,
    TEST_RATE_LIMIT_SETTINGS,
    TEST_STORAGE_SETTINGS,
    TEST_TWILIO_SETTINGS,
)

RAILWAY_DOC = Path(__file__).resolve().parents[3] / "docs" / "railway.md"
# The services that build the API's Settings; web is another app with its own variables.
SERVICES = ("api", "worker")
TABLES = (*SERVICES, "web")
DEPLOYED_ENVS = ("staging", "production")
# Fixture values only: everything a deployed environment requires (app_env is added per run).
COMPLETE: dict[str, object] = {
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


def required_in(
    app_env: str,
    settings_class: type[Settings] = Settings,
    extra: Mapping[str, object] | None = None,
) -> set[str]:
    """The variables `settings_class` cannot start without when APP_ENV is `app_env`."""
    complete = {**COMPLETE, **(extra or {}), "app_env": app_env}
    settings_class(_env_file=None, **complete)  # type: ignore[arg-type]  # pydantic-settings init kwargs
    required: set[str] = set()
    for name in settings_class.model_fields:
        values = {key: value for key, value in complete.items() if key != name}
        try:
            settings_class(_env_file=None, **values)  # type: ignore[arg-type]  # as above
        except ValidationError:
            required.add(name.upper())
    return required


def deployed_required(
    settings_class: type[Settings] = Settings, extra: Mapping[str, object] | None = None
) -> set[str]:
    """Required in staging or in production: a service must start in both."""
    return set().union(*(required_in(env, settings_class, extra) for env in DEPLOYED_ENVS))


def undocumented(service: str, required: set[str]) -> set[str]:
    return required - set(service_table(service))


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
    missing = undocumented(service, deployed_required())

    assert not missing, f"docs/railway.md, {service}: add {sorted(missing)}"


class _StagingOnlyRequirement(Settings):
    """A setting only staging requires, planted to prove the probe covers staging too."""

    planted_staging_secret: str | None = None

    @model_validator(mode="after")
    def _require_planted_in_staging(self) -> Self:
        if self.app_env == "staging" and self.planted_staging_secret is None:
            raise ValueError("PLANTED_STAGING_SECRET must be set when APP_ENV is staging")
        return self


def test_a_staging_only_requirement_fails_the_doc_check(isolated_env: None) -> None:
    extra = {"planted_staging_secret": "planted"}

    required = deployed_required(_StagingOnlyRequirement, extra)

    assert "PLANTED_STAGING_SECRET" not in required_in("production", _StagingOnlyRequirement, extra)
    for service in SERVICES:
        assert "PLANTED_STAGING_SECRET" in undocumented(service, required)


@pytest.mark.parametrize("table", TABLES)
def test_every_row_has_a_value_secret_flag_and_source(table: str) -> None:
    rows = service_table(table)

    assert rows, f"no table under ### {table}"
    for name, cells in rows.items():
        assert len(cells) == 3, f"{table}: {name} needs Value, Secret and Source columns"
        value, secret, source = cells
        assert value, f"{table}: {name} needs a value"
        assert secret == "no" or secret.startswith("yes"), f"{table}: {name} secret is yes or no"
        assert source, f"{table}: {name} needs a source task"


@pytest.mark.parametrize("service", SERVICES)
def test_listed_variables_are_settings_and_secrets_are_marked(service: str) -> None:
    for name, (_, secret, _) in service_table(service).items():
        assert name.lower() in Settings.model_fields, f"{service}: {name} is not a setting"
        if is_secret(name):
            assert secret.startswith("yes"), f"{service}: {name} is a secret"


def test_worker_lists_app_env() -> None:
    # The worker must run in the same environment as the api, or it skips the validators.
    assert "APP_ENV" in service_table("worker")
