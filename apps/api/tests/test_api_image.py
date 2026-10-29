"""The api image holds every package docs/railway.md runs with `python -m` (#239), and the api's
pre-deploy command runs the commands the doc lists for it (#244)."""

import json
import re
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
RAILWAY_DOC = API_DIR.parents[1] / "docs" / "railway.md"
COMMAND = re.compile(r"`(?P<runner>[^`]*?)python -m (?P<package>\w+)(?:\.\w+)*")
API_CONFIG = API_DIR / "railway.api.json"
# Railway allows one pre-deploy entry, so the commands are chained in a single shell string.
CHAINED = re.compile(r"sh -c '(?P<script>[^']*)'")
LISTED = re.compile(r"^  \d+\. `(?P<command>[^`]+)`$", re.MULTILINE)
MODULE = re.compile(r"^python -m (?P<module>[\w.]+)$")


def doc_commands() -> list[re.Match[str]]:
    return list(COMMAND.finditer(RAILWAY_DOC.read_text(encoding="utf-8")))


def doc_packages() -> set[str]:
    return {match["package"] for match in doc_commands()}


def predeploy_commands() -> list[str]:
    """The commands chained by `&&` in railway.api.json, in order."""
    command = json.loads(API_CONFIG.read_text(encoding="utf-8"))["deploy"]["preDeployCommand"]
    chained = CHAINED.fullmatch(command) if isinstance(command, str) else None
    if chained is None:
        return [str(command)]
    return [part.strip() for part in chained["script"].split("&&")]


def documented_predeploy() -> list[str]:
    """The numbered commands under the api bullet of the Services section."""
    text = RAILWAY_DOC.read_text(encoding="utf-8")
    bullet = text.split("\n- **api** runs", 1)[1].split("\n- **", 1)[0]
    return LISTED.findall(bullet)


def predeploy_modules() -> list[str]:
    return [match["module"] for match in map(MODULE.match, predeploy_commands()) if match]


def assert_image_copies(package: str) -> None:
    dockerfile = (API_DIR / "Dockerfile").read_text(encoding="utf-8").splitlines()
    ignored = set((API_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines())

    assert f"COPY {package} ./{package}" in dockerfile, f"Dockerfile: COPY {package} ./{package}"
    assert not {package, f"{package}/", f"/{package}"} & ignored, f".dockerignore: {package}"


def test_the_doc_runs_the_server_and_the_scripts() -> None:
    # Guards the parsing: the start command and the seeds are known to be in the doc.
    assert {"app", "scripts"} <= doc_packages()


@pytest.mark.parametrize("package", sorted(doc_packages()))
def test_the_image_copies_each_package(package: str) -> None:
    assert_image_copies(package)


def test_commands_use_the_image_venv() -> None:
    # The venv is already on PATH in the image; `uv run` would try to sync it as the app user.
    runners = {match["runner"].strip() for match in doc_commands()}

    assert runners == {""}, f"docs/railway.md: run `python -m ...` directly, not {runners}"


def test_the_doc_lists_the_migrations_then_the_seeds() -> None:
    # Guards the parsing: the migrations run before the seeds that write to their tables.
    assert documented_predeploy() == [
        "alembic upgrade head",
        "python -m scripts.seed_categories",
        "python -m scripts.seed_service_areas",
    ]


def test_predeploy_runs_the_documented_commands_in_order() -> None:
    # Only `&&` between them, so the first failure stops the deploy.
    assert predeploy_commands() == documented_predeploy()


@pytest.mark.parametrize("module", predeploy_modules())
def test_the_image_holds_each_predeploy_module(module: str) -> None:
    package = module.split(".", 1)[0]

    assert_image_copies(package)
    assert (API_DIR / f"{module.replace('.', '/')}.py").is_file(), f"{module} is not a module"
