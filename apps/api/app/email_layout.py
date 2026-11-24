"""The branded layout of every email the API sends (#92 part 1, plan D18.4): the password reset
code (auth) and the receipts (receipts), in English and Spanish by the user's locale.

One layout: the brand's header (the name, green on navy, as the app's tokens), the email's
paragraphs, and a footer with the email's own reason, the standard service-email line, where
to ask (the support email when RECEIPT_SUPPORT_EMAIL is set, else Help in the app) and who
sends it (RECEIPT_LEGAL_NAME and RECEIPT_MAILING_ADDRESS, those set). Every email has a plain
text part with the same words.

- Transactional only: no unsubscribe link (none is needed for service mail), no marketing.
- Nothing is fetched when the email opens: no image, no remote stylesheet or font, no link,
  no script, so no tracking pixel. Inline styles and tables only, as email clients need.
- Every value that did not come from this file is HTML-escaped (`html.escape`, quotes too):
  names, the category, the city, the amounts, the codes, the subject, the settings. A test
  renders sentinels through every value (tests/test_email_layout.py).
- The copy follows the legal-copy rule (AGENTS.md): it never promises a refund, a guarantee or
  protection. The test runs the app's legal guard over every string here.
- Nothing here logs.
"""

import html
from collections.abc import Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from app.config import Settings

BRAND: Final = "John Got It"
DEFAULT_LOCALE: Final = "en"

# The app's tokens (apps/mobile/src/theme/tokens.json).
_NAVY: Final = "#01172E"
_GREEN: Final = "#5EB72B"
_BACKGROUND: Final = "#F7FBFC"
_MUTED: Final = "#484F57"
_WHITE: Final = "#FFFFFF"
_FONT: Final = "Arial, Helvetica, sans-serif"


@dataclass(frozen=True)
class EmailContent:
    subject: str
    text: str
    html: str


@dataclass(frozen=True)
class Strong:
    """A value shown in bold in the HTML part (a code); as it is in the text part."""

    text: str


# A line is plain text, or segments of which some are bold; a paragraph is one or more lines.
Line = str | tuple[str | Strong, ...]
Paragraph = tuple[Line, ...]


def with_strong(template: str, name: str, value: str) -> Line:
    """`template` with `{name}` as a bold `value`: "Your code is {code}." -> segments."""
    before, marker, after = template.partition("{" + name + "}")
    if not marker:
        return template
    return (before, Strong(value), after)


@dataclass(frozen=True)
class SenderIdentity:
    """Who sends the emails, for the footer: each value is optional until Cesar sets it (Q-R1)."""

    legal_name: str | None
    support_email: str | None
    mailing_address: str | None

    @classmethod
    def from_settings(cls, settings: Settings) -> "SenderIdentity":
        return cls(
            legal_name=settings.receipt_legal_name,
            support_email=settings.receipt_support_email,
            mailing_address=settings.receipt_mailing_address,
        )


NO_IDENTITY: Final = SenderIdentity(legal_name=None, support_email=None, mailing_address=None)


@dataclass(frozen=True)
class _FooterCopy:
    service: str
    ask_by_email: str  # {email}
    ask_in_app: str


FOOTER: Final = MappingProxyType(
    {
        "en": _FooterCopy(
            service=(
                "This is a service email about your John Got It account. It is sent even if "
                "you turned off marketing emails."
            ),
            ask_by_email="Questions? Write to {email} or open Help in the app.",
            ask_in_app="Questions? Open Help in the app.",
        ),
        "es": _FooterCopy(
            service=(
                "Este es un correo de servicio sobre tu cuenta de John Got It. Se envía aunque "
                "hayas desactivado los correos de marketing."
            ),
            ask_by_email="¿Preguntas? Escribe a {email} o abre Ayuda en la app.",
            ask_in_app="¿Preguntas? Abre Ayuda en la app.",
        ),
    }
)


def language_of(locale: str) -> str:
    """The locale the layout writes: the user's when it has copy, else English."""
    return locale if locale in FOOTER else DEFAULT_LOCALE


def _footer(locale: str, reason: str | None, sender: SenderIdentity) -> list[str]:
    copy = FOOTER[language_of(locale)]
    ask = (
        copy.ask_by_email.format(email=sender.support_email)
        if sender.support_email
        else copy.ask_in_app
    )
    identity = " · ".join(value for value in (sender.legal_name, sender.mailing_address) if value)
    return [*([reason] if reason else []), copy.service, ask, *([identity] if identity else [])]


def _plain(line: Line) -> str:
    if isinstance(line, str):
        return line
    return "".join(part.text if isinstance(part, Strong) else part for part in line)


def _escaped(line: Line) -> str:
    if isinstance(line, str):
        return html.escape(line)
    return "".join(
        f"<strong>{html.escape(part.text)}</strong>"
        if isinstance(part, Strong)
        else html.escape(part)
        for part in line
    )


def _paragraphs(paragraphs: Sequence[Paragraph], style: str) -> str:
    return "".join(
        f'<p style="{style}">' + "<br>".join(_escaped(line) for line in paragraph) + "</p>"
        for paragraph in paragraphs
    )


def render_email(
    *,
    locale: str,
    subject: str,
    paragraphs: Sequence[Paragraph],
    reason: str | None,
    sender: SenderIdentity,
) -> EmailContent:
    """The email in the layout: `paragraphs` are the body, `reason` the email's own footer line
    (why the user gets it), `sender` the footer's support email and identity."""
    footer = _footer(locale, reason, sender)
    text = "\n\n".join(
        [BRAND, *("\n".join(_plain(line) for line in paragraph) for paragraph in paragraphs)]
    )
    text += "\n\n--\n" + "\n".join(footer) + "\n"
    body_style = "margin:0 0 16px;"
    footer_style = "margin:0 0 8px;"
    document = (
        "<!doctype html>"
        f'<html lang="{language_of(locale)}">'
        '<head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="color-scheme" content="light">'
        f"<title>{html.escape(subject)}</title></head>"
        f'<body style="margin:0;padding:0;background:{_BACKGROUND};">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{_BACKGROUND};">'
        '<tr><td align="center" style="padding:24px 12px;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="max-width:600px;background:{_WHITE};border-radius:12px;">'
        f'<tr><td style="background:{_NAVY};border-radius:12px 12px 0 0;padding:20px 24px;'
        f'font-family:{_FONT};font-size:22px;line-height:28px;font-weight:bold;color:{_GREEN};">'
        f"{BRAND}</td></tr>"
        f'<tr><td style="padding:24px 24px 8px;font-family:{_FONT};font-size:16px;'
        f'line-height:24px;color:{_NAVY};">'
        f"{_paragraphs(paragraphs, body_style)}</td></tr>"
        "</table>"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="max-width:600px;">'
        f'<tr><td style="padding:16px 24px;font-family:{_FONT};font-size:12px;'
        f'line-height:18px;color:{_MUTED};">'
        f"{_paragraphs([(line,) for line in footer], footer_style)}</td></tr>"
        "</table>"
        "</td></tr></table>"
        "</body></html>"
    )
    return EmailContent(subject=subject, text=text, html=document)
