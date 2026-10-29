"""The api image holds every package docs/railway.md runs with `python -m` (#239)."""

import re
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
RAILWAY_DOC = API_DIR.parents[1] / "docs" / "railway.md"
COMMAND = re.compile(r"`(?P<runner>[^`]*?)python -m (?P<package>\w+)(?:\.\w+)*")


def doc_commands() -> list[re.Match[str]]:
    return list(COMMAND.finditer(RAILWAY_DOC.read_text(encoding="utf-8")))


def doc_packages() -> set[str]:
    return {match["package"] for match in doc_commands()}


def test_the_doc_runs_the_server_and_the_scripts() -> None:
    # Guards the parsing: the start command and the seeds are known to be in the doc.
    assert {"app", "scripts"} <= doc_packages()


@pytest.mark.parametrize("package", sorted(doc_packages()))
def test_the_image_copies_each_package(package: str) -> None:
    dockerfile = (API_DIR / "Dockerfile").read_text(encoding="utf-8").splitlines()
    ignored = set((API_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines())

    assert f"COPY {package} ./{package}" in dockerfile, f"Dockerfile: COPY {package} ./{package}"
    assert not {package, f"{package}/", f"/{package}"} & ignored, f".dockerignore: {package}"


def test_commands_use_the_image_venv() -> None:
    # The venv is already on PATH in the image; `uv run` would try to sync it as the app user.
    runners = {match["runner"].strip() for match in doc_commands()}

    assert runners == {""}, f"docs/railway.md: run `python -m ...` directly, not {runners}"
