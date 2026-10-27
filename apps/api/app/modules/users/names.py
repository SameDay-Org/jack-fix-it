"""People's names (#165): one validated type for every way a name comes in, and the public form.

Names are PII: they never appear in logs, Sentry or analytics. Stored as entered after
trimming and collapsing inner spaces; their case is never changed.
"""

import unicodedata
from typing import Annotated, Final

from pydantic import AfterValidator, BeforeValidator, StringConstraints

from app.redaction import KnownValues, redact_text

NAME_MAX_LENGTH: Final = 60
# Allowed besides letters (and the combining marks of decomposed accents): space, hyphen,
# apostrophe (ASCII, and the typographic one phone keyboards type) and period.
_PUNCTUATION: Final = frozenset(" -'\N{RIGHT SINGLE QUOTATION MARK}.")
_LINE_BREAKS: Final = frozenset("\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}")


def _is_letter(char: str) -> bool:
    return unicodedata.category(char).startswith("L")


def _collapse_spaces(value: object) -> object:
    """Trims, and turns each run of spaces into one. Control, format and line-break
    characters (NUL, tab, newline, zero-width space...) are refused, not collapsed."""
    if not isinstance(value, str):
        return value
    if any(unicodedata.category(char)[0] == "C" or char in _LINE_BREAKS for char in value):
        raise ValueError("a name has no control, format or line-break characters")
    return " ".join(value.split())


def _letters(value: str) -> str:
    allowed = all(
        _is_letter(char) or unicodedata.category(char).startswith("M") or char in _PUNCTUATION
        for char in value
    )
    if not allowed or not any(_is_letter(char) for char in value):
        raise ValueError("letters, spaces, hyphens, apostrophes and periods only")
    return value


PersonName = Annotated[
    str,
    BeforeValidator(_collapse_spaces),
    StringConstraints(min_length=1, max_length=NAME_MAX_LENGTH),
    AfterValidator(_letters),
]


def public_name(first_name: str | None, last_name: str | None) -> str | None:
    """How a pro shows publicly: the first name and the last name's initial, "María P."
    None when either name is missing. Customers see it on a pro's quote (#188); the public pro
    profile (#53) will show it too."""
    if not first_name or not last_name:
        return None
    initial = next((char for char in last_name if _is_letter(char)), None)
    if initial is None:
        return None
    return f"{first_name} {initial.upper()}."


def safe_public_name(
    first_name: str | None, last_name: str | None, known: KnownValues
) -> str | None:
    """public_name, or None when it shows a contact detail (app.redaction): the account's own
    email or phone (`known`), then every pattern ("repair.example.com", a phone spelled out).
    Contacts stay hidden before payment and names are editable, so this runs on every read,
    which covers names stored before any check at write time (#194). Withheld, never partly
    masked: a name with a mask reads as a broken profile, and None is already a valid value."""
    name = public_name(first_name, last_name)
    if name is None or redact_text(name, known).redacted:
        return None
    return name
