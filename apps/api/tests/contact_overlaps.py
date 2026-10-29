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

# A reverse handle or a street whose platform or suffix an email or a URL also reads (Vault
# round 2 on #240): the URL takes "insta" and left "jdoe1", the email takes "Dr" and left
# "1250 Ocean". Each with the word it used to leave.
CUT_CONTACTS: Final = (
    ("jdoe1 insta dot c" + chr(0x0483) + "om", "jdoe1"),
    ("1250 Ocean Dr at gm" + chr(0x0483) + "ail", "Ocean"),
)
CUT_IDS: Final = ("reverse_handle", "street")
