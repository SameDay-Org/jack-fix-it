"""The receipt emails (#62), in English and Spanish: the payment's, sent once its job is booked,
and the tip's, sent once a tip goes through (Q-R4: no other receipt email in the MVP).

Transactional mail: no marketing, no unsubscribe link, no promise (AGENTS.md "Legal copy": the
copy never says money is held, protected, released or guaranteed, and never names a refund;
tests/test_receipt_email_copy.py applies the app's own legal guard to every string here). What
is in it: the customer's first name, the receipt's code, the category, the pro's public name,
the scheduled date in the business time zone, the amounts, the card's brand and last 4 digits,
the city (never the street, Q-R2), and who issues it (settings, Q-R1). Never a Stripe id, the
platform's fee or the pro's payout. Every value that did not come from this file is
HTML-escaped in the HTML part.
"""

import html
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Final

from app.integrations.stripe_payments import CardFacts
from app.modules.auth.email_copy import EmailContent

DEFAULT_LOCALE: Final = "en"


@dataclass(frozen=True)
class _Copy:
    payment_subject: str  # {code}
    tip_subject: str  # {code}
    greeting: str  # {name}
    greeting_no_name: str
    payment_intro: str
    tip_intro: str  # {pro}
    tip_intro_no_pro: str
    receipt: str  # {code}
    category: str  # {category}
    pro: str  # {pro}
    scheduled: str  # {date}
    city: str  # {city}
    service: str
    tax: str
    tip: str
    total: str
    paid_with: str  # {method}
    card: str
    in_app: str
    why: str
    months: tuple[str, ...]
    date: str  # {month} {day} {year} {time}


COPY: Final = MappingProxyType(
    {
        "en": _Copy(
            payment_subject="Your Jack Fix It receipt · {code}",
            tip_subject="Your Jack Fix It tip receipt · {code}",
            greeting="Hi {name},",
            greeting_no_name="Hi,",
            payment_intro="Thank you for booking with Jack Fix It. Here is your receipt.",
            tip_intro="Thank you for your tip for {pro}. Here is its receipt.",
            tip_intro_no_pro="Thank you for your tip. Here is its receipt.",
            receipt="Receipt {code}",
            category="Service: {category}",
            pro="Pro: {pro}",
            scheduled="Scheduled: {date}",
            city="City: {city}",
            service="Service",
            tax="Tax",
            tip="Tip",
            total="Total paid",
            paid_with="Paid with {method}",
            card="Card",
            in_app="See this receipt any time in the app: open your job and tap Receipt.",
            why=(
                "You're getting this email because you booked a job with Jack Fix It. "
                "Questions? Open Help in the app."
            ),
            months=(
                "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ),
            date="{month} {day}, {year}, {time}",
        ),
        "es": _Copy(
            payment_subject="Tu recibo de Jack Fix It · {code}",
            tip_subject="Tu recibo de propina de Jack Fix It · {code}",
            greeting="Hola, {name}:",
            greeting_no_name="Hola:",
            payment_intro="Gracias por reservar con Jack Fix It. Este es tu recibo.",
            tip_intro="Gracias por tu propina para {pro}. Este es su recibo.",
            tip_intro_no_pro="Gracias por tu propina. Este es su recibo.",
            receipt="Recibo {code}",
            category="Servicio: {category}",
            pro="Profesional: {pro}",
            scheduled="Programado: {date}",
            city="Ciudad: {city}",
            service="Servicio",
            tax="Impuestos",
            tip="Propina",
            total="Total pagado",
            paid_with="Pagado con {method}",
            card="Tarjeta",
            in_app="Consulta este recibo cuando quieras en la app: abre tu trabajo y toca Recibo.",
            why=(
                "Recibes este correo porque reservaste un trabajo con Jack Fix It. "
                "¿Preguntas? Abre Ayuda en la app."
            ),
            months=(
                "ene", "feb", "mar", "abr", "may", "jun",
                "jul", "ago", "sept", "oct", "nov", "dic",
            ),
            date="{day} {month} {year}, {time}",
        ),
    }
)  # fmt: skip

# Stripe's codes, as a card or a wallet is called; anything else is shown title-cased.
_BRANDS: Final = MappingProxyType(
    {
        "visa": "Visa",
        "mastercard": "Mastercard",
        "amex": "American Express",
        "discover": "Discover",
        "diners": "Diners Club",
        "jcb": "JCB",
        "unionpay": "UnionPay",
    }
)
_WALLETS: Final = MappingProxyType(
    {"apple_pay": "Apple Pay", "google_pay": "Google Pay", "link": "Link"}
)


def copy_of(locale: str) -> _Copy:
    return COPY.get(locale, COPY[DEFAULT_LOCALE])


def money(cents: int) -> str:
    """$1,234.50: the receipts are in US dollars."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}${whole:,}.{part:02d}"


def _named(code: str, names: MappingProxyType[str, str]) -> str:
    return names.get(code, code.replace("_", " ").title())


def payment_method(card: CardFacts | None, locale: str) -> str:
    """Visa •••• 4242, Apple Pay (Visa •••• 4242), or Card."""
    copy = copy_of(locale)
    described = copy.card if card is None or card.brand is None else _named(card.brand, _BRANDS)
    if card is not None and card.last4 is not None:
        described = f"{described} •••• {card.last4}"
    if card is not None and card.wallet is not None:
        described = f"{_named(card.wallet, _WALLETS)} ({described})"
    return described


def local_date(value: datetime, locale: str) -> str:
    """A time already in the business time zone (naive), as the customer's language writes it:
    Nov 22, 2026, 2:30 PM / 22 nov 2026, 14:30."""
    copy = copy_of(locale)
    if locale == "es":
        time = f"{value.hour:02d}:{value.minute:02d}"
    else:
        hour = value.hour % 12 or 12
        time = f"{hour}:{value.minute:02d} {'AM' if value.hour < 12 else 'PM'}"
    return copy.date.format(
        month=copy.months[value.month - 1], day=value.day, year=value.year, time=time
    )


@dataclass(frozen=True)
class ReceiptEmailFacts:
    """What a receipt email says, every value already chosen by the caller."""

    locale: str
    first_name: str | None
    code: str
    category: str | None
    pro_name: str | None
    scheduled: str
    city: str | None
    lines: tuple[tuple[str, int], ...]  # (label, cents)
    total_cents: int
    card: CardFacts | None
    issuer: tuple[str, ...]  # the legal name, the support email, the address: those set


def _render(subject: str, intro: str, facts: ReceiptEmailFacts) -> EmailContent:
    copy = copy_of(facts.locale)
    greeting = (
        copy.greeting.format(name=facts.first_name) if facts.first_name else copy.greeting_no_name
    )
    details = [copy.receipt.format(code=facts.code)]
    if facts.category:
        details.append(copy.category.format(category=facts.category))
    if facts.pro_name:
        details.append(copy.pro.format(pro=facts.pro_name))
    details.append(copy.scheduled.format(date=facts.scheduled))
    if facts.city:
        details.append(copy.city.format(city=facts.city))
    amounts = [f"{label}: {money(cents)}" for label, cents in facts.lines]
    amounts.append(f"{copy.total}: {money(facts.total_cents)}")
    method = copy.paid_with.format(method=payment_method(facts.card, facts.locale))
    footer = [copy.why, *([" · ".join(facts.issuer)] if facts.issuer else [])]
    blocks = [[greeting], [intro], details, amounts, [method], [copy.in_app], footer]
    text = "\n\n".join("\n".join(block) for block in blocks) + "\n"

    def paragraph(lines: list[str]) -> str:
        return "<p>" + "<br>".join(html.escape(line) for line in lines) + "</p>"

    body = "".join(paragraph(block) for block in blocks)
    return EmailContent(subject=subject, text=text, html=body)


def payment_receipt_email(facts: ReceiptEmailFacts) -> EmailContent:
    copy = copy_of(facts.locale)
    return _render(copy.payment_subject.format(code=facts.code), copy.payment_intro, facts)


def tip_receipt_email(facts: ReceiptEmailFacts) -> EmailContent:
    copy = copy_of(facts.locale)
    return _render(
        copy.tip_subject.format(code=facts.code),
        copy.tip_intro.format(pro=facts.pro_name) if facts.pro_name else copy.tip_intro_no_pro,
        facts,
    )
