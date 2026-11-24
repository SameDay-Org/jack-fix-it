"""The brand users read is John Got It (#601, Cesar 2026-11-23): no copy the API sends users
(the emails, the push catalog, the pages and messages it returns) names the old brand or its
persona. Code identifiers, the database, the routes, the environment variable names and the
jackfixit URL scheme keep their names.
"""

import ast
import re
from dataclasses import asdict
from pathlib import Path
from typing import Final

import pytest

from app.email_layout import BRAND, FOOTER
from app.modules.auth.email_copy import PASSWORD_RESET_CODE
from app.modules.notifications.catalog import CATALOG
from app.modules.payouts.router import _PAGE
from app.modules.receipts.email_copy import COPY
from app.web_service import InvalidServiceKeyError
from tests.test_email_layout import FULL, LANGUAGES, LEGAL_NAME, every_email

# "Jack" as a word: the old brand ("Jack Fix It") or its persona. The lowercase jackfixit of
# the URL scheme and the test hosts is not a word of copy.
OLD_NAME: Final = re.compile("(?<![A-Za-z])Jack(?![A-Za-z])")
APP: Final = Path(__file__).resolve().parent.parent / "app"
# Strings in app/ that reach developers only, never a user: the OpenAPI title and one route
# summary of the API reference. Out of the brief's scope (#601).
DEVELOPER_FACING: Final = frozenset({"Jack Fix It API", "Write to the team (Talk to Jack)"})


def _copy() -> dict[str, str]:
    """Every catalog and email template string, by where it lives."""
    found = {"email_layout.BRAND": BRAND, "payouts.return_page": _PAGE}
    found["web_service.invalid_service_key"] = InvalidServiceKeyError.message
    for locale, messages in CATALOG.items():
        found.update({f"push.{locale}.{key}": text for key, text in messages.items()})
    for locale, footer in FOOTER.items():
        found.update({f"footer.{locale}.{key}": text for key, text in asdict(footer).items()})
    for locale, reset in PASSWORD_RESET_CODE.items():
        found.update({f"reset.{locale}.{key}": text for key, text in asdict(reset).items()})
    for locale, receipt in COPY.items():
        found.update(
            {
                f"receipt.{locale}.{key}": text
                for key, text in asdict(receipt).items()
                if isinstance(text, str)
            }
        )
    return found


def test_no_user_facing_copy_contains_the_old_name() -> None:
    copy = _copy()

    assert len(copy) > 100  # the catalogs were read, not an empty scan
    assert {key: text for key, text in copy.items() if OLD_NAME.search(text)} == {}


@pytest.mark.parametrize("language", LANGUAGES)
def test_no_rendered_email_contains_the_old_name(language: str) -> None:
    for name, email in every_email(language).items():
        for part in (email.subject, email.text, email.html):
            assert not OLD_NAME.search(part), name


def _string_literals(path: Path) -> list[str]:
    """The string constants of a module, its docstrings left out (they are not copy)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings = {
        id(node.body[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef)
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
    }
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_no_string_in_the_app_names_the_old_brand() -> None:
    """A guard for copy added later: any string literal in app/, docstrings aside, outside the
    developer-facing ones."""
    hits = {
        f"{path.relative_to(APP)}: {text}"
        for path in APP.rglob("*.py")
        for text in _string_literals(path)
        if OLD_NAME.search(text) and text not in DEVELOPER_FACING
    }

    assert hits == set()


@pytest.mark.parametrize("language", LANGUAGES)
def test_the_email_header_and_footer_show_the_new_name(language: str) -> None:
    email = every_email(language, FULL)["password_reset"]
    account = "your John Got It account" if language == "en" else "tu cuenta de John Got It"

    assert BRAND == "John Got It"
    assert email.text.startswith("John Got It\n\n")
    assert f">{BRAND}</td></tr>" in email.html
    assert account in email.text
    assert account in email.html
    assert LEGAL_NAME == "Same Day Auto Group LLC, doing business as John Got It"
    assert LEGAL_NAME in email.text
    assert LEGAL_NAME in email.html
