"""Push copy in English and Spanish (D10.3, #54). Titles and bodies show on lock screens, so
they carry no personal data: placeholders are limited to PLACEHOLDERS (a test scans for it).
#55 adds a new request (to a dispatched pro), a new quote (to the customer) and a quote
accepted (to its pro); the job status kinds come with #65. `push.test.*` is a neutral message.
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
                "push.new_request.title": "New request",
                "push.new_request.body": "Request {public_code} is waiting for your quote.",
                "push.new_quote.title": "You have a new quote",
                "push.new_quote.body": "A pro sent a quote for {public_code}.",
                "push.quote_accepted.title": "Your quote was accepted",
                "push.quote_accepted.body": (
                    "The customer accepted your quote for {public_code}. "
                    "We'll confirm the job once payment goes through."
                ),
            }
        ),
        "es": MappingProxyType(
            {
                "push.test.title": "Jack Fix It",
                "push.test.body": "Esta es una notificación de prueba para {public_code}.",
                "push.new_request.title": "Nueva solicitud",
                "push.new_request.body": "La solicitud {public_code} espera tu presupuesto.",
                "push.new_quote.title": "Tienes un nuevo presupuesto",
                "push.new_quote.body": "Un profesional envió un presupuesto para {public_code}.",
                "push.quote_accepted.title": "Aceptaron tu presupuesto",
                "push.quote_accepted.body": (
                    "El cliente aceptó tu presupuesto para {public_code}. "
                    "Confirmaremos el trabajo cuando se procese el pago."
                ),
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
