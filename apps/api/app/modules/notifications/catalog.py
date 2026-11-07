"""Push copy in English and Spanish (D10.3, #54). Titles and bodies show on lock screens, so
they carry no personal data: placeholders are limited to PLACEHOLDERS (a test scans for it).
#55 adds a new request (to a dispatched pro), a new quote (to the customer) and a quote
accepted (to its pro); #65 the job's steps and a booking whose payment was canceled. The On my
way copy points to the app for the arrival code: the code itself never leaves the customer's job
view. `push.test.*` is a neutral message.
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
                "push.job_booked.title": "You're booked",
                "push.job_booked.body": (
                    "Job {public_code} is scheduled. See the details in the app."
                ),
                "push.job_scheduled.title": "New job scheduled",
                "push.job_scheduled.body": "Job {public_code} is confirmed and on your schedule.",
                "push.job_on_the_way.title": "Your pro is on the way",
                "push.job_on_the_way.body": (
                    "Your pro is heading to job {public_code}. Your arrival code is in the app."
                ),
                "push.job_checked_in.title": "Your pro has arrived",
                "push.job_checked_in.body": "Your pro checked in for job {public_code}.",
                "push.job_started.title": "Your job has started",
                "push.job_started.body": "Work on job {public_code} has started.",
                "push.job_done.title": "Your pro marked the job done",
                "push.job_done.body": "Please take a look at job {public_code} in the app.",
                "push.booking_not_completed.title": "Your booking was not completed",
                "push.booking_not_completed.body": (
                    "The payment for {public_code} did not go through. "
                    "You can choose a quote again."
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
                "push.job_booked.title": "Tu trabajo está reservado",
                "push.job_booked.body": (
                    "El trabajo {public_code} está programado. Mira los detalles en la app."
                ),
                "push.job_scheduled.title": "Nuevo trabajo programado",
                "push.job_scheduled.body": (
                    "El trabajo {public_code} está confirmado y en tu agenda."
                ),
                "push.job_on_the_way.title": "Tu profesional va en camino",
                "push.job_on_the_way.body": (
                    "Tu profesional va en camino al trabajo {public_code}. "
                    "Tu código de llegada está en la app."
                ),
                "push.job_checked_in.title": "Tu profesional llegó",
                "push.job_checked_in.body": (
                    "Tu profesional registró su llegada al trabajo {public_code}."
                ),
                "push.job_started.title": "Tu trabajo comenzó",
                "push.job_started.body": "Comenzó el trabajo {public_code}.",
                "push.job_done.title": "Tu profesional marcó el trabajo como terminado",
                "push.job_done.body": "Revisa el trabajo {public_code} en la app.",
                "push.booking_not_completed.title": "Tu reserva no se completó",
                "push.booking_not_completed.body": (
                    "El pago de {public_code} no se completó. "
                    "Puedes elegir un presupuesto de nuevo."
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
