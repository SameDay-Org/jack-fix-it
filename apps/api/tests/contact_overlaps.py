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

# Fix round 5 on #240: what the recovery of cut contacts missed and develop's filter hid
# (Vault R3-B1, Gatekeeper F-B1 and F-B2). Each with the word it showed, and its masked form.
_MARKED_COM: Final = "acme.c" + chr(0x0483) + "om"
FLOOR_CONTACTS: Final = (
    # R3-B1: a URL or an email takes the contact's number or cue and showed the rest.
    (_MARKED_COM + "/1250 Ocean Dr", "Ocean", "•••"),
    (_MARKED_COM + "/insta jdoe1", "jdoe1", "•••"),
    (_MARKED_COM + "/@ bob_smith", "bob_smith", "•••"),
    (_MARKED_COM + "/apt 4B", "4B", "•••"),
    (_MARKED_COM + "@1250 Ocean Dr", "Ocean", "•••"),
    (_MARKED_COM + "/Calle Flagler 742", "Flagler", "•••"),
    (_MARKED_COM + "/8800 SW 72nd", "72nd", "•••"),
    (_MARKED_COM + "/Brickell Ave 1200", "1200", "•••"),
    # F-B1: the street inside a match the phone's mask refused.
    ("786 555 0142, 742 Evergreen Ter arroba gm" + chr(0x0483) + "ail punto com", "Evergreen",
     "•••, •••"),
    ("Unit 4B, 742 Evergreen Ter arroba gm" + chr(0x0483) + "ail punto com", "Evergreen", "•••"),
    # F-B2: the unit the handle beside it made the unit rule refuse.
    ("Unit 4B jdoe1 insta dot c" + chr(0x0483) + "om", "4B", "••• •••"),
)  # fmt: skip
FLOOR_IDS: Final = (
    "url_street",
    "url_platform",
    "url_at_handle",
    "url_unit",
    "email_street",
    "url_spanish_street",
    "url_grid",
    "url_reversed_street",
    "phone_then_street",
    "unit_then_street",
    "unit_then_handle",
)
