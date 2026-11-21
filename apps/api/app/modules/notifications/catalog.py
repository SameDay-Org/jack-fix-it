"""Push copy in English and Spanish (D10.3, #54). Titles and bodies show on lock screens, so
they carry no personal data: placeholders are limited to PLACEHOLDERS (a test scans for it).
#55 adds a new request (to a dispatched pro), a new quote (to the customer) and a quote
accepted (to its pro); #65 the job's steps and a booking whose payment was canceled; #66/#67 the
job confirmed (to its pro); #69 a job cancelled by its customer (to the pro, and to the
customer with the refund in neutral words, no timing); #75 a problem reported (to the pro);
#76 its resolution (to both sides, one message per decision, never the admin's note); #280
payouts set up (to an approved pro); #73 a new chat message (to the other side, never its
text). The On my
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
                "push.job_confirmed.title": "Job confirmed",
                "push.job_confirmed.body": "Job {public_code} is confirmed as complete.",
                "push.job_cancelled_by_customer.title": "The customer cancelled",
                "push.job_cancelled_by_customer.body": (
                    "Job {public_code} was cancelled. It is no longer on your schedule."
                ),
                "push.job_cancelled_by_pro.title": "Your pro cancelled",
                "push.job_cancelled_by_pro.body": (
                    "Your pro cancelled job {public_code}. Your full payment goes back to your "
                    "original payment method. You can start a new request in the app anytime."
                ),
                "push.job_cancelled.title": "Your job was cancelled",
                "push.job_cancelled.body": (
                    "Job {public_code} is cancelled. Any refund due goes back to your "
                    "original payment method."
                ),
                "push.job_disputed.title": "The customer reported a problem",
                "push.job_disputed.body": (
                    "Job {public_code} needs attention. Open it in the app to reply."
                ),
                "push.booking_not_completed.title": "Your booking was not completed",
                "push.booking_not_completed.body": (
                    "The payment for {public_code} did not go through. See your request in the app."
                ),
                "push.dispute_refunded.title": "Your payment was refunded",
                "push.dispute_refunded.body": (
                    "We refunded your payment for job {public_code}. "
                    "Your bank may take a few days to show it."
                ),
                "push.dispute_partly_refunded.title": "Part of your payment was refunded",
                "push.dispute_partly_refunded.body": (
                    "We refunded part of your payment for job {public_code}. "
                    "Your bank may take a few days to show it."
                ),
                "push.dispute_closed.title": "Your problem report was reviewed",
                "push.dispute_closed.body": (
                    "We reviewed job {public_code} and closed your report. "
                    "See the details in the app."
                ),
                "push.dispute_payout_released.title": "The problem report was resolved",
                "push.dispute_payout_released.body": (
                    "Your payout for job {public_code} is on its way."
                ),
                "push.dispute_payout_partly_released.title": "The problem report was resolved",
                "push.dispute_payout_partly_released.body": (
                    "Part of your payout for job {public_code} is on its way."
                ),
                "push.dispute_payout_refunded.title": "The problem report was resolved",
                "push.dispute_payout_refunded.body": (
                    "The customer was refunded for job {public_code}, so it has no payout."
                ),
                "push.payouts_enabled.title": "Payouts are set up",
                "push.payouts_enabled.body": "You can receive requests now.",
                "push.chat_message.title": "New message",
                "push.chat_message.body": "You have a new message about job {public_code}.",
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
                "push.job_confirmed.title": "Trabajo confirmado",
                "push.job_confirmed.body": (
                    "El trabajo {public_code} quedó confirmado como terminado."
                ),
                "push.job_cancelled_by_customer.title": "El cliente canceló",
                "push.job_cancelled_by_customer.body": (
                    "El trabajo {public_code} fue cancelado. Ya no está en tu agenda."
                ),
                "push.job_cancelled_by_pro.title": "Tu profesional canceló",
                "push.job_cancelled_by_pro.body": (
                    "Tu profesional canceló el trabajo {public_code}. El pago completo vuelve a "
                    "tu método de pago original. Puedes hacer una nueva solicitud en la app "
                    "cuando quieras."
                ),
                "push.job_cancelled.title": "Tu trabajo fue cancelado",
                "push.job_cancelled.body": (
                    "El trabajo {public_code} está cancelado. Cualquier reembolso que corresponda "
                    "vuelve a tu método de pago original."
                ),
                "push.job_disputed.title": "El cliente reportó un problema",
                "push.job_disputed.body": (
                    "El trabajo {public_code} necesita atención. Ábrelo en la app para responder."
                ),
                "push.booking_not_completed.title": "Tu reserva no se completó",
                "push.booking_not_completed.body": (
                    "El pago de {public_code} no se completó. Mira tu solicitud en la app."
                ),
                "push.dispute_refunded.title": "Te reembolsamos el pago",
                "push.dispute_refunded.body": (
                    "Reembolsamos tu pago del trabajo {public_code}. "
                    "Tu banco puede tardar unos días en mostrarlo."
                ),
                "push.dispute_partly_refunded.title": "Te reembolsamos parte del pago",
                "push.dispute_partly_refunded.body": (
                    "Reembolsamos parte de tu pago del trabajo {public_code}. "
                    "Tu banco puede tardar unos días en mostrarlo."
                ),
                "push.dispute_closed.title": "Revisamos tu reporte",
                "push.dispute_closed.body": (
                    "Revisamos el trabajo {public_code} y cerramos tu reporte. "
                    "Mira los detalles en la app."
                ),
                "push.dispute_payout_released.title": "Se resolvió el reporte del problema",
                "push.dispute_payout_released.body": (
                    "Tu pago del trabajo {public_code} va en camino."
                ),
                "push.dispute_payout_partly_released.title": (
                    "Se resolvió el reporte del problema"
                ),
                "push.dispute_payout_partly_released.body": (
                    "Parte de tu pago del trabajo {public_code} va en camino."
                ),
                "push.dispute_payout_refunded.title": "Se resolvió el reporte del problema",
                "push.dispute_payout_refunded.body": (
                    "Se le reembolsó al cliente el trabajo {public_code}, así que no tiene pago."
                ),
                "push.payouts_enabled.title": "Tus pagos están listos",
                "push.payouts_enabled.body": "Ya puedes recibir solicitudes.",
                "push.chat_message.title": "Nuevo mensaje",
                "push.chat_message.body": "Tienes un mensaje nuevo sobre el trabajo {public_code}.",
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
