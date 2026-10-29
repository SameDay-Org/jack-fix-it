"""The contact redactor (app/redaction.py, #172 now, chat #72 later): a table-driven corpus.

POSITIVE: each input must lose the listed secrets (and be flagged). NEGATIVE: each input must
come back unchanged (and not flagged). The module docstring lists the known gaps on purpose.
"""

import random
import sys
import unicodedata
from typing import Literal

import pytest

from app.redaction import (
    _MARK_RANGES,
    MASK,
    KnownValues,
    RedactionResult,
    redact_contacts,
    redact_known,
    redact_text,
)
from tests.glue_variants import all_glue_cases
from tests.helpers import best_seconds_without_gc

POSITIVE: list[tuple[str, list[str]]] = [
    # Emails: plain, spaced, spelled out (EN and ES), bracketed.
    ("Email me at jane.doe+repairs@gmail.com please", ["jane.doe", "gmail.com"]),
    ("JOHN.SMITH@Company.Travel", ["JOHN.SMITH", "Company.Travel"]),
    ("write to bob @ yahoo . com", ["bob", "yahoo"]),
    ("my email is maria at gmail dot com", ["maria at gmail", "dot com"]),
    ("jane (at) outlook.com", ["jane", "outlook.com"]),
    ("pedro [at] hotmail [dot] com", ["pedro", "hotmail"]),
    ("escríbeme a luis arroba gmail punto com", ["luis arroba", "punto com"]),
    # Phones: US formats, +1, split digits, spelled out, glued to words, next to numbers.
    ("call (305) 555-0199 after work", ["305", "555-0199"]),
    ("text 305.555.0199", ["305.555.0199"]),
    ("cel 305 555 0199", ["305 555 0199"]),
    ("my number 3055550199", ["3055550199"]),
    ("+1 305 555 0199", ["305 555 0199"]),
    ("1-305-555-0199", ["305-555-0199"]),
    ("3 0 5 5 5 5 0 1 9 9 is my cell", ["3 0 5 5 5 5 0 1 9 9"]),
    ("call5555550199 now", ["5555550199"]),
    ("Call (305) 555-0199. 3 bedrooms upstairs", ["305", "555-0199"]),
    ("three oh five five five five zero one nine nine", ["three oh five"]),
    ("mi cel es tres cero cinco cinco cinco cinco cero uno nueve nueve", ["tres cero cinco"]),
    ("+52 55 1234 5678 (Mexico)", ["1234 5678"]),
    # URLs, domains, WhatsApp links.
    ("see https://myplumbing.example/contact?x=1", ["myplumbing", "contact"]),
    ("www.bobsrepairs.com has my number", ["bobsrepairs"]),
    ("bobsrepairs.com/contact", ["bobsrepairs"]),
    ("whatsapp me: wa.me/13055550199", ["wa.me", "3055550199"]),
    # Handles.
    ("follow @jane_fixes", ["@jane_fixes"]),
    ("IG: jane.doe99", ["jane.doe99"]),
    ("my insta is jdoe_77", ["jdoe_77"]),
    ("whatsapp 3055550199", ["3055550199"]),
    # Addresses: US, units, PO boxes, Spanish forms.
    ("repair the sink at 742 Evergreen Terrace, Apt 4.", ["742 Evergreen", "Apt 4"]),
    ("I live at 1200 Brickell Ave #3301", ["1200 Brickell", "3301"]),
    ("8800 SW 72nd St, Miami", ["8800 SW 72nd"]),
    ("15 NE 3rd Ave Unit 12B", ["15 NE 3rd", "12B"]),
    ("123 main st", ["123 main"]),
    ("742 O\u2019Neil St", ["742 O\u2019Neil"]),
    ("mail it to PO Box 1234", ["Box 1234"]),
    ("vivo en la Calle 8 #123", ["Calle 8", "123"]),
    ("Avenida de las Americas 100, apto", ["Americas 100"]),
    ("742 Avenida Brickell", ["742 Avenida"]),
    # Mixed EN/ES, with an invisible character hiding a phone.
    ("La fuga es en el baño, llámame al 305-555-0199 o jane@x.co", ["305-555-0199", "jane@"]),
    ("call 305\u200b555\u200b0199", ["305", "0199"]),
    # Found by the adversarial sweep (round 1): phones next to a platform word, odd dashes and
    # separators, international and Latin American forms.
    ("escríbeme al whatsapp 305 555 0199", ["305", "555 0199"]),
    ("WhatsApp 786-555-0199", ["786", "555-0199"]),
    ("1305-555-0199", ["1305", "555-0199"]),
    ("call 305\u2013555\u20130199", ["305", "0199"]),
    ("call me 305/555/0199", ["305/555"]),
    ("call [305] 555-0199", ["305", "555-0199"]),
    ("call 305\u00ad555\u00ad0199", ["305", "0199"]),
    ("$3055550199", ["3055550199"]),
    ("Llamar al 786 55 50 199 por favor", ["786", "50 199"]),
    ("0412-1234567", ["1234567"]),
    ("53 5 1234567", ["1234567"]),
    ("call 011 52 55 1234 5678", ["1234 5678"]),
    ("my mom in Mexico 55 1234 5678", ["1234 5678"]),
    # Emails and links typed loosely.
    ("jdoe @ gmail dot com", ["jdoe"]),
    ("my email is juanperez at gmail, text me", ["juanperez"]),
    ("email me jdoe@gmail", ["jdoe"]),
    ("jdoe@gmail,com", ["jdoe"]),
    ("my email is juan dot perez at gmail dot com", ["juan", "perez"]),
    ("email josé.pérez@gmail.com", ["josé", "pérez"]),
    ("jdoe<at>gmail.com", ["jdoe"]),
    ("jdoe at company.miami", ["jdoe", "company"]),
    ("my links: linktr.ee/jdoe", ["linktr", "jdoe"]),
    ("youtu.be/abc123", ["youtu", "abc123"]),
    ("myroofing.miami", ["myroofing"]),
    ("my site jdoe dot com", ["jdoe"]),
    # Handles with linking words, separators and payment apps.
    ("my instagram handle is jdoe", ["jdoe"]),
    ("búscame en instagram como jdoe", ["jdoe"]),
    ("find me on IG name99", ["name99"]),
    ("IG handle: jdoe", ["jdoe"]),
    ("Instagram - jdoe", ["jdoe"]),
    ("My snap is juanfix305, roof tiles missing", ["juanfix305"]),
    ("my cashapp is $jdoe-99", ["jdoe"]),
    ("whatsapp me at jdoe99", ["jdoe99"]),
    # Handle sigils in fullwidth or small form, and handles that start with an exempt word
    # (#224 review): "@home" is a place, "@home.fixit" is an account.
    ("pay \uff04testperson please", ["testperson"]),  # FULLWIDTH DOLLAR SIGN
    ("cashapp \ufe69jdoe", ["jdoe"]),  # SMALL DOLLAR SIGN
    ("insta \uff20jdoe", ["jdoe"]),  # FULLWIDTH COMMERCIAL AT
    ("find me @home.fixit", ["home.fixit"]),
    ("find me @home_fixit", ["home_fixit"]),
    ("find me @home-fixit", ["home-fixit"]),
    ("find me @work.fixit305", ["work.fixit305"]),
    ("find me @5pm.fixit", ["5pm.fixit"]),
    # Addresses in South Florida forms.
    ("I'm at 2000 Ponce de Leon Blvd, Coral Gables", ["2000 Ponce", "Leon Blvd"]),
    ("200 E Las Olas Blvd", ["200 E", "Las Olas"]),
    ("Roof leak at 100 Isle of Palms Ct, 33139", ["100 Isle", "Palms Ct"]),
    ("12000 Dr Martin Luther King Jr Blvd", ["12000", "Luther King"]),
    ("Av. Brickell 1200", ["Brickell 1200"]),
    ("Brickell Avenue 1200", ["Brickell Avenue"]),
    ("Vivo en Kendall Dr 12000, casa 4", ["Kendall Dr", "12000"]),
    ("en el 1500 de la Calle Ocho", ["1500", "Calle Ocho"]),
    ("Estoy en el 1500 de la Collins Ave, apto 12B.", ["1500", "Collins", "12B"]),
    ("calle 8 numero 1500", ["1500"]),
    ("1000 Via de la Paz", ["1000 Via"]),
    ("I live at 8800 SW 72nd", ["8800 SW"]),
    ("12000 US-1", ["12000 US"]),
    ("1500-A Main St", ["1500-A"]),
    ("Edificio Icon, apto 4512", ["4512"]),
    ("unit 5B", ["5B"]),
    # The Vault's canaries (#172 review).
    (
        "privacy-canary@example.invalid; call +15555550199; repair the sink at "
        "742 Evergreen Terrace, Apt 4.",
        ["privacy-canary", "example.invalid", "+15555550199", "5555550199", "742 Evergreen"],
    ),
]

NEGATIVE: list[str] = [
    "3 bedrooms",
    "2nd floor",
    "$150",
    "ZIP 33301",
    "ZIP 33301-1234",
    "built in 1998",
    "10 ft",
    "room 12x14",
    "call me after 5pm",
    "need it by 10/24",
    "between 2015 and 2020",
    "a 3 way switch",
    "fix 2 doors on the way out",
    "about 5.5 ft, e.g. the hall",
    "the sink leaks.So I called",
    "50 gallon water heater, 240V, 4500 W elements",
    "Carrier 24ACC636A003 3 ton 16 SEER",
    "$1,500.00 budget",
    "10:30 AM on 2026-10-24",
    "meet at the Home Depot",
    "AT&T box is outside",
    "2 baños, el patio de 10 metros",
    "la calle está inundada",
    # Found by the adversarial sweep (round 1): trade shorthand, quantities and everyday words.
    "3 bed 2 bath 1500 sq ft",
    "It's a 3 bedroom 2 bath house about 1800 sq ft",
    "Need 300 sq ft St Augustine sod laid in the backyard, ZIP 33186.",
    "6 inch rd duct",
    "20 amp cir breaker",
    "4 inch dr line clogged",
    "Samsung 28 cu ft 4 dr fridge leaking water, model RF28R7351SR.",
    "Install 2 Leviton 3 way switches",
    "need 2 packs 100 ct screws",
    "Install 1 Denon AV receiver and mount 2 TVs",
    "Can you come at 3 pm plz? Need 2 outlets replaced.",
    "I'm a 20 minute drive from Doral",
    "We moved into this 40 year old place",
    "Cut a 12 inch circle in the drywall",
    "Need it done by 10 am either way",
    "10 ft terrace",
    "We are 2 blocks off Bird Rd, the AC is a 2018 Trane 2.5 ton.",
    "come @5pm please",
    "I'm @home all day after 3",
    "I'm @home. Call first",
    "I'm @home! Come by",
    "I'm @work today, @casa tomorrow",
    "be there @5.30",
    "takes @2.5 hrs",
    "free @5 a.m. tomorrow",
    "10 pcs @1.5 each",
    "meet @12.3",
    "saw your ad on facebook last week",
    "te mando fotos por whatsapp mañana",
    "Send me a WhatsApp with the price",
    "whatsapp is fine",
    "the AC is not cooling.Me and my wife are hot",
    "model WH12345678901 water heater",
    "Amazon order 112-1234567-1234567",
    "la calle tiene 2 huecos",
    "El agua sale hacia la calle desde hace 3 dias",
    "The master suite 2 sinks are clogged",
    "Charleston, SC 29401",
    (
        "The AC in the 2nd floor bedroom stopped cooling last week. It is a 3 ton unit from "
        "2012, about 1,200 sq ft. I can be home after 5pm on 10/24. Budget around $300."
    ),
]

# Found by the adversarial sweep (round 2).
POSITIVE += [
    ("AC stopped cooling, condo at 1200 West Ave, Miami Beach.", ["1200 West"]),
    ("Roof leak at 3400 Day Ave in the Grove", ["3400 Day"]),
    ("We are at 2210 Heron Cove, Weston", ["2210 Heron"]),
    ("house is 1750 Eagle Run in Coral Springs", ["1750 Eagle"]),
    ("my gmail is juan.perez77 if you need it", ["juan.perez77"]),
    ("Mi correo: juanperez77 (gmail), para la factura", ["juanperez77"]),
    ("mi correo es juanperez en gmail", ["juanperez"]),
    ("my email is jdoe at comcast, the outlet sparks", ["jdoe"]),
    ("Our site is BestPoolsMiami.Com, see the photos", ["BestPoolsMiami"]),
    ("visit my site Jdoefix.Com for photos", ["Jdoefix"]),
    ("Our website is miamiroofing.company", ["miamiroofing"]),
    ("See jdoeroofing . com for reference photos", ["jdoeroofing"]),
    ("DM me @ jdoe_fixes for the photos", ["jdoe_fixes"]),
    ("Pay me back at @Juan-Perez-12", ["Juan-Perez-12", "Perez"]),
    ("búscame en el face como Juan.Perez99", ["Juan.Perez99"]),
    ("Escríbeme al wasap jdoe99", ["jdoe99"]),
    ("my IG account jdoe_99", ["jdoe_99"]),
    ("my ig is: jdoe99", ["jdoe99"]),
    ("mi instagram se llama jdoe99", ["jdoe99"]),
    ("reach me at j.doe.fixit (insta)", ["j.doe.fixit"]),
    ("CELL3055550199 any time after 5pm", ["3055550199"]),
    ("call 305_555_0199 for the gate", ["305_555"]),
    ("call 305*555*0199 please", ["305*555"]),
    ("call 305" + chr(0x1F525) + "555" + chr(0x1F525) + "0199", ["305", "0199"]),
    ("cel " + "".join(d + chr(0xFE0F) + chr(0x20E3) for d in "3055550199"), ["3", "9"]),
    ("email jdoe" + chr(0xFF20) + "gmail.com", ["jdoe"]),
    ("jane@gm" + chr(0x0430) + "il.com", ["jane"]),
    ("j a n e @ g m a i l . c o m", ["j a n e"]),
    ("mi cel 0414-123.45.67", ["123.45.67"]),
    ("call 305-555-0199-2024 evening", ["555-0199"]),
    ("I live at 1200 Brickell Av, apt 5", ["1200 Brickell"]),
    ("Ave. Brickell 1200", ["Brickell 1200"]),
    ("vivo en Collins Ave Nº 1200", ["Collins Ave", "1200"]),
    ("8800 N.W. 72nd", ["8800"]),
    ("mail it to PO Box #1234", ["1234"]),
    ("Apartado Postal 1234", ["1234"]),
]

# Round 3 review (#172): ordinary formats that slipped through.
POSITIVE += [
    ("Call 305-555-0199 in the afternoon about the sink.", ["305-555-0199", "0199"]),
    ("+1 305 555 0199 in the morning", ["305 555 0199"]),
    ("3055550199 in advance", ["3055550199"]),
    ("Email _jane@example.com about the leak.", ["_jane", "example.com"]),
    ("__x@y.co", ["__x"]),
    ("+tag@example.com", ["+tag", "example.com"]),
    ("The leaking kitchen sink is at 2000 ocean drive.", ["2000 ocean"]),
    ("My address is 45 ocean drive.", ["45 ocean"]),
    ("12 nw 3rd st", ["12 nw"]),
]

# Phrases masked on purpose although they are not addresses: a house number, one to three words
# and a street suffix is always treated as an address (round 3 review: case and year-like
# numbers must never authorize exposure). Hiding a few words is the safe side.
KNOWN_FALSE_POSITIVES: list[str] = [
    "2 new drive belts",
    "Replace 10 basketball court lights, 400W each.",
    "Replace 12 new drive belts on the 2 attic fans.",
]

NEGATIVE += [
    "12 in",
    "3.5 in",
    "10 in x 12 in",
    "2x4 8 ft",
    "built in 2000",
    "2000 sq ft",
    "in 1998 we",
    "Need 2 Hunter ceiling fans installed. Way too hot upstairs with 9 ft ceilings.",
    "I got 3 quotes already. Dr. Perez next door recommended you for the roof.",
    "Install 3 LED pendant lights over the kitchen island, 12'x14' kitchen.",
    "Pool pump is a Pentair IntelliFlo 3 HP. Pool pH 7.8, chlorine 3 ppm.",
    "Install 1 Denon AV 7.2 receiver in the living room",
    "Found you via Thumbtack 2 weeks ago, need the 200 amp panel replaced.",
    "I can send 100 via Zelle today for the deposit.",
    "Estoy a 2 cuadras de la Calle 8, cerca del parque.",
    "The wifi signal is weak in the back bedroom",
    "The pipe threads: 1.5 inch, galvanized, leaking at the joint.",
    "I got quotes 450/600/1200 for the same AC job, 3.5 ton R-410A.",
    "We are building 1 more closet in the garage, need 2 outlets.",
    "The AC unit 2 is not cooling, unit 1 is fine.",
    "Unit 2 AC and Unit 3 AC",
    "Home Depot order#12345678 has the vanity",
    "The leak is at home.Me and my wife can't sleep.",
    "Photos are at iCloud, I can share the link.",
    "Need 6 boards 2x4@8ft cut for the fence.",
    "Can you come @tomorrow? The pool pump is off.",
    "Do you accept Zelle as payment?",
    "Venmo is easiest for me",
    "I saw your ad on Facebook/Instagram",
    "Contact me by WhatsApp/text, either works",
    "I can pay Zelle $150 deposit today",
    "I bought it at Amazon last week",
    "I work at Yahoo as an engineer",
    "the router is at 192.168.1.100",
    "Quotes I got: 450.00 / 650.00",
    "I have 100 / 200 / 1500 sq ft rooms",
    "need 1/2 3/4 1/4 3/8 5/8 fittings",
    "I need 2 trees removed near the main road",
    "There are 2 big potholes on our private road",
    "Calle 8 está cerrada por obras",
    "mi casa está en la calle 8 cerca de la avenida 27",
    "Mount TV and AV 4K receiver",
    "The unit 3 times a day shuts off",
    "master suite 2 closets need doors",
    "apartamento 3 habitaciones",
    "Part# 12345 is broken",
    "2 faucets@150 each",
    "Replace 40 W 2nd floor bulbs",
    "it costs 50 $USD",
    "1º piso, 2 baños",
    "We are near Bird Rd 33155",
    "Kendall Dr 33176 area",
    "ft" + chr(0x00B2) + " of tile: 120",
]


def test_superscript_and_circled_digits_are_folded() -> None:
    # Superscript digits 0-9 and circled digits 0-9, by code point.
    superscript = (0x2070, 0x00B9, 0x00B2, 0x00B3, *range(0x2074, 0x207A))
    circled = (0x24EA, *range(0x2460, 0x2469))
    phone = "3055550199"

    for table in (superscript, circled):
        text = "call " + "".join(chr(table[int(digit)]) for digit in phone)
        assert redact_contacts(text).text == f"call {MASK}", text


def test_a_lone_superscript_stays_as_typed() -> None:
    text = "120 ft" + chr(0x00B2) + " of tile"

    assert redact_contacts(text).text == text


@pytest.mark.parametrize(
    ("sigil", "ascii_sigil"),
    [("\uff04", "$"), ("\ufe69", "$"), ("\uff20", "@"), ("\ufe6b", "@")],
    ids=["fullwidth_dollar", "small_dollar", "fullwidth_at", "small_at"],
)
def test_handle_sigils_fold_to_ascii_and_are_redacted(sigil: str, ascii_sigil: str) -> None:
    folded = redact_contacts(f"reach me at {ascii_sigil}testperson")
    exotic = redact_contacts(f"reach me at {sigil}testperson")

    assert folded.redacted is True
    assert exotic == folded == RedactionResult(f"reach me at {MASK}", True)


@pytest.mark.parametrize("word", ["home", "work", "casa", "noon", "tomorrow", "5pm"])
def test_an_exempt_word_is_only_exempt_as_a_whole_token(word: str) -> None:
    for whole in (f"@{word}", f"@{word}.", f"@{word}!", f"@{word} ", f"I'm @{word}, ok"):
        assert redact_contacts(whole) == RedactionResult(whole, False), whole
    overlay = chr(0x0335)  # a combining mark glued to the word
    for handle in (
        f"@{word}.fixit",
        f"@{word}_fixit",
        f"@{word}-fixit",
        f"@{word}.fix.it",
        f"@{word}--fixit",
        f"@{word}..fixit",
        f"@{word}._fixit",
        f"@{word}{overlay}fixit",
    ):
        result = redact_contacts(handle)
        assert result.redacted is True, handle
        assert f"@{word}" not in result.text, handle


# Every compatibility form of a handle separator reaches the handle pattern (#224 round 2):
# the fullwidth and presentation-form low lines (NFKC "_"), the dot leaders and the ellipsis
# (NFKC ".", "..", "..."), the hyphen and the superscript minus (dashes).
SEPARATOR_FORMS = [
    ("--", "two_dashes"),
    ("..", "two_dots"),
    ("._", "dot_underscore"),
    (chr(0xFF3F), "fullwidth_low_line"),
    (chr(0xFE4D), "dashed_low_line"),
    (chr(0xFE33), "vertical_low_line"),
    (chr(0xFE4F), "wavy_low_line"),
    (chr(0x2010), "hyphen"),
    (chr(0x2024), "one_dot_leader"),
    (chr(0x2025), "two_dot_leader"),
    (chr(0x2026), "ellipsis"),
    (chr(0xFE19), "vertical_ellipsis"),
    (chr(0x207B), "superscript_minus"),
]


@pytest.mark.parametrize(
    "separator", [form for form, _ in SEPARATOR_FORMS], ids=[name for _, name in SEPARATOR_FORMS]
)
def test_an_exempt_word_joined_to_more_by_any_separator_form_is_a_handle(separator: str) -> None:
    handle = f"@home{separator}x"

    assert redact_contacts(handle) == RedactionResult(MASK, True), ascii(handle)
    assert redact_contacts(f"find me {handle} today") == RedactionResult(
        f"find me {MASK} today", True
    ), ascii(handle)


# The typed forms, not ASCII ones: "jack..fixit.com", "see_gmail.com" and "jdoe@.gmail.com"
# are known gaps of the email and domain patterns (U+2024 already folds to "." in _clean).
BOUNDARY_FORMS = [(form, name) for form, name in SEPARATOR_FORMS if not form.isascii()]
BOUNDARY_FORMS.remove((chr(0x2024), "one_dot_leader"))


@pytest.mark.parametrize(
    "separator", [form for form, _ in BOUNDARY_FORMS], ids=[name for _, name in BOUNDARY_FORMS]
)
def test_a_separator_form_next_to_a_contact_keeps_its_boundary(separator: str) -> None:
    """The low lines and the dot leaders are not folded for every pattern: as typed they keep
    the boundary before a domain or a handle, as ASCII they would fall into the known gaps."""
    for text in (f"jack{separator}fixit.com", f"jdoe@{separator}gmail.com", f"x{separator}@jdoe"):
        result = redact_contacts(text)
        assert result.redacted is True, ascii(text)
        for contact in ("fixit.com", "gmail.com", "@jdoe"):
            assert contact not in result.text, ascii(text)


# Every combining mark continues the token (#229, the #224 round-3 reviews): the five Latin
# and generic blocks of the round-1 fix left a Cyrillic, Hebrew, Arabic, Thai, Devanagari,
# ideographic or musical mark as a boundary, so "@home" + U+0483 + "fixit" read as "@home".
# Me marks are dropped by _clean, so only Mn and Mc are probed.
COMBINING_MARKS = [
    (chr(0x0335), "latin_short_stroke"),  # the #224 probe, inside the old ranges
    (chr(0x0483), "cyrillic_titlo"),
    (chr(0x05B0), "hebrew_sheva"),
    (chr(0x0610), "arabic_sign"),
    (chr(0x0E31), "thai_mai_han_akat"),
    (chr(0x093F), "devanagari_vowel_sign_i_mc"),
    (chr(0x302A), "ideographic_level_tone"),
    (chr(0x1D167), "musical_tremolo"),
]
MARKS = [mark for mark, _ in COMBINING_MARKS]
MARK_IDS = [name for _, name in COMBINING_MARKS]
# Every exempt token shape of AT_HANDLE, in ASCII (the handle body is ASCII, so "@mañana" +
# a mark is detected but masked up to the "ñ": a known gap of the body, not of the marks).
EXEMPT_WORDS = [
    "home", "work", "casa", "noon", "night", "today", "tomorrow", "tonight", "manana", "5pm", "6ft"
]  # fmt: skip


@pytest.mark.parametrize("word", EXEMPT_WORDS)
@pytest.mark.parametrize("mark", MARKS, ids=MARK_IDS)
def test_exempt_word_glued_to_any_combining_mark_is_a_handle(mark: str, word: str) -> None:
    handle = f"@{word}{mark}fixit"

    assert redact_contacts(handle) == RedactionResult(MASK, True), ascii(handle)
    assert redact_contacts(f"find me {handle} today") == RedactionResult(
        f"find me {MASK} today", True
    ), ascii(handle)


def test_mark_set_matches_unicodedata() -> None:
    """_MARK_RANGES is a generated constant (a scan of every code point at import costs about
    180 ms): the Mn and Mc ranges of this Python's unicodedata. A Python with a newer Unicode
    fails here; paste the ranges from the message into redaction.py and update its comment."""
    expected: list[tuple[int, int]] = []
    low: int | None = None
    for code in range(sys.maxunicode + 1):
        if unicodedata.category(chr(code)) in ("Mn", "Mc"):
            if low is None:
                low = code
        elif low is not None:
            expected.append((low, code - 1))
            low = None

    assert tuple(expected) == _MARK_RANGES, (
        f"regenerate _MARK_RANGES for Unicode {unicodedata.unidata_version}: "
        + ", ".join(f"(0x{lo:04X}, 0x{hi:04X})" for lo, hi in expected)
    )


@pytest.mark.parametrize("mark", MARKS, ids=MARK_IDS)
def test_non_exempt_handle_with_mark_masked_whole(mark: str) -> None:
    """The mark and what follows it belong to the handle: no readable piece of it is left
    ("@bob" + U+05B0 + "smith" used to come back as the mask followed by "smith")."""
    for handle in (
        f"@bob{mark}smith",
        f"@bob{mark}{mark}smith",
        f"@b{mark}o{mark}b",
        f"@bobsmith{mark}",
        f"@bob{mark}.smith",
    ):
        assert redact_contacts(handle) == RedactionResult(MASK, True), ascii(handle)
        assert redact_contacts(f"ping {handle} now") == RedactionResult(f"ping {MASK} now", True), (
            ascii(handle)
        )


ACCENTED_WORDS = [
    "café",
    "mañana",
    "João",
    "Ñandú",
    "crème brûlée",
    "नमस्ते",  # Devanagari, with a virama and a vowel sign
    "مَرْحَبًا",  # Arabic, with harakat
    "שָלוֹם",  # Hebrew, with points
    "สวัสดี",  # Thai, with U+0E31 and U+0E35
]


@pytest.mark.parametrize("form", ["NFC", "NFD"])
@pytest.mark.parametrize("word", ACCENTED_WORDS, ids=[ascii(w) for w in ACCENTED_WORDS])
def test_accented_words_untouched(word: str, form: Literal["NFC", "NFD"]) -> None:
    """Marks on ordinary words, composed or decomposed, with and without "@home" next to them.
    The output is the NFC form of the input (_clean normalizes) and nothing is masked."""
    for text in (f"Fix the {word} sink", f"{word} @home by {word}", f"@home, {word}!"):
        typed = unicodedata.normalize(form, text)

        result = redact_contacts(typed)

        assert result == RedactionResult(unicodedata.normalize("NFC", typed), False), ascii(typed)


# Review of #229: a spacing mark (Mc) is kept by _clean after a separator or the "@" (an Mn
# there is dropped), so those positions continue the token too.
SPACING_MARKS = [
    (chr(0x093F), "devanagari_vowel_sign_i"),
    (chr(0x0903), "devanagari_visarga"),
    (chr(0x0BBE), "tamil_vowel_sign_aa"),
    (chr(0x1D16D), "musical_combining_augmentation_dot"),
]


@pytest.mark.parametrize(
    "mark", [mark for mark, _ in SPACING_MARKS], ids=[name for _, name in SPACING_MARKS]
)
def test_spacing_mark_after_a_separator_or_the_at_sign_is_part_of_the_handle(mark: str) -> None:
    for handle in (
        f"@home.{mark}fixit",
        f"@home-{mark}fixit",
        f"@home..{mark}fixit",
        f"@5.{mark}fixit",
        f"@{mark}bobsmith",
        f"@{mark}home.fixit",
        f"@{mark}home{mark}fixit",
    ):
        assert redact_contacts(handle) == RedactionResult(MASK, True), ascii(handle)
        assert redact_contacts(f"find me {handle} today") == RedactionResult(
            f"find me {MASK} today", True
        ), ascii(handle)
    for whole in (f"@{mark}home", f"@{mark}5pm", f"@{mark}", f"@{mark} home"):
        assert redact_contacts(whole) == RedactionResult(whole, False), ascii(whole)


def test_spaced_handle_with_a_mark_is_masked() -> None:
    """The spaced form "@ bob.smith" keeps its parity with the glued one when a mark sits in
    the id."""
    for text in ("@ bob" + chr(0x0483) + ".smith", "@ bob." + chr(0x093F) + "smith"):
        assert redact_contacts(text) == RedactionResult(MASK, True), ascii(text)
    assert redact_contacts("@ home" + chr(0x0483)) == RedactionResult("@ home" + chr(0x0483), False)


@pytest.mark.parametrize("prefix", ["APT", "UNIT", "SUITE", "STE", "PO BOX"])
def test_a_phone_glued_to_a_unit_marker_is_masked(prefix: str) -> None:
    # Standalone, as a label is: inside a sentence the unit step leaves "unit 2 is not cooling"
    # alone, and a phone glued to a unit marker there is a documented gap of the phone step.
    assert redact_contacts(f"{prefix}3055550199") == RedactionResult(MASK, True)
    assert redact_contacts(f"{prefix} 3055550199") == RedactionResult(f"{prefix} {MASK}", True)


@pytest.mark.parametrize(("text", "secrets"), POSITIVE, ids=[t[:40] for t, _ in POSITIVE])
def test_contacts_are_masked(text: str, secrets: list[str]) -> None:
    result = redact_contacts(text)

    assert result.redacted is True
    assert MASK in result.text
    for secret in secrets:
        assert secret not in result.text, secret


@pytest.mark.parametrize("text", NEGATIVE, ids=[t[:40] for t in NEGATIVE])
def test_ordinary_repair_text_is_unchanged(text: str) -> None:
    result = redact_contacts(text)

    assert result.text == text
    assert result.redacted is False


def test_the_corpus_is_large_enough() -> None:
    assert len(POSITIVE) >= 25
    assert len(NEGATIVE) >= 15


def test_only_the_contact_is_masked_and_the_rest_stays_readable() -> None:
    result = redact_contacts("Kitchen sink leaks, call 305-555-0199 after 5pm. 2nd floor.")

    assert result.text == f"Kitchen sink leaks, call {MASK} after 5pm. 2nd floor."


def test_redacting_twice_changes_nothing_more() -> None:
    once = redact_contacts(POSITIVE[-1][0])
    twice = redact_contacts(once.text)

    assert twice.text == once.text
    assert twice.redacted is False


@pytest.mark.parametrize("text", KNOWN_FALSE_POSITIVES)
def test_known_false_positives_stay_masked(text: str) -> None:
    assert redact_contacts(text).redacted is True


# The known-value pass: the customer's own details, whatever the formatting.
KNOWN = KnownValues(
    emails=("Jane.Doe77@Example.com",),
    phones=("+13055550199",),
    streets=("742 Evergreen Terrace", "Apt 4B"),
)


@pytest.mark.parametrize(
    "text",
    [
        "call (305)555 0199",
        "call 305..555..0199",
        "call 305 - 555 - 01 99",
        "call +1 305/555/0199",
        "call 3 0 5 5 5 5 0 1 9 9",
        "call 001 305 555 0199",
        "call 1-305-5550199",
        "write JANE.DOE77@EXAMPLE.COM",
        "write jane.doe77 at example dot com",
        "my handle is jane.doe77",
        "come to 742 evergreen",
        "come to 742 Evergreen Ter",
        "come to Evergreen Terrace 742",
        "apt 4-b, upstairs",
    ],
)
def test_known_values_are_masked_in_any_format(text: str) -> None:
    result = redact_known(text, KNOWN)

    assert result.redacted is True
    for secret in ("0199", "01 99", "jane", "evergreen", "742", "4-b"):
        assert secret not in result.text.lower(), secret


# Round 4 review (#172): the known street parsed into its parts. The house number and the
# first name word are required; directions, the suffix and further name words are optional,
# in any form and anywhere around them.
KNOWN_STREETS = {
    "123 Main Street NW": [
        "at 123 main nw.",
        "123 main",
        "123 Main St",
        "123 nw main st",
        "123 main street northwest",
        "123 N.W. Main",
        "Main St NW 123",
        "123, main",
    ],
    "742 Evergreen Terrace Apt 4B": [
        "at 742 evergreen.",
        "742 Evergreen Ter.",
        "742 evergreen terrace apt 4b",
        "742 EVERGREEN TERR",
        "Evergreen 742",
    ],
    "45 Martin Luther King Jr Blvd": [
        "45 martin",
        "45 martin luther king",
        "45 Martin Luther King Jr Boulevard",
        "martin luther king 45",
    ],
    "123 1/2 N Ocean Dr": ["123 1/2 n ocean dr", "123 ocean", "123 n. ocean drive"],
}
STREET_CASES = [(line, text) for line, texts in KNOWN_STREETS.items() for text in texts]


@pytest.mark.parametrize(("line", "text"), STREET_CASES)
def test_a_known_street_is_masked_without_its_trailing_parts(line: str, text: str) -> None:
    number, name = line.split()[0], ("main", "evergreen", "martin", "ocean")
    result = redact_known(text, KnownValues(streets=(line,)))

    assert result.redacted is True
    lowered = result.text.lower()
    assert number not in lowered
    assert not any(word in lowered for word in name), result.text


@pytest.mark.parametrize(
    ("line", "text"),
    [
        ("123 Main Street NW", "the main water line"),
        ("123 Main Street NW", "123 mainly"),
        ("123 Main Street NW", "1123 main"),
        ("123 Main Street NW", "Main Street NW"),
        ("742 Evergreen Terrace Apt 4B", "evergreen trees"),
        ("742 Evergreen Terrace Apt 4B", "742 sq ft"),
        ("742 Evergreen Terrace Apt 4B", "742 evergreens"),
        ("123 1/2 N Ocean Dr", "ocean drive"),
        # Other words between the number and the name: a quantity, not the street.
        ("742 Evergreen Terrace Apt 4B", "Plant 742 small evergreen shrubs"),
        ("123 Main Street NW", "Fix 123 broken main valves"),
    ],
)
def test_a_known_street_needs_its_number_and_its_name(line: str, text: str) -> None:
    assert redact_known(text, KnownValues(streets=(line,))) == RedactionResult(text, False)


# Each part found anywhere in the stored line (adversarial review of round 5): units and
# building names before the number, dotted directions, house letters, punctuation, and name
# words with a period, an apostrophe or an accent. "{M}" stands for the mask.
CURLY = chr(0x2019)
PARSED_STREETS = [
    (
        "Apt 4B, 742 Evergreen Terrace",
        "Leak at 742 Evergreen, ring twice",
        "Leak at {M}, ring twice",
    ),
    ("Apt 4B, 742 Evergreen Terrace", "ring apt 4b", "ring {M}"),
    (
        "Unit 5, 1200 Brickell Ave",
        "desk at 1200 Brickell will let you up",
        "desk at {M} will let you up",
    ),
    ("Lot 12, 4500 Tamiami Trl", "trailer at 4500 Tamiami", "trailer at {M}"),
    ("Suite 300 - 9100 S Dadeland Blvd", "office at 9100 Dadeland", "office at {M}"),
    ("#12 450 Ocean Dr", "Parking behind 450 Ocean", "Parking behind {M}"),
    ("Brickell Tower 1200 Brickell Ave", "Front desk at 1200 Brickell", "Front desk at {M}"),
    ("#742 Evergreen Ter", "house at 742 Evergreen", "house at {M}"),
    ("Evergreen Ter 742", "Evergreen Ter 742", "{M}"),
    ("100 S.E. Ocean Blvd", "house is 100 Ocean, blue door", "house is {M}, blue door"),
    ("100 S.E. Ocean Blvd", "house is 100 S.E. Ocean Blvd", "house is {M}"),
    ("100 N.W. 5th Ave", "house is 100 NW 5th, blue door", "house is {M}, blue door"),
    ("123A Main St", "the house is 123 A Main", "the house is {M}"),
    ("123A Main St", "the house is 123-A Main", "the house is {M}"),
    ("123-A Main St", "the house is 123A Main", "the house is {M}"),
    ("12-14 Main St", "the house is 12-14 main", "the house is {M}"),
    ("742 Evergreen Ter", "742 - Evergreen", "{M}"),
    ("742 - Evergreen Terrace", "742 Evergreen", "{M}"),
    ("12 Mt. Vernon St", "house at 12 Mt. Vernon, by the park", "house at {M}, by the park"),
    ("12 Mt Vernon St", "house at 12 Mt. Vernon", "house at {M}"),
    ("12 O'Brien Rd", f"house at 12 O{CURLY}Brien", "house at {M}"),
    ("12 O'Brien Rd", "house at 12 OBrien", "house at {M}"),
    ("100 Pe" + chr(0xF1) + "a Blvd", "100 Pena, gate", "{M}, gate"),
    ("95 North St", "I live at 95 north st", "I live at {M}"),
    ("742 Evergreen Terrace Apt 4B", "unit 4-b please", "{M} please"),
    ("100 Main St #2A", "ring #2A", "ring {M}"),
    # The street ends where its words end: not inside "w/" or "e.g.", nor past a comma.
    ("742 Evergreen Terrace", "at 742 Evergreen Terrace w/ 2 baths", "at {M} w/ 2 baths"),
    ("1 Main St", "1 main e.g. the hall", "{M} e.g. the hall"),
    # Round 7: punctuation no longer stops the street's further words (the trade-off below).
    ("742 Evergreen Terrace", "742 Evergreen Terrace, north wall", "{M} wall"),
    ("742 Evergreen Terrace", "it's Evergreen Terrace 742 by the way", "it's {M} by the way"),
]


@pytest.mark.parametrize(("line", "text", "expected"), PARSED_STREETS)
def test_each_part_of_the_street_line_is_found_anywhere(
    line: str, text: str, expected: str
) -> None:
    result = redact_known(text, KnownValues(streets=(line,)))

    assert result == RedactionResult(expected.replace("{M}", MASK), True)


@pytest.mark.parametrize(
    ("line", "text"),
    [
        # A unit's id alone is an everyday number or word: it needs its unit word or "#".
        ("742 Evergreen Terrace #12", "Need 12 outlets replaced, 12 total"),
        ("#12 450 Ocean Dr", "need 12 outlets"),
        ("100 Main St #2A", "Service 2 A/C units"),
        ("742 Main St Apt", "the apt is upstairs"),
        # A street named by a direction never matches inside a word ("N95").
        ("95 North St", "Please wear N95 masks"),
        ("60 West St", "a 60W bulb"),
    ],
)
def test_a_unit_or_direction_alone_stays_unmasked(line: str, text: str) -> None:
    assert redact_known(text, KnownValues(streets=(line,))) == RedactionResult(text, False)


@pytest.mark.parametrize(
    "line",
    ["100 N N N N N", "12 N N N N Ave", "100 N. N. N. N. N.", "45 Martin Luther King Jr Blvd"],
)
@pytest.mark.parametrize(
    "text", ["n " * 1000, "n, " * 666, "n. " * 666, "N.E. " * 400, "north n " * 250, "100 n " * 333]
)
def test_hostile_inputs_against_odd_street_lines_finish_quickly(line: str, text: str) -> None:
    known = KnownValues(streets=(line,))

    assert best_seconds_without_gc(lambda: redact_text(text[:2000], known)) < 0.25


# Round 5 review (#172): the known street became a token scan. A dotted direction without its
# final period, ordinary repair language, generated addresses, and the worst inputs for time.
@pytest.mark.parametrize(
    "text", ["123 n.w main", "123 n.w. main", "123 N W main", "123 northwest main", "123 NW. Main"]
)
def test_a_direction_in_any_form_between_number_and_name(text: str) -> None:
    result = redact_known(f"at {text} today", KnownValues(streets=("123 Main Street NW",)))

    assert result == RedactionResult(f"at {MASK} today", True)


ORDINARY_REPAIR_TEXT = [
    "The main water line leaks under the kitchen sink.",
    "Trim the evergreen trees beside the fence.",
    "Replace 742 sq ft of flooring and 12 outlets.",
    "Install a 120 V outlet and replace the 60W bulb.",
    "The pressure is 123 psi and the main valve is stuck.",
    "Replace 123 main valve washers in the commercial building.",
    "Need 12 outlets replaced, 12 total.",
    "Service 2 A/C units and replace their filters.",
    "Replace the 3/4 inch fitting; pipe is 20 ft long.",
    "Built in 2000; two rooms need painting.",
    "One 4 by 8 sheet and six 2 by 4 boards are damaged.",
    "Use N95 masks for sanding; no mold is visible.",
    "The north wall is damp and the south wall is dry.",
    "Repair the main pump w/ 2 replacement seals.",
    "The hall is damaged, e.g. the ceiling and trim.",
    "The total floor area is 1800 sq ft.",
    "The 742 bus stops nearby, so parking is difficult.",
    "Install 4 brackets with 12 screws.",
    "The freezer reaches -10 degrees but the fridge is warm.",
    "Please come after 5pm or before 8am.",
]


@pytest.mark.parametrize("text", ORDINARY_REPAIR_TEXT)
def test_ordinary_repair_text_keeps_its_meaning(text: str) -> None:
    known = KnownValues(streets=("742 Evergreen Terrace NW Apt 4B",))

    assert redact_text(text, known) == RedactionResult(text, False)


_NAME_WORDS = (
    "Oak", "Maple", "Evergreen", "Ocean", "Martin", "Luther", "Vernon", "Sequoia", "Brickell",
    "Tamiami", "Dadeland", "Palm", "Coral", "Biscayne", "Flagler", "Cedar", "Willow", "Harbor",
)  # fmt: skip
_SUFFIX_FORMS = ("Street", "St", "St.", "Avenue", "Ave", "Terrace", "Ter", "Blvd", "Drive", "Dr")
_DIRECTION_FORMS = ("N", "NW", "N.W.", "South", "SE", "E", "W.", "Northwest")


def _generated_streets(count: int) -> list[tuple[str, str, str]]:
    """(stored line, house number, first name word): random names, suffixes and directions,
    duplicates included, the same every run."""
    rng = random.Random(172)  # noqa: S311 - reproducible test data, not secrets
    streets = []
    for _ in range(count):
        number = str(rng.randint(1, 99_999))
        names = rng.sample(_NAME_WORDS, rng.randint(1, 3))
        parts = [number]
        if rng.random() < 0.4:
            parts.append(rng.choice(_DIRECTION_FORMS))
        parts += names
        parts += [rng.choice(_SUFFIX_FORMS) for _ in range(rng.randint(0, 4))]
        if rng.random() < 0.4:
            parts.append(rng.choice(_DIRECTION_FORMS))
        streets.append((" ".join(parts), number, names[0]))
    return streets


GENERATED_STREETS = _generated_streets(200)


def test_generated_streets_mask_number_and_name_and_nothing_less() -> None:
    rng = random.Random(173)  # noqa: S311 - reproducible test data, not secrets
    for line, number, name in GENERATED_STREETS:
        known = KnownValues(streets=(line,))
        spelled = rng.choice([name.lower(), name.upper(), name.title()])
        joiner = rng.choice([" ", "  ", ", ", " - ", " n.w "])
        text = f"Meet me at {number}{joiner}{spelled}{rng.choice(['', '.', ',', ' today'])}"

        result = redact_known(text, known)

        assert result.redacted is True, (line, text)
        assert number not in result.text, (line, text)
        assert name.lower() not in result.text.lower(), (line, text)
        for alone in (f"The {spelled} one is fine.", f"Replace {number} tiles."):
            assert redact_known(alone, known) == RedactionResult(alone, False), (line, alone)


@pytest.mark.parametrize(
    ("line", "text"),
    [
        ("100 " + " ".join(["St"] * 80), "st " * 666),
        ("100 " + " ".join(["St"] * 80), "100 " + "st " * 660),
        ("100 " + " ".join(["St"] * 80), "100 " * 499),
        ("100 " + " ".join(["Main"] * 60), "100 " + "main " * 380),
        ("100 " + " ".join(["N"] * 60) + " Main", "100 " + "n " * 940),
        ("12 " + " ".join(_NAME_WORDS * 3) + " Apt 4B", ("12 oak apt 4b " * 150)),
        ("100 " + " ".join(["St"] * 80), ("100 " + "st" * 20 + " ") * 45),
        ("100 N Main", ("100 n." + "nw" * 19 + " ") * 45),
    ],
    ids=[
        "suffixes",
        "number-and-suffixes",
        "numbers",
        "names",
        "directions",
        "long-line",
        "glued-suffixes",
        "glued-directions",
    ],
)
def test_long_or_repetitive_streets_finish_quickly(line: str, text: str) -> None:
    known = KnownValues(streets=(line,))
    text = text[:2000]

    assert best_seconds_without_gc(lambda: redact_known(text, known)) < 0.05
    assert best_seconds_without_gc(lambda: redact_text(text, known)) < 0.25


# The scan reads word pieces and judges what stands between them: a period, a slash or an
# apostrophe glued to the address never hides it, and never joins it to the next sentence.
EVERGREEN = "742 Evergreen Terrace Apt 4B"
SCANNED = [
    (EVERGREEN, "I live at 742 Evergreen.Need help asap", "I live at {M}.Need help asap"),
    (EVERGREEN, "742 evergreen.thx", "{M}.thx"),
    (EVERGREEN, "at Evergreen 742.Thanks", "at {M}.Thanks"),
    (EVERGREEN, "Dir.742 Evergreen", "Dir.{M}"),
    (EVERGREEN, "Dir.Evergreen 742", "Dir.{M}"),
    (EVERGREEN, "742 Evergreen/Springfield, gate code", "{M}/Springfield, gate code"),
    (EVERGREEN, "Apt 4B/742 Evergreen please", "{M}/{M} please"),
    (EVERGREEN, "Address: 742 Evergreen's back gate", "Address: {M}'s back gate"),
    ("12 Elm St", f"12 Elm{CURLY}s", f"{{M}}{CURLY}s"),
    ("123 O'Brien Rd", "123 O'Brien's yard", "{M}'s yard"),
    ("123 Main St", "at 123 Main/Elm corner", "at {M}/Elm corner"),
    ("123 Main St", "at 123 N.Main today", "at {M} today"),
    ("123 Main Street NW", "at 123 N.W.Main today", "at {M} today"),
    (EVERGREEN, "My Apt.4B has a leak", "My {M} has a leak"),
    (EVERGREEN, "Ste.4B leaks", "{M} leaks"),
    (EVERGREEN, "Apt: 4B has a leak", "{M} has a leak"),
    (EVERGREEN, "Apt No. 4B has a leak", "{M} has a leak"),
    (EVERGREEN, "apartamento 4B tiene una fuga", "{M} tiene una fuga"),
    (EVERGREEN, "vivo en el 742 de la Evergreen, hay fuga", "vivo en el {M}, hay fuga"),
    ("100 Avenue of the Americas", "at 100 Avenue of the Americas", "at {M}"),
    ("100 Avenue of the Americas", "at 100 americas", "at {M}"),
    (
        "742 Evergreen Terrace",
        "Address is 742 Evergreen. S wall leaks.",
        "Address is {M} wall leaks.",
    ),
    # A stored line without a house number: its whole name and suffix.
    ("One Infinite Loop", "at One Infinite Loop today", "at {M} today"),
    ("Evergreen Terrace", "at Evergreen Terrace today", "at {M} today"),
]


@pytest.mark.parametrize(("line", "text", "expected"), SCANNED)
def test_the_scan_reads_pieces_and_the_gaps_between_them(
    line: str, text: str, expected: str
) -> None:
    result = redact_known(text, KnownValues(streets=(line,)))

    assert result == RedactionResult(expected.replace("{M}", MASK), True)


@pytest.mark.parametrize(
    ("line", "text"),
    [
        ("100 Avenue of the Americas", "Replace 100 of the tiles in the bath."),
        ("742 Evergreen Terrace Apt 2", "The living room 2 outlets are dead."),
        ("742 Evergreen Terrace Apt 74", "Pool pH 7.4 is low."),
        ("250 Oak St", "Lumber: oak 2.50 per foot."),
        ("742 Oak St", "We need 1,742 oak boards."),
        ("Evergreen Terrace", "Trim the evergreen trees."),
        ("1 Main St", "1 e.g. main"),
    ],
)
def test_the_scan_needs_the_exact_number_and_the_name(line: str, text: str) -> None:
    assert redact_known(text, KnownValues(streets=(line,))) == RedactionResult(text, False)


# Round 6 review (#172): abbreviation punctuation hid the known street. The scan now ignores
# whatever punctuation stands between pieces; the limits are the 6-piece distance and the
# exact house number.
@pytest.mark.parametrize(
    ("line", "text", "expected"),
    [
        ("742 Evergreen Terrace", "at evergreen No. 742.", "at {M}."),
        ("742 Evergreen Terrace", "at evergreen ter. 742.", "at {M}."),
        ("123 Main Street NW", "at 123 n.w., main.", "at {M}."),
        ("742 Evergreen Terrace", "at No.742 evergreen", "at No.{M}"),
        (
            "742 Evergreen Terrace",
            "at n" + chr(0xBA) + " 742 evergreen",
            "at n" + chr(0xBA) + " {M}",
        ),
        ("742 Evergreen Terrace", "at evergreen. 742", "at {M}"),
        ("742 Evergreen Terrace", "at 742, evergreen", "at {M}"),
        ("742 Evergreen Terrace", "at 742 / evergreen", "at {M}"),
        ("123 Main Street NW", "at 123 N.W.: main", "at {M}"),
    ],
)
def test_punctuation_between_number_and_name_never_hides_the_street(
    line: str, text: str, expected: str
) -> None:
    result = redact_known(text, KnownValues(streets=(line,)))

    assert result == RedactionResult(expected.replace("{M}", MASK), True)


@pytest.mark.parametrize(
    ("line", "text"),
    [
        ("742 Evergreen Terrace", "Lot 742 is far from the tall evergreen hedge"),
        ("742 Evergreen Terrace", "Check 742 of the pipes; they run under every tall evergreen."),
    ],
)
def test_a_number_more_than_six_pieces_from_the_name_stays(line: str, text: str) -> None:
    assert redact_known(text, KnownValues(streets=(line,))) == RedactionResult(text, False)


@pytest.mark.parametrize(
    ("line", "text", "expected"),
    [
        (
            "200 Main St",
            "Budget is about 200. Main issue is the leak.",
            "Budget is about {M} issue is the leak.",
        ),
        ("742 Evergreen Terrace", "Check the evergreen. 742 feet away", "Check the {M} feet away"),
    ],
)
def test_the_known_street_is_masked_across_a_sentence_by_design(
    line: str, text: str, expected: str
) -> None:
    # The accepted trade-off (round 7): the customer's own number and street name within six
    # pieces are masked even across a sentence. A few words more hidden cost little; a leak of
    # the address costs much.
    result = redact_known(text, KnownValues(streets=(line,)))

    assert result == RedactionResult(expected.replace("{M}", MASK), True)


# Round 7 review (#172): punctuation glued to the house number ("ter.742"). Every glue variant
# of 7 stored streets, number first and name first, is masked.
def test_every_glue_variant_of_the_known_street_is_masked() -> None:
    cases = all_glue_cases()
    leaks = []
    for line, text, number, name in cases:
        result = redact_known(text, KnownValues(streets=(line,)))
        lowered = result.text.lower()
        unquoted = lowered.replace("'", "")
        if not result.redacted or number in lowered or name.replace("'", "") in unquoted:
            leaks.append((line, text, result.text))

    assert len(cases) > 3000
    assert leaks == []


@pytest.mark.parametrize(
    ("line", "text"),
    [
        ("742 Evergreen Terrace", "742.5 sq ft of evergreen"),
        ("742 Evergreen Terrace", "1,742 sq ft of evergreen"),
        ("742 Evergreen Terrace", "742/12 evergreen"),
        ("742 Evergreen Terrace", "evergreen 742/12"),
        ("742 Evergreen Terrace", "evergreen 12/742"),
        ("742 Evergreen Terrace", "evergreen 1.742"),
        ("742 Evergreen Terrace", "the main water line"),
        ("742 Evergreen Terrace", "evergreen trees"),
        ("742 Evergreen Terrace", "742 evergreens"),
    ],
)
def test_a_number_joined_to_another_digit_is_never_the_house(line: str, text: str) -> None:
    assert redact_known(text, KnownValues(streets=(line,))) == RedactionResult(text, False)


@pytest.mark.parametrize(
    ("line", "text"),
    [
        ("742 Evergreen Terrace", "at evergreen ter.742."),
        ("123 Main Street", "at main st.123."),
        ("123 Main Street NW", "at main nw.123."),
        ("742 Evergreen Terrace", "at evergreen w/742."),
        ("742 Evergreen Terrace Apt 4B", "ring apt4b."),
    ],
)
def test_punctuation_glued_to_the_number_never_hides_the_street(line: str, text: str) -> None:
    result = redact_known(text, KnownValues(streets=(line,)))

    assert result.redacted is True
    for secret in ("742", "123", "4b"):
        assert secret not in result.text.lower(), secret


def test_a_unit_inside_the_street_line_is_masked_on_its_own() -> None:
    result = redact_known("ring apt 4-b", KnownValues(streets=("742 Evergreen Terrace Apt 4B",)))

    assert result == RedactionResult(f"ring {MASK}", True)


def test_known_values_leave_other_text_alone() -> None:
    text = "The 742 bus stops near 5 units; call after 5pm, 3 bedrooms."

    assert redact_known(text, KNOWN) == redact_known(text, KnownValues())
    assert redact_known(text, KNOWN).redacted is False


def test_redact_text_runs_both_passes() -> None:
    result = redact_text(
        "742 evergreen ter, or bob@x.co", KnownValues(streets=("742 Evergreen Ter",))
    )

    assert result.text == f"{MASK}, or {MASK}"
    assert result.redacted is True


HOSTILE: list[str] = [
    # Long runs of near-matches, each about 2,000 characters (the description limit). Found
    # slow (seconds to minutes) by the adversarial sweep before the patterns were anchored.
    "a . " * 500,
    "1 " * 1000,
    "@" * 2000,
    "x at y dot " * 180,
    "12 " + "Main " * 400,
    "5" * 2000,
    "calle " * 333,
    "12 " * 666,
    "12/" * 666,
    "12-" * 666,
    "a." * 1000,
    "a-" * 1000,
    "www." * 500,
    "1.2." * 500,
    "de la " * 333,
    "kitchen.bathroom.garage.roof." * 68,
    "I.need.help.with.my.ac.it.is.not.working." * 48,
    "ab." * 600 + "ab at gmail",
    " ".join(str(110 + (i % 15)) for i in range(400)),
    " ".join(f"{m}/{d}" for m in (10, 11) for d in range(1, 31)) * 4,
]


@pytest.mark.parametrize("text", HOSTILE, ids=[f"{t[:12]}x{len(t)}" for t in HOSTILE])
def test_hostile_inputs_finish_quickly(text: str) -> None:
    # Both passes, with known values that look like the hostile runs.
    assert len(text) <= 2100
    assert best_seconds_without_gc(lambda: redact_text(text, KNOWN)) < 0.25


@pytest.mark.parametrize(
    "text",
    ["3 0 5 " * 333, "742 " * 500, "evergreen " * 200, "3-0-5-" * 333, "jane.doe77 at " * 140],
)
def test_hostile_inputs_against_the_known_values_finish_quickly(text: str) -> None:
    assert best_seconds_without_gc(lambda: redact_text(text, KNOWN)) < 0.25


@pytest.mark.parametrize(
    "text",
    [
        "@home" + chr(0x093F) * 5000 + "fixit",  # Mc: _clean keeps the run, _MARKED takes it
        "@home" + chr(0x0483) * 5000 + "fixit",  # Mn: _clean keeps one mark after a letter
        "@home" + chr(0x093F) * 5000,
        ("@home" + chr(0x093F)) * 400,
        "@" + ("a" + chr(0x093F)) * 1000,
        ("x" + chr(0x093F) + ".") * 700,
        "@" + ("1" + chr(0x093F) + ".") * 700,
    ],
    ids=[
        "5000_mc_then_fixit",
        "5000_mn_then_fixit",
        "5000_mc",
        "home_mc_x400",
        "letter_mc_x1000",
        "letter_mc_dot_x700",
        "digit_mc_dot_x700",
    ],
)
def test_many_marks_after_exempt_word_is_fast(text: str) -> None:
    """The mark runs are possessive (_MARKED) and the body counts characters, not marks."""
    assert best_seconds_without_gc(lambda: redact_text(text, KNOWN)) < 0.25
