"""The branded email layout (#92 part 1, plan D18.4): every email the API sends (the password
reset code and the receipts) in one layout, English and Spanish by the user's locale, a plain
text part, a footer from the settings, every dynamic value HTML-escaped, nothing fetched.

Snapshots: tests/email_snapshots/. After a deliberate change to the layout or the copy, run
`UPDATE_EMAIL_SNAPSHOTS=1 uv run pytest tests/test_email_layout.py` and review the diff.
"""

import html
import os
from dataclasses import fields, replace
from pathlib import Path
from typing import Any, Final

import pytest

from app.email_layout import (
    BRAND,
    FOOTER,
    NO_IDENTITY,
    EmailContent,
    SenderIdentity,
    Strong,
    render_email,
    with_strong,
)
from app.integrations.stripe_payments import CardFacts
from app.modules.auth.email_copy import PASSWORD_RESET_CODE, password_reset_code_email
from app.modules.receipts.email_copy import (
    COPY,
    ReceiptEmailFacts,
    payment_receipt_email,
    tip_receipt_email,
)
from tests.test_receipt_emails import FORBIDDEN

SNAPSHOTS: Final = Path(__file__).parent / "email_snapshots"
LANGUAGES: Final = ("en", "es")
# The legal footer as the #601 brief words it (RECEIPT_LEGAL_NAME, set by Cesar).
LEGAL_NAME: Final = "Same Day Auto Group LLC, doing business as John Got It"
FULL: Final = SenderIdentity(
    legal_name=LEGAL_NAME,
    support_email="help@jackfixit.invalid",
    mailing_address="100 Main St, Orlando FL 32801",
)
# What an attacker could put in a name, a category, a city or a setting.
INJECTION: Final = "<script>alert('x')</script><img src=\"https://evil.invalid/p.gif\">&amp;"


def sentinel(n: int) -> str:
    return f'<i id="s{n}">&\'"{n}</i>'


def receipt_facts(
    locale: str, sender: SenderIdentity = FULL, **overrides: Any
) -> ReceiptEmailFacts:
    copy = COPY.get(locale, COPY["en"])
    base = ReceiptEmailFacts(
        locale=locale,
        first_name="Ana",
        code="JF-7Q2K",
        category="Plomería" if locale == "es" else "Plumbing",
        pro_name="María P.",
        scheduled="15 ene 2030, 09:30" if locale == "es" else "Jan 15, 2030, 9:30 AM",
        city="Orlando",
        lines=((copy.service, 12_000), (copy.tax, 780)),
        total_cents=12_780,
        card=CardFacts(brand="visa", last4="4242", wallet=None),
        sender=sender,
    )
    return replace(base, **overrides)


def every_email(locale: str, sender: SenderIdentity = FULL) -> dict[str, EmailContent]:
    return {
        "password_reset": password_reset_code_email(locale, "042917", 900, sender=sender),
        "payment_receipt": payment_receipt_email(receipt_facts(locale, sender)),
        "tip_receipt": tip_receipt_email(
            receipt_facts(locale, sender, lines=((COPY[locale].tip, 1_500),), total_cents=1_500)
        ),
    }


# --- One layout, both languages, a plain text part -------------------------------------------


@pytest.mark.parametrize("language", LANGUAGES)
def test_every_email_is_in_the_layout_in_the_users_language(language: str) -> None:
    footer = FOOTER[language]
    for name, email in every_email(language).items():
        assert email.html.startswith("<!doctype html>"), name
        assert f'<html lang="{language}">' in email.html
        assert f"<title>{html.escape(email.subject)}</title>" in email.html
        assert f">{BRAND}</td>" in email.html  # the header
        assert html.escape(footer.service) in email.html
        assert html.escape(footer.ask_by_email.format(email=FULL.support_email)) in email.html
        assert email.text.startswith(f"{BRAND}\n\n")
        assert "\n\n--\n" in email.text
        assert email.text.endswith(
            f"{footer.service}\n"
            f"{footer.ask_by_email.format(email=FULL.support_email)}\n"
            f"{LEGAL_NAME} · 100 Main St, Orlando FL 32801\n"
        ), name


def test_the_reset_email_reads_the_same_in_text_and_html() -> None:
    en = password_reset_code_email("en", "042917", 900, sender=FULL)
    es = password_reset_code_email("es", "042917", 900, sender=FULL)

    assert en.text == (
        "John Got It\n\n"
        "Your password reset code is 042917.\n\n"
        "It expires in 15 minutes and works once.\n\n"
        "If you did not ask to reset your password, you can ignore this email.\n\n"
        "--\n"
        "This is a service email about your John Got It account. It is sent even if you "
        "turned off marketing emails.\n"
        "Questions? Write to help@jackfixit.invalid or open Help in the app.\n"
        f"{LEGAL_NAME} · 100 Main St, Orlando FL 32801\n"
    )
    assert es.text == (
        "John Got It\n\n"
        "Tu código para restablecer la contraseña es 042917.\n\n"
        "Vence en 15 minutos y se puede usar una sola vez.\n\n"
        "Si no pediste restablecer tu contraseña, puedes ignorar este correo.\n\n"
        "--\n"
        "Este es un correo de servicio sobre tu cuenta de John Got It. Se envía aunque hayas "
        "desactivado los correos de marketing.\n"
        "¿Preguntas? Escribe a help@jackfixit.invalid o abre Ayuda en la app.\n"
        f"{LEGAL_NAME} · 100 Main St, Orlando FL 32801\n"
    )
    assert "<strong>042917</strong>" in en.html
    assert "Your password reset code is <strong>042917</strong>." in en.html


def test_the_receipt_keeps_its_reason_above_the_standard_footer() -> None:
    email = payment_receipt_email(receipt_facts("en"))

    assert (
        "\n\n--\nYou're getting this email because you booked a job with John Got It.\n"
        "This is a service email" in email.text
    )
    assert html.escape("You're getting this email because you booked a job") in email.html


def test_a_locale_without_copy_is_english() -> None:
    email = password_reset_code_email("pt", "042917", 900, sender=FULL)

    assert email == password_reset_code_email("en", "042917", 900, sender=FULL)
    assert '<html lang="en">' in email.html
    receipt = payment_receipt_email(receipt_facts("pt", category="Plumbing"))
    assert '<html lang="en">' in receipt.html
    assert FOOTER["en"].service in receipt.text


# --- The footer from the settings -------------------------------------------------------------


@pytest.mark.parametrize("language", LANGUAGES)
def test_without_settings_the_footer_points_to_help_in_the_app(language: str) -> None:
    footer = FOOTER[language]
    for email in every_email(language, NO_IDENTITY).values():
        assert email.text.endswith(f"{footer.service}\n{footer.ask_in_app}\n")
        assert "@" not in email.text.split("\n--\n")[1]


def test_the_identity_shows_what_is_set() -> None:
    address_only = SenderIdentity(
        legal_name=None, support_email=None, mailing_address="100 Main St, Orlando FL 32801"
    )
    name_only = SenderIdentity(legal_name=LEGAL_NAME, support_email=None, mailing_address=None)

    assert password_reset_code_email("en", "1", 900, sender=address_only).text.endswith(
        "Questions? Open Help in the app.\n100 Main St, Orlando FL 32801\n"
    )
    assert password_reset_code_email("en", "1", 900, sender=name_only).text.endswith(
        f"Questions? Open Help in the app.\n{LEGAL_NAME}\n"
    )


# --- Every dynamic value escaped, nothing fetched --------------------------------------------


@pytest.mark.parametrize("language", LANGUAGES)
def test_every_dynamic_value_is_html_escaped(language: str) -> None:
    """A sentinel tag through every value from outside the copy: none reaches the HTML as
    markup; each is there escaped. The text part carries them as they are."""
    values = {
        "first_name": sentinel(1),
        "code": sentinel(2),
        "category": sentinel(3),
        "pro_name": sentinel(4),
        "scheduled": sentinel(5),
        "city": sentinel(6),
    }
    sender = SenderIdentity(
        legal_name=sentinel(7), support_email=sentinel(8), mailing_address=sentinel(9)
    )
    facts = receipt_facts(
        language,
        sender,
        **values,
        lines=((sentinel(10), 100),),
        total_cents=100,
        card=CardFacts(brand="visa", last4=sentinel(11), wallet=None),
    )
    reset = password_reset_code_email(language, sentinel(12), 900, sender=sender)
    direct = render_email(
        locale=language,
        subject=sentinel(13),
        paragraphs=[(sentinel(14), (sentinel(15), Strong(sentinel(16)), sentinel(17)))],
        reason=sentinel(18),
        sender=sender,
    )
    rendered = {
        "payment": (payment_receipt_email(facts), range(1, 12)),
        "tip": (tip_receipt_email(facts), range(1, 12)),
        "reset": (reset, [7, 8, 9, 12]),
        "direct": (direct, [7, 8, 9, *range(13, 19)]),
    }

    for name, (email, numbers) in rendered.items():
        lowered = email.html.lower()
        assert "<i " not in lowered, name
        assert "</i>" not in lowered, name
        for n in numbers:
            assert html.escape(sentinel(n)) in email.html, (name, n)
            # The subject is the email's own field (and the HTML's title), not in the text.
            assert sentinel(n) in (email.subject if n == 13 else email.text), (name, n)


def test_an_injection_in_a_name_or_an_address_stays_text() -> None:
    sender = SenderIdentity(legal_name=INJECTION, support_email=None, mailing_address=INJECTION)
    email = payment_receipt_email(
        receipt_facts("en", sender, first_name=INJECTION, city=INJECTION, pro_name=INJECTION)
    )

    lowered = email.html.lower()
    for markup in ("<script", "<img", 'src="'):  # as text (escaped), never as markup
        assert markup not in lowered, markup
    assert html.escape(INJECTION) in email.html
    assert "&amp;amp;" in email.html  # an entity in a value is shown, never decoded


@pytest.mark.parametrize("language", LANGUAGES)
def test_nothing_is_fetched_tracked_or_linked(language: str) -> None:
    for name, email in every_email(language).items():
        lowered = email.html.lower()
        for fetch in (
            "<img",
            "src=",
            "http:",
            "https:",
            "<a ",
            "href",
            "<link",
            "<script",
            "url(",
            "@import",
            "<iframe",
            "<object",
            "background=",
            "unsubscribe",
        ):
            assert fetch not in lowered, (name, fetch)


# --- The legal-copy rule ----------------------------------------------------------------------


@pytest.mark.parametrize("language", LANGUAGES)
def test_the_layout_and_reset_copy_promise_nothing_the_legal_rule_forbids(language: str) -> None:
    strings = [getattr(FOOTER[language], field.name) for field in fields(FOOTER[language])]
    reset = PASSWORD_RESET_CODE[language]
    strings += [getattr(reset, field.name) for field in fields(reset)]
    for email in every_email(language).values():
        strings += [email.subject, email.text]

    found = [(text, match) for text in strings for match in FORBIDDEN[language].findall(text)]

    assert found == []


def test_with_strong_marks_only_its_value() -> None:
    assert with_strong("Code {code}.", "code", "1") == ("Code ", Strong("1"), ".")
    assert with_strong("No marker.", "code", "1") == "No marker."


# --- Snapshots ---------------------------------------------------------------------------------


def _snapshots() -> dict[str, str]:
    injected = SenderIdentity(
        legal_name=LEGAL_NAME, support_email=INJECTION, mailing_address=INJECTION
    )
    found: dict[str, str] = {}
    for language in LANGUAGES:
        found[f"password_reset_{language}.html"] = password_reset_code_email(
            language, "042917", 900, sender=FULL
        ).html
        found[f"payment_receipt_injected_{language}.html"] = payment_receipt_email(
            receipt_facts(language, injected, first_name=INJECTION, city=INJECTION)
        ).html
    return found


@pytest.mark.parametrize("name", sorted(_snapshots()))
def test_the_html_matches_its_snapshot(name: str) -> None:
    rendered = _snapshots()[name]
    path = SNAPSHOTS / name
    if os.environ.get("UPDATE_EMAIL_SNAPSHOTS") == "1":
        SNAPSHOTS.mkdir(exist_ok=True)
        path.write_bytes(rendered.encode())
    assert path.read_bytes().decode() == rendered
