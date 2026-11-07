"""Chat-style evasions of the contact redactor (#72), each sent through the chat POST: what a
sender types to slip a phone, an email, a handle or a link past it. Every case must come back
masked with the warning; the ordinary chat lines must come back untouched. The evasions the
redactor does not catch yet are xfail (strict) with the reason, and listed in the PR."""

import uuid
from typing import Final

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.redaction import MASK, redact_contacts
from tests.helpers import best_seconds_without_gc
from tests.job_world import JobWorld, build_world, make_job

ZW: Final = chr(0x200B)  # zero-width space
ZWJ: Final = chr(0x200D)  # zero-width joiner
KEYCAP: Final = chr(0xFE0F) + chr(0x20E3)
PHONE: Final = "3055550199"


def _digits(base: int, number: str = PHONE) -> str:
    return "".join(chr(base + int(digit)) for digit in number)


def _circled(number: str = PHONE) -> str:
    return "".join(chr(0x24EA) if d == "0" else chr(0x2460 + int(d) - 1) for d in number)


# (id, typed, what must not survive)
EVASIONS: Final = [
    # Spelled digits
    ("spelled_oh", "call me three oh five five five five oh one nine nine", "one nine nine"),
    ("spelled_zero", "text three zero five five five five zero one nine nine", "one nine nine"),
    ("spelled_commas", "three, oh, five, five, five, five, oh, one, nine, nine", "one, nine"),
    ("spelled_es", "llamame al tres cero cinco cinco cinco cinco cero uno nueve nueve", "uno"),
    ("spelled_area_numerals", "three oh five 555 0199", "0199"),
    ("numerals_spelled_line", "305 555 oh one nine nine", "one nine nine"),
    ("numerals_spelled_rest", "305 five five five oh one nine nine", "one nine nine"),
    ("spelled_area_dashed", "three oh five 555-0199", "0199"),
    # Spaced, dotted and odd separators
    ("spaced_digits", "my number 3 0 5 5 5 5 0 1 9 9", "0 1 9 9"),
    ("dotted_digits", "my number 3.0.5.5.5.5.0.1.9.9", "0.1.9.9"),
    ("dashed_digits", "3-0-5-5-5-5-0-1-9-9 call me", "0-1-9-9"),
    ("slashes", "305/555/0199", "0199"),
    ("comma_groups", "305, 555, 0199", "0199"),
    ("comma_groups_tight", "call 305,555,0199", "0199"),
    ("emoji_separator", "305\U0001f525555\U0001f5250199", "0199"),
    ("underscores", "305_555_0199", "0199"),
    ("plus_country", "+1 (305) 555-0199", "0199"),
    ("venezuela", "+58 412 555 0199", "0199"),
    # Unicode digits and invisible characters
    ("keycaps", "call " + "".join(d + KEYCAP for d in PHONE), "9" + KEYCAP),
    ("fullwidth", "call " + _digits(0xFF10), _digits(0xFF10, "0199")),
    ("math_bold", "call " + _digits(0x1D7CE), _digits(0x1D7CE, "0199")),
    ("circled", "call " + _circled(), _circled("0199")),
    ("zero_width_phone", ZW.join(PHONE), "0" + ZW + "1" + ZW + "9"),
    ("joiner_phone", ZWJ.join("305-555-0199"), "0" + ZWJ + "1"),
    ("zero_width_email", f"jdoe{ZW}@{ZW}gmail{ZW}.com", "jdoe"),
    # Emails
    ("at_gmail_dot_com", "write jdoe at gmail dot com", "jdoe"),
    ("arroba_punto", "escribe a jdoe arroba gmail punto com", "jdoe"),
    ("brackets", "jdoe [at] gmail [dot] com", "jdoe"),
    ("parens", "jdoe(at)gmail(dot)com", "jdoe"),
    ("spaced_email", "jdoe @ gmail . com", "jdoe"),
    ("provider_no_tld", "my email is jdoe at gmail", "jdoe"),
    ("letters_email", "j d o e @ g m a i l . c o m", "j d o e"),
    # Handles and platforms
    ("at_handle", "follow me @jdoe_fixit", "jdoe_fixit"),
    ("ig_dotted", "my ig is jdoe.fixit", "jdoe.fixit"),
    ("insta_colon", "insta: jdoe_fixit", "jdoe_fixit"),
    ("telegram_at", "telegram @jdoefixit", "jdoefixit"),
    ("snapchat", "snapchat jdoefixit22", "jdoefixit22"),
    ("spaced_at_handle", "dm me on insta @ jdoe_fixit", "jdoe_fixit"),
    ("whatsapp_number", "whatsapp me 305 555 0199", "0199"),
    ("cashtag", "send it to $jdoefixit", "jdoefixit"),
    ("venmo_at", "venmo @jdoe-fixit", "jdoe-fixit"),
    # Links
    ("wa_me", "wa.me/13055550199", "13055550199"),
    ("wa_me_https", "https://wa.me/13055550199", "13055550199"),
    ("t_me", "t.me/jdoefixit", "jdoefixit"),
    ("t_me_https", "https://t.me/jdoefixit", "jdoefixit"),
    ("zero_width_link", f"wa{ZW}.me/13055550199", "13055550199"),
    ("spelled_dot_com", "visit jdoefixit dot com", "jdoefixit"),
]

# Not caught yet: each would need a rule whose false positives were judged worse (#72).
GAPS: Final = [
    (
        "split_by_words",
        "call 305 then 555 then 0199",
        "0199",
        "numbers split by ordinary words: no cue-free rule tells them from quantities",
    ),
    (
        "area_code_words",
        "area code 305 number 555 0199",
        "305",
        "the area code is split from the number by words; 555 0199 alone is 7 digits",
    ),
    (
        "letters_for_digits",
        "305 555 O199",
        "O199",
        "a letter O or l for a digit: model numbers and codes read the same",
    ),
    (
        "double_triple",
        "three oh five triple five oh one double nine",
        "double nine",
        "'double' and 'triple' multipliers in a spelled number",
    ),
]

# Ordinary chat lines that must stay as typed.
ORDINARY: Final = [
    "The quote is $125 for the repair",
    "Total $1,250.00 with parts",
    "I can come at 3:30 pm tomorrow",
    "between 10 and 12, or after 5",
    "I need 2 outlets and 3 switches",
    "the pipe is 3/4 inch, 12 ft long",
    "the heater is from 2015",
    "it takes three or four hours, five at most",
    "I'm at home at noon",
    "I sent the photos by email",
    "no whatsapp please, use this chat",
    "model RTH6580WF thermostat",
    "sizes 100, 200, 1000 are in stock",
    "one two three, let's go",
    "it was 1,250, 1,300 and 1,450 last year",
    "room 101, 102, 1003 on the list",
    "I'll be there in five, two minutes at most",
    "oh one more thing: the gate sticks",
]


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def _send(
    client: httpx.AsyncClient, session: AsyncSession, world: JobWorld, typed: str
) -> dict[str, object]:
    job = await make_job(session, world)
    response = await client.post(
        f"/v1/jobs/{job.id}/messages", json={"body": typed}, headers=world.customer.headers
    )
    assert response.status_code == 201, response.text
    body: dict[str, object] = response.json()
    uuid.UUID(str(body["id"]))
    return body


@pytest.mark.parametrize(
    ("typed", "secret"), [case[1:] for case in EVASIONS], ids=[c[0] for c in EVASIONS]
)
async def test_evasions_are_masked_and_the_sender_warned(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    typed: str,
    secret: str,
) -> None:
    body = await _send(db_client, db_session, world, typed)

    assert secret not in str(body["body"])
    assert MASK in str(body["body"])
    assert (body["redacted"], body["warning"]) == (True, "contact_details_hidden")


@pytest.mark.parametrize(
    ("typed", "secret"),
    [
        pytest.param(typed, secret, marks=pytest.mark.xfail(reason=reason, strict=True), id=case)
        for case, typed, secret, reason in GAPS
    ],
)
async def test_known_gaps(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    typed: str,
    secret: str,
) -> None:
    body = await _send(db_client, db_session, world, typed)

    assert secret not in str(body["body"])


@pytest.mark.parametrize("typed", ORDINARY)
async def test_ordinary_lines_are_untouched(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, typed: str
) -> None:
    body = await _send(db_client, db_session, world, typed)

    assert (body["body"], body["redacted"], body["warning"]) == (typed, False, None)


# The new phone rules (#72) on worst-case 2,000-character messages (the chat limit): within the
# #300 budget.
ADVERSARIAL: Final = {
    "digit_words": "one " * 500,
    "oh_words": "oh " * 700,
    "mixed_parts": "three oh five 555 " * 200,
    "comma_groups": "305, 555, " * 300,
    "tight_comma_groups": "305,555," * 300,
    "area_codes": "(305) " * 400,
    "gaps_only": "one" + " ,.-" * 600,
}


@pytest.mark.parametrize("text", ADVERSARIAL.values(), ids=ADVERSARIAL.keys())
def test_worst_case_messages_stay_within_the_budget(text: str) -> None:
    assert best_seconds_without_gc(lambda: redact_contacts(text[:2000])) < 0.25
