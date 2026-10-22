"""The contact redactor (app/redaction.py, #172 now, chat #72 later): a table-driven corpus.

POSITIVE: each input must lose the listed secrets (and be flagged). NEGATIVE: each input must
come back unchanged (and not flagged). The module docstring lists the known gaps on purpose.
"""

import time

import pytest

from app.redaction import MASK, KnownValues, redact_contacts, redact_known, redact_text

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
    started = time.perf_counter()
    redact_text(text, KNOWN)

    assert time.perf_counter() - started < 0.25


@pytest.mark.parametrize(
    "text",
    ["3 0 5 " * 333, "742 " * 500, "evergreen " * 200, "3-0-5-" * 333, "jane.doe77 at " * 140],
)
def test_hostile_inputs_against_the_known_values_finish_quickly(text: str) -> None:
    started = time.perf_counter()
    redact_text(text, KNOWN)

    assert time.perf_counter() - started < 0.25
