"""Copy of the emails auth sends (D4.3, #27), in English and Spanish, in the branded layout
(app.email_layout, #92).

Plain and neutral: no links, no promises.
"""

from dataclasses import dataclass
from types import MappingProxyType
from typing import Final

from app.email_layout import EmailContent, SenderIdentity, render_email, with_strong


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


def password_reset_code_email(
    locale: str, code: str, ttl_seconds: int, *, sender: SenderIdentity
) -> EmailContent:
    """The reset code email in the user's locale (English when it has no copy)."""
    language = locale if locale in PASSWORD_RESET_CODE else DEFAULT_LOCALE
    copy = PASSWORD_RESET_CODE[language]
    # Rounded down, so the email never promises more time than the code has.
    minutes = max(1, ttl_seconds // 60)
    return render_email(
        locale=language,
        subject=copy.subject,
        paragraphs=[
            (with_strong(copy.code_line, "code", code),),
            (copy.expiry_line.format(minutes=minutes),),
            (copy.ignore_line,),
        ],
        reason=None,  # the ignore line says it
        sender=sender,
    )
