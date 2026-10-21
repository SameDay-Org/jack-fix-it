"""ADR 0003: a module uses another module through its service, never its models or repository."""

import ast
from pathlib import Path

import pytest

MODULES_DIR = Path(__file__).resolve().parents[1] / "app" / "modules"
MODULES_PACKAGE = "app.modules"
# Files of another module that a module may never import.
_PRIVATE_FILES = ("models", "repository")


def _imported_modules(path: Path, package: str) -> set[str]:
    """Every dotted name a file imports, with relative imports resolved against `package`.

    `from app.modules.x import models` yields both `app.modules.x` and `app.modules.x.models`.
    """
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parent = package.split(".")[: len(package.split(".")) - node.level + 1]
                base = ".".join([*parent, node.module] if node.module else parent)
            else:
                base = node.module or ""
            names.add(base)
            names.update(f"{base}.{alias.name}" for alias in node.names)
    return names


def _cross_module_violations(modules_dir: Path, module: str) -> list[str]:
    """One entry per file and forbidden module: "auth/x.py imports app.modules.users.models"."""
    violations: set[str] = set()
    for path in sorted((modules_dir / module).rglob("*.py")):
        relative = path.relative_to(modules_dir).with_suffix("").parts
        package = ".".join([MODULES_PACKAGE, *relative[:-1]])
        for name in sorted(_imported_modules(path, package)):
            parts = name.split(".")
            if (
                len(parts) >= 4
                and parts[:2] == MODULES_PACKAGE.split(".")
                and parts[2] != module
                and parts[3] in _PRIVATE_FILES
            ):
                violations.add(f"{'/'.join(relative)}.py imports {'.'.join(parts[:4])}")
    return sorted(violations)


def test_auth_never_imports_users_models_or_repository() -> None:
    assert _cross_module_violations(MODULES_DIR, "auth") == []


@pytest.mark.parametrize(
    "module", sorted(p.name for p in MODULES_DIR.iterdir() if (p / "__init__.py").exists())
)
def test_modules_never_import_another_modules_models_or_repository(module: str) -> None:
    assert _cross_module_violations(MODULES_DIR, module) == []


@pytest.mark.parametrize(
    "line",
    [
        "from app.modules.users.models import User",
        "from app.modules.users import repository",
        "import app.modules.users.models",
        "from ..users.models import User",
        "from ..users import models",
    ],
)
def test_guard_detects_a_forbidden_import(tmp_path: Path, line: str) -> None:
    (tmp_path / "auth").mkdir()
    (tmp_path / "auth" / "service.py").write_text(f"{line}\n", encoding="utf-8")

    assert len(_cross_module_violations(tmp_path, "auth")) == 1


def test_guard_allows_services_and_own_module(tmp_path: Path) -> None:
    (tmp_path / "auth").mkdir()
    (tmp_path / "auth" / "service.py").write_text(
        "from app.modules.users.service import UserService\n"
        "from app.modules.users.types import UserAccount\n"
        "from app.modules.auth.models import RefreshToken\n"
        "from .models import RefreshToken as Token\n"
        "from . import repository\n",
        encoding="utf-8",
    )

    assert _cross_module_violations(tmp_path, "auth") == []
