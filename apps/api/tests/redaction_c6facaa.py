"""The spelled-dot email and URL rules as they stood at c6facaa, before round 1 of #240: the
reference grammar for the parity fuzz in test_redaction.py. Test-only and frozen: the patterns
are copied as they were, and only the character data (marks, TLDs, word lists) comes from the
app. Backtracking and bounded to four separators, so run them on short inputs only."""

import re
from typing import Final

from app.redaction import _COMMON_WORDS, _MARKS, _TLDS, _WORD_TLDS, MASK

_FLAGS: Final = re.IGNORECASE
_MARKED: Final = rf"[{_MARKS}]*+"
_TLD_END: Final = rf"(?:{_TLDS})(?![a-z0-9])"
_START: Final = rf"(?<![\w.%+@\-{_MARKS}])"
_LOCAL: Final = rf"[\w+][\w.%+\-{_MARKS}]*+"
_LABEL: Final = rf"(?:[^\W_]|[\-{_MARKS}])"
_AT: Final = r"(?:\s*@\s*|\s*[(\[{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+(?:at|arroba|en)\s+)"
_SPELLED_DOT: Final = r"(?:\.|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+)"
_ONLY_SPELLED_DOT: Final = r"(?:\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+)"
_DOMAIN_START: Final = rf"(?<![\w.@\-{_MARKS}])"

SPELLED_EMAIL: Final = re.compile(
    rf"{_START}{_MARKED}(?P<local>{_LOCAL}(?:{_ONLY_SPELLED_DOT}[\w\-{_MARKS}]++){{0,4}})"
    rf"(?P<at>{_AT}){_LABEL}++(?:{_SPELLED_DOT}{_LABEL}++)*?(?P<dot>{_SPELLED_DOT})"
    rf"(?P<tld>{_TLD_END})",
    _FLAGS,
)
# The spelled-dot alternative of c6facaa's URL pattern; its "tld" group was None, so
# _mask_url always masked it.
SPELLED_URL: Final = re.compile(
    rf"{_DOMAIN_START}{_LABEL}{{2,}}+(?:\s+(?:dot|punto)\s+{_LABEL}++){{0,4}}\s+(?:dot|punto)\s+"
    rf"{_TLD_END}",
    _FLAGS,
)


def mask_spelled_email(match: re.Match[str]) -> str | None:
    weak_at = re.fullmatch(r"\s+(?:at|en)\s+", match.group("at"), _FLAGS) is not None
    if weak_at and match.group("local").lower() in _COMMON_WORDS:
        return None
    if match.group("dot") == "." and _missing_space(match, match.group("tld")):
        return None
    return MASK


def mask_spelled_url(match: re.Match[str]) -> str | None:
    return MASK


def _missing_space(match: re.Match[str], tld: str) -> bool:
    if tld.lower() not in _WORD_TLDS:
        return False
    start = match.start("tld")
    before = match.string[start - 2] if start >= 2 else ""
    if tld[0].isupper() and not tld.isupper() and before.islower():
        return True
    label = match.string[match.start() : start - 1].rsplit(".", 1)[-1]
    return any(char.isalpha() and not char.isascii() for char in label)
