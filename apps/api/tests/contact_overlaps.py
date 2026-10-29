"""A phone whose last group an email or a domain also reads (#257, Vault round 1 on #240): the
email's mask takes "0142" and leaves six digits, so only the union of both spans hides every
digit. Shared by the redactor's tests and its callers' tests."""

from typing import Final

PHONE_EMAIL_OVERLAPS: Final = (
    "786 555 0142 at gm" + chr(0x0483) + "ail",  # a combining mark inside the provider
    "786 555 0142 arroba gm" + chr(0x093F) + "ail",  # a spacing mark (Mc) inside the provider
    "786 555 0142@mañana.es",  # a Unicode domain
    "305 555 0199 at gmail",  # the ASCII report
)
OVERLAP_IDS: Final = ("marked_provider", "spacing_mark_provider", "unicode_domain", "ascii")
