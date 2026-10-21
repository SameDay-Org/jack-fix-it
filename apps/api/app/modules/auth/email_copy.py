"""Copy of the emails auth sends (D4.3, #27), in English and Spanish.

Plain and neutral: no links, no promises. Branded templates come with #92.
"""

from dataclasses import dataclass
from types import MappingProxyType
from typing import Final


@dataclass(frozen=True)
class EmailContent:
    subject: str
    text: str
    html: str


@dataclass(frozen=True)
class _ResetCodeCopy:
    subject: str
    code_line: str  # {code}
    expiry_line: str  # {minutes}
    ignore_line: str


DEFAULT_LOCALE: Final = "en"
PASSWORD_RESET_CODE: Final = MappingProxyType(
    {
        "en": _ResetCodeCopy(
            subject="Your Jack Fix It password reset code",
            code_line="Your password reset code is {code}.",
            expiry_line="It expires in {minutes} minutes and works once.",
            ignore_line="If you did not ask to reset your password, you can ignore this email.",
        ),
        "es": _ResetCodeCopy(
            subject="Tu código para restablecer la contraseña de Jack Fix It",
            code_line="Tu código para restablecer la contraseña es {code}.",
            expiry_line="Vence en {minutes} minutos y se puede usar una sola vez.",
            ignore_line="Si no pediste restablecer tu contraseña, puedes ignorar este correo.",
        ),
    }
)


def password_reset_code_email(locale: str, code: str, ttl_seconds: int) -> EmailContent:
    """The reset code email in the user's locale (English when it has no copy)."""
    copy = PASSWORD_RESET_CODE.get(locale, PASSWORD_RESET_CODE[DEFAULT_LOCALE])
    # Rounded down, so the email never promises more time than the code has.
    minutes = max(1, ttl_seconds // 60)
    code_line = copy.code_line.format(code=code)
    expiry_line = copy.expiry_line.format(minutes=minutes)
    text = f"{code_line}\n\n{expiry_line}\n\n{copy.ignore_line}\n"
    # The code is six digits and the copy is ours, so nothing here needs HTML escaping.
    html = (
        f"<p>{copy.code_line.format(code=f'<strong>{code}</strong>')}</p>"
        f"<p>{expiry_line}</p>"
        f"<p>{copy.ignore_line}</p>"
    )
    return EmailContent(subject=copy.subject, text=text, html=html)
