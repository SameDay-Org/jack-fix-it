"""ADR 0003: a module uses another module through its service, never its models or repository."""

import ast
from pathlib import Path

import pytest

MODULES_DIR = Path(__file__).resolve().parents[1] / "app" / "modules"
# Files of another module that a module may never import.
_PRIVATE_FILES = ("models", "repository")


def _imported_modules(path: Path) -> set[str]:
    """Every dotted module a file imports, including `from app.modules.x import models`."""
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
            names.update(f"{node.module}.{alias.name}" for alias in node.names)
    return names


def _cross_module_violations(module: str) -> list[str]:
    violations = []
    for path in sorted((MODULES_DIR / module).rglob("*.py")):
        for name in sorted(_imported_modules(path)):
            parts = name.split(".")
            if (
                len(parts) >= 4
                and parts[:2] == ["app", "modules"]
                and parts[2] != module
                and parts[3] in _PRIVATE_FILES
            ):
                violations.append(f"{path.relative_to(MODULES_DIR)} imports {name}")
    return violations


def test_auth_never_imports_users_models_or_repository() -> None:
    assert _cross_module_violations("auth") == []


@pytest.mark.parametrize(
    "module", sorted(p.name for p in MODULES_DIR.iterdir() if (p / "__init__.py").exists())
)
def test_modules_never_import_another_modules_models_or_repository(module: str) -> None:
    assert _cross_module_violations(module) == []


def test_guard_detects_a_forbidden_import(tmp_path: Path) -> None:
    source = tmp_path / "service.py"
    source.write_text(
        "from app.modules.users.models import User\n"
        "from app.modules.users import repository\n"
        "import app.modules.users.models\n"
        "from app.modules.users.service import UserService\n",
        encoding="utf-8",
    )

    imported = _imported_modules(source)

    assert "app.modules.users.models" in imported
    assert "app.modules.users.repository" in imported
    assert "app.modules.users.service.UserService" in imported
