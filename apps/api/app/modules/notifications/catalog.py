"""Push copy in English and Spanish (D10.3, #54). Titles and bodies show on lock screens, so
they carry no personal data: placeholders are limited to PLACEHOLDERS (a test scans for it).
The real notification kinds come with #55 and #65; `push.test.*` is a neutral message.
"""

import string
from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

DEFAULT_LOCALE: Final = "en"
# Values that may appear on a lock screen: identifiers, never names, addresses or messages.
PLACEHOLDERS: Final = frozenset({"public_code"})

CATALOG: Final[Mapping[str, Mapping[str, str]]] = MappingProxyType(
    {
        "en": MappingProxyType(
            {
                "push.test.title": "Jack Fix It",
                "push.test.body": "This is a test notification for {public_code}.",
            }
        ),
        "es": MappingProxyType(
            {
                "push.test.title": "Jack Fix It",
                "push.test.body": "Esta es una notificación de prueba para {public_code}.",
            }
        ),
    }
)


def placeholders(template: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(template) if name is not None}


def catalog_keys() -> set[str]:
    return set(CATALOG[DEFAULT_LOCALE])


def render(locale: str, key: str, params: Mapping[str, str]) -> str:
    """The text of `key` in `locale` (English when the locale has no copy)."""
    copy = CATALOG.get(locale, CATALOG[DEFAULT_LOCALE])
    return copy[key].format_map(params)
