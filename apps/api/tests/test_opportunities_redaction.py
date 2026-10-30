"""Contacts typed into a request never reach a pro before payment (#172, Vault round 1).

End to end: the request is created through POST /v1/requests by a customer whose account holds
the canary email and phone, at the canary street, then dispatched; the pro's feed and detail
are checked on their serialized values. The customer's own view keeps the text as written.
"""

import logging
import unicodedata
import uuid
from typing import Any, Literal

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import get_storage
from app.modules.categories.intake import INTAKE_QUESTIONS
from app.modules.categories.models import Category
from app.modules.jobs.service import SYSTEM
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter
from app.redaction import MASK
from tests.conftest import InMemoryRateLimiter
from tests.contact_overlaps import (
    CUT_CONTACTS,
    CUT_IDS,
    FLOOR_CONTACTS,
    FLOOR_IDS,
    OVERLAP_IDS,
    PHONE_EMAIL_OVERLAPS,
)
from tests.glue_variants import glue_sample
from tests.helpers import async_best_seconds_without_gc
from tests.test_intake_questions import labels, option
from tests.test_opportunities_api import BASE, Pro, dispatch, make_pro
from tests.test_redaction import (
    B1_EMAILS,
    B2_CASHTAGS,
    B3_HANDLES,
    B4_SPANS,
    B5_CHAINS,
    R2_B1_PIECES,
)
from tests.test_requests_api import (
    ADDRESS,
    NOW,
    Caller,
    FakeStorage,
    RecordingQueue,
    create,
    make_caller,
    make_category,
)

# The Vault's canaries: the customer's own account email and phone, and the request's street.
EMAIL = "privacy-canary@example.invalid"
PHONE = "+15555550199"
STREET = ADDRESS["line1"]
CONTACT_TEXT = f"{EMAIL}; call {PHONE}; repair the sink at {STREET}, Apt 4."
# Every form a canary could take in the JSON.
CANARIES = (EMAIL, "privacy-canary", "example.invalid", PHONE, "5555550199", STREET)

QUESTIONS: list[dict[str, Any]] = [
    {"key": "notes", "type": "text", "required": False, "max_length": 500,
     "labels": labels("Additional details")},
    {"key": "rooms", "type": "integer", "required": False, "min": 1, "max": 6,
     "labels": labels("Rooms")},
    {"key": "size", "type": "single_choice", "required": False, "labels": labels("Size"),
     "options": [option("small"), option("large")]},
    {"key": "pets", "type": "boolean", "required": False, "labels": labels("Pets")},
]  # fmt: skip


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
async def storage(app: FastAPI, db_session: AsyncSession) -> FakeStorage:
    """The fixture address's ZIP served (#46), fake storage and a fixed rate-limit clock."""
    db_session.add(
        ServiceArea(region="Test Region", city="Orlando", state="FL", zip_code=ADDRESS["zip_code"])
    )
    await db_session.flush()
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return fake


async def dispatched(
    client: httpx.AsyncClient,
    session: AsyncSession,
    *,
    description: str = "Repair the leaking kitchen sink.",
    answers: dict[str, Any] | None = None,
    email: str = EMAIL,
    phone: str = PHONE,
    street: str = STREET,
    address: dict[str, str] | None = None,
) -> tuple[Caller, Pro, uuid.UUID, uuid.UUID, uuid.UUID]:
    """A request created through the API, moved to finding_pro and dispatched to a new pro.
    The customer's account holds `email` and `phone`; the request's address is `street`."""
    customer = await make_caller(session)
    await session.execute(
        update(User).where(User.id == customer.id).values(email=email, phone=phone)
    )
    category_id = await make_category(session, questions=QUESTIONS)
    response = await create(
        client,
        customer,
        category_id=str(category_id),
        description=description,
        intake_answers=answers or {},
        address=address or dict(ADDRESS, line1=street),
    )
    assert response.status_code == 201, response.text
    request_id = uuid.UUID(response.json()["id"])
    await RequestStateMachine(session).transition(request_id, RequestStatus.FINDING_PRO, SYSTEM)
    pro = await make_pro(session)
    return customer, pro, request_id, await dispatch(session, request_id, pro), category_id


def assert_no_canary(response: httpx.Response) -> None:
    assert response.status_code == 200, response.text
    for canary in CANARIES:
        assert canary not in response.text, canary


async def test_description_contacts_masked_in_the_list_excerpt(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    _, pro, _, _, _ = await dispatched(db_client, db_session, description=CONTACT_TEXT)

    listing = await db_client.get(BASE, headers=pro.caller.headers)

    assert_no_canary(listing)
    [item] = listing.json()["items"]
    assert MASK in item["description_excerpt"]
    assert "repair the sink at" in item["description_excerpt"]
    assert item["text_redacted"] is True


async def test_description_contacts_masked_in_the_detail(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    _, pro, _, dispatch_id, _ = await dispatched(db_client, db_session, description=CONTACT_TEXT)

    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)

    assert_no_canary(detail)
    body = detail.json()
    assert body["description"] == f"{MASK}; call {MASK}; repair the sink at {MASK}, {MASK}."
    assert body["text_redacted"] is True


async def test_text_answer_contacts_masked_and_other_answers_unchanged(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    answers = {"notes": CONTACT_TEXT, "rooms": 3, "size": "large", "pets": True}
    _, pro, _, dispatch_id, _ = await dispatched(db_client, db_session, answers=answers)

    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)
    [item] = (await db_client.get(BASE, headers=pro.caller.headers)).json()["items"]

    assert_no_canary(detail)
    body = detail.json()
    assert body["intake_answers"] == {
        "notes": f"{MASK}; call {MASK}; repair the sink at {MASK}, {MASK}.",
        "rooms": 3,
        "size": "large",
        "pets": True,
    }
    assert body["description"] == "Repair the leaking kitchen sink."
    assert body["text_redacted"] is True
    # The list shows only the description, which had nothing to mask.
    assert item["text_redacted"] is False


async def test_answer_of_a_question_no_longer_in_the_category_is_still_masked(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # Fail closed: an answer whose question type is unknown now is treated as text.
    _, pro, _, dispatch_id, category_id = await dispatched(
        db_client, db_session, answers={"notes": CONTACT_TEXT, "size": "small"}
    )
    await db_session.execute(
        update(Category).where(Category.id == category_id).values(intake_questions=[])
    )

    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)

    assert_no_canary(detail)
    assert detail.json()["intake_answers"]["notes"].startswith(MASK)
    assert detail.json()["intake_answers"]["size"] == "small"


async def test_nothing_to_mask_leaves_text_as_written_and_flag_false(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    text = "The 50 gallon water heater from 2015 leaks; 2nd floor, $150 budget, after 5pm."
    _, pro, _, dispatch_id, _ = await dispatched(
        db_client, db_session, description=text, answers={"notes": "3 bedrooms, ZIP 33301"}
    )

    body = (await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)).json()

    assert body["description"] == text
    assert body["intake_answers"] == {"notes": "3 bedrooms, ZIP 33301"}
    assert body["text_redacted"] is False


async def test_the_customer_still_sees_their_own_text_as_written(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    customer, _, request_id, _, _ = await dispatched(
        db_client, db_session, description=CONTACT_TEXT, answers={"notes": CONTACT_TEXT}
    )

    own = await db_client.get(f"/v1/requests/{request_id}", headers=customer.headers)

    assert own.status_code == 200
    assert own.json()["description"] == CONTACT_TEXT
    assert own.json()["intake_answers"]["notes"] == CONTACT_TEXT


# Round 3 review (#172): ordinary contact formats, with the customer's own account email and
# phone and the request's own street matching the text, through all three pro paths.
ROUND3_CASES = [
    # (name, text, secret, account email, account phone, request street)
    (
        "phone-in-afternoon",
        "Call 305-555-0199 in the afternoon about the broken kitchen sink.",
        "305-555-0199",
        "test@example.invalid",
        "+13055550199",
        STREET,
    ),
    (
        "underscore-email",
        "Email _jane@example.com about the leaking kitchen sink.",
        "_jane@example.com",
        "_jane@example.com",
        "+13055550199",
        STREET,
    ),
    (
        "lowercase-street",
        "The leaking kitchen sink is at 2000 ocean drive.",
        "2000 ocean drive",
        "test@example.invalid",
        "+13055550199",
        "2000 ocean drive",
    ),
]


# Round 4 review (#172): the request's own street, written without the parts that follow its
# name in the stored line (a direction after the suffix, a unit inside line1).
ROUND4_CASES = [
    (
        "street-direction-after-suffix",
        "Repair the leaking kitchen sink at 123 main nw.",
        "123 main nw",
        "test@example.invalid",
        "+13055550199",
        "123 Main Street NW",
    ),
    (
        "street-unit-in-line1",
        "Repair the leaking kitchen sink at 742 evergreen.",
        "742 evergreen",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace Apt 4B",
    ),
    # Round 7 review: punctuation glued to the house number.
    (
        "suffix-period-glued",
        "Repair the leaking kitchen sink at evergreen ter.742.",
        "ter.742",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace",
    ),
    (
        "street-period-glued",
        "Repair the leaking kitchen sink at main st.123.",
        "st.123",
        "test@example.invalid",
        "+13055550199",
        "123 Main Street",
    ),
    (
        "direction-period-glued",
        "Repair the leaking kitchen sink at main nw.123.",
        "nw.123",
        "test@example.invalid",
        "+13055550199",
        "123 Main Street NW",
    ),
    # Round 6 review: abbreviation punctuation between the number and the name.
    (
        "number-mark-period",
        "Repair the leaking kitchen sink at evergreen No. 742.",
        "evergreen No. 742",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace",
    ),
    (
        "suffix-period",
        "Repair the leaking kitchen sink at evergreen ter. 742.",
        "evergreen ter. 742",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace",
    ),
    (
        "direction-period-comma",
        "Repair the leaking kitchen sink at 123 n.w., main.",
        "123 n.w., main",
        "test@example.invalid",
        "+13055550199",
        "123 Main Street NW",
    ),
    # Round 5 review: a dotted direction without its final period.
    (
        "dotted-direction-no-final-period",
        "Repair the leaking kitchen sink at 123 n.w main.",
        "123 n.w main",
        "test@example.invalid",
        "+13055550199",
        "123 Main Street NW",
    ),
    # #229: an exempt word glued to a mark outside the Latin blocks is a handle, as with
    # "@home.fixit"; the whole token goes, so "fixit" never reaches the pro.
    (
        "handle-glued-to-cyrillic-mark",
        "Repair the leaking kitchen sink, find me @home" + chr(0x0483) + "fixit.",
        "fixit",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace",
    ),
    # #236: a Unicode letter in the handle body used to end the mask ("•••ñana.fixit"), and a
    # mark inside a platform id used to leave the mark and "smith".
    (
        "handle-with-unicode-letters",
        "Repair the leaking kitchen sink, find me @mañana.fixit please.",
        "fixit",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace",
    ),
    (
        "platform-id-with-cyrillic-mark",
        "Repair the leaking kitchen sink, insta: bob" + chr(0x0483) + "smith please.",
        "smith",
        "test@example.invalid",
        "+13055550199",
        "742 Evergreen Terrace",
    ),
]
# Vault round 1 on #240 (#257): an email that takes a phone's last group used to leave
# "786 555"; the customer's own phone is another one, so the patterns mask it.
OVERLAP_CASES = [
    (
        f"phone-email-overlap-{name}",
        f"Repair the leaking kitchen sink, call {contact} please.",
        contact[:7],
        "test@example.invalid",
        "+17865550100",
        "742 Evergreen Terrace",
    )
    for name, contact in zip(OVERLAP_IDS, PHONE_EMAIL_OVERLAPS, strict=True)
]
# Vault round 2 on #240: the URL took the reverse handle's platform and left "jdoe1", the
# email took the street's suffix and left "1250 Ocean"; NFC and NFD (the accents decompose).
CUT_CASES = [
    (
        f"cut-{name}-{form.lower()}",
        unicodedata.normalize(form, f"Reparar el fregadero, escríbeme a {contact} mañana."),
        secret,
        "test@example.invalid",
        "+17865550100",
        "742 Evergreen Terrace",
    )
    for name, (contact, secret) in zip(CUT_IDS, CUT_CONTACTS, strict=True)
    for form in ("NFC", "NFD")
]
# Fix round 5 on #240 (the safety floor): a URL or an email took the contact's number or cue
# (Vault R3-B1), a refused match left a street (F-B1), a recovered handle left its unit (F-B2).
# Develop's filter hid each one; the account's own values are unrelated.
FLOOR_CASES = [
    (
        f"floor-{name}-{form.lower()}",
        unicodedata.normalize(form, f"Reparar el fregadero, escríbeme a {contact}, gracias."),
        secret,
        "test@example.invalid",
        "+17865550100",
        "100 Harbor Point Blvd",
    )
    for name, (contact, secret, _) in zip(FLOOR_IDS, FLOOR_CONTACTS, strict=True)
    for form in ("NFC", "NFD")
]
CASES = ROUND3_CASES + ROUND4_CASES + OVERLAP_CASES + CUT_CASES + FLOOR_CASES


@pytest.mark.parametrize(
    ("name", "text", "secret", "email", "phone", "street"), CASES, ids=[case[0] for case in CASES]
)
@pytest.mark.parametrize(
    ("source", "route"), [("description", "list"), ("description", "detail"), ("intake", "detail")]
)
async def test_ordinary_contacts_never_reach_a_pro(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    name: str,
    text: str,
    secret: str,
    email: str,
    phone: str,
    street: str,
    source: str,
    route: str,
) -> None:
    _, pro, _, dispatch_id, _ = await dispatched(
        db_client,
        db_session,
        description=text if source == "description" else "Repair the leaking kitchen sink.",
        answers={"notes": text} if source == "intake" else None,
        email=email,
        phone=phone,
        street=street,
    )

    response = await db_client.get(
        BASE if route == "list" else f"{BASE}/{dispatch_id}", headers=pro.caller.headers
    )

    assert response.status_code == 200, response.text
    assert secret not in response.text, f"{name} leaked through {source}/{route}"
    body = response.json()
    flagged = body["items"][0]["text_redacted"] if route == "list" else body["text_redacted"]
    assert flagged is True


# The tables of the earlier review rounds on #240, one description each: B1-B5 (round 1) and
# the dot and punto pieces (round 2). Each line masked as the redactor's own tests expect.
REVIEW_TABLES = {
    "b1-explicit-cue": [(text, MASK) for text in B1_EMAILS],
    "b2-cashtag": [(text, MASK) for text in B2_CASHTAGS],
    "b3-marked-latin": B3_HANDLES,
    "b4-marked-tld": [(text, MASK) for text in B4_SPANS],
    "b5-long-chain": [(text, MASK) for text in B5_CHAINS],
    "r2-b1-dot-pieces": [(text, MASK) for text in R2_B1_PIECES],
}


@pytest.mark.parametrize("form", ["NFC", "NFD"])
@pytest.mark.parametrize("table", list(REVIEW_TABLES))
async def test_the_review_tables_reach_a_pro_masked(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    table: str,
    form: Literal["NFC", "NFD"],
) -> None:
    entries = REVIEW_TABLES[table]
    description = "\n".join(f"Write to {text}" for text, _ in entries)
    _, pro, _, dispatch_id, _ = await dispatched(
        db_client,
        db_session,
        description=unicodedata.normalize(form, description),
        email="test@example.invalid",
        phone="+17865550100",
        street="100 Harbor Point Blvd",
    )

    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)

    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["description"] == "\n".join(f"Write to {masked}" for _, masked in entries)
    assert body["text_redacted"] is True


@pytest.mark.parametrize(
    ("source", "route"), [("description", "list"), ("description", "detail"), ("intake", "detail")]
)
async def test_a_street_of_repeated_suffixes_does_not_slow_a_read(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    source: str,
    route: str,
) -> None:
    # Round 5 review: a stored street that repeats its suffix, against text that repeats it too
    # (the description at its longest, the notes answer at its 500-character limit).
    text = ("st " * (166 if source == "intake" else 666)).strip()
    _, pro, _, dispatch_id, _ = await dispatched(
        db_client,
        db_session,
        description=text if source == "description" else "Repair the leaking kitchen sink.",
        answers={"notes": text} if source == "intake" else None,
        street="100 " + " ".join(["St"] * 25),
    )

    async def read() -> None:
        response = await db_client.get(
            BASE if route == "list" else f"{BASE}/{dispatch_id}", headers=pro.caller.headers
        )
        assert response.status_code == 200, response.text

    # The best of three reads: a busy test machine can stall one read; backtracking would make
    # every read take seconds.
    seconds = await async_best_seconds_without_gc(read)

    assert seconds < 0.25, f"{source}/{route}: {seconds:.3f} s"


@pytest.mark.parametrize(("line", "text", "number", "name"), glue_sample(30))
@pytest.mark.parametrize(
    ("source", "route"), [("description", "list"), ("description", "detail"), ("intake", "detail")]
)
async def test_glue_variants_never_reach_a_pro(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    line: str,
    text: str,
    number: str,
    name: str,
    source: str,
    route: str,
) -> None:
    # A seeded sample of the glue variants (tests/glue_variants.py), end to end.
    _, pro, _, dispatch_id, _ = await dispatched(
        db_client,
        db_session,
        description=text if source == "description" else "Repair the leaking kitchen sink.",
        answers={"notes": text} if source == "intake" else None,
        street=line,
    )

    response = await db_client.get(
        BASE if route == "list" else f"{BASE}/{dispatch_id}", headers=pro.caller.headers
    )

    assert response.status_code == 200, response.text
    body = response.json()
    item = body["items"][0] if route == "list" else body
    shown = (
        item["description_excerpt"]
        if route == "list"
        else item["description"]
        if source == "description"
        else item["intake_answers"]["notes"]
    ).lower()
    assert number not in shown, shown
    assert name.replace("'", "") not in shown.replace("'", ""), shown
    assert item["text_redacted"] is True


@pytest.mark.parametrize("new_type", ["integer", "boolean", "single_choice"])
async def test_a_changed_question_type_keeps_the_old_text_answer_private(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, new_type: str
) -> None:
    # Questions are editable: the current type proves nothing about an answer given before.
    _, pro, _, dispatch_id, category_id = await dispatched(
        db_client, db_session, answers={"notes": EMAIL}
    )
    changed: dict[str, Any] = {
        "key": "notes", "type": new_type, "required": False, "labels": labels("Notes"),
    }  # fmt: skip
    if new_type == "integer":
        changed.update(min=1, max=6)
    if new_type == "single_choice":
        changed["options"] = [option("small"), option("large")]
    INTAKE_QUESTIONS.validate_python([changed])
    await db_session.execute(
        update(Category).where(Category.id == category_id).values(intake_questions=[changed])
    )

    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)

    assert_no_canary(detail)
    assert detail.json()["text_redacted"] is True


async def test_the_customers_own_details_are_masked_in_any_format(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # The known-value pass: the account phone written five odd ways, the email in mixed case,
    # and the street in lowercase without its suffix.
    text = (
        "Call 3o5 or (305)555 0199, 305..555..0199, 305 - 555 - 01 99, +1 305/555/0199 or "
        "3 0 5 5 5 5 0 1 9 9. Mail PRIVACY-Canary@Example.Invalid. I am at 742 evergreen."
    )
    _, pro, _, dispatch_id, _ = await dispatched(db_client, db_session, description=text)

    detail = await db_client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)

    assert_no_canary(detail)
    description = detail.json()["description"]
    for secret in ("0199", "01 99", "privacy", "evergreen", "742"):
        assert secret not in description.lower(), secret


# Vault round 2 (#172): the city pros see is the service area's, never the customer's text.

CITY_CANARY = f"Orlando; {EMAIL}; {PHONE}; {STREET}"


async def pro_reads(
    client: httpx.AsyncClient, pro: Pro, dispatch_id: uuid.UUID
) -> tuple[httpx.Response, httpx.Response]:
    listing = await client.get(BASE, headers=pro.caller.headers)
    detail = await client.get(f"{BASE}/{dispatch_id}", headers=pro.caller.headers)
    assert listing.status_code == detail.status_code == 200, (listing.text, detail.text)
    return listing, detail


@pytest.mark.parametrize("typed", [CITY_CANARY, "orlando", "Orlndo", "ORLANDO FL"])
async def test_pros_see_the_service_areas_city_never_the_typed_one(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, typed: str
) -> None:
    customer, pro, request_id, dispatch_id, _ = await dispatched(
        db_client, db_session, address=dict(ADDRESS, city=typed)
    )

    listing, detail = await pro_reads(db_client, pro, dispatch_id)

    expected = {"zip_code": ADDRESS["zip_code"], "city": "Orlando"}
    assert listing.json()["items"][0]["location"] == expected
    assert detail.json()["location"] == expected
    for response in (listing, detail):
        for canary in CANARIES:
            assert canary not in response.text, canary
    # The customer's own view keeps what they typed.
    own = await db_client.get(f"/v1/requests/{request_id}", headers=customer.headers)
    assert own.json()["address"]["city"] == typed


async def test_a_zip_without_an_active_area_shows_no_city(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _, pro, request_id, dispatch_id, _ = await dispatched(
        db_client, db_session, address=dict(ADDRESS, city=CITY_CANARY)
    )
    # The area is deactivated after the request (the BDC stops serving the ZIP).
    await db_session.execute(
        update(ServiceArea).where(ServiceArea.zip_code == ADDRESS["zip_code"]).values(active=False)
    )

    with caplog.at_level(logging.WARNING):
        listing, detail = await pro_reads(db_client, pro, dispatch_id)

    expected = {"zip_code": ADDRESS["zip_code"], "city": None}
    assert listing.json()["items"][0]["location"] == expected
    assert detail.json()["location"] == expected
    for response in (listing, detail):
        assert "Orlando" not in response.text
        for canary in CANARIES:
            assert canary not in response.text, canary
    missing = [r for r in caplog.records if r.getMessage() == "opportunity_city_missing"]
    assert missing
    assert {r.__dict__["service_request_id"] for r in missing} == {str(request_id)}


async def test_a_zip_plus_four_is_shown_as_its_five_digits(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    _, pro, _, dispatch_id, _ = await dispatched(
        db_client, db_session, address=dict(ADDRESS, zip_code=ADDRESS["zip_code"] + "-1234")
    )

    _, detail = await pro_reads(db_client, pro, dispatch_id)

    assert detail.json()["location"] == {"zip_code": ADDRESS["zip_code"], "city": "Orlando"}
    assert "1234" not in detail.text


# Every customer-controlled field holds a canary. Free text pros are meant to read (the
# description, the answers) holds contact-shaped canaries, which must be masked; every other
# field holds a plain canary, which must never appear at all.
PROVENANCE_ADDRESS = {
    "line1": "1234 Canary-Line-One Ave",
    "line2": "Canary-Line-Two Apt 9",
    "city": "Canary-City",
    "state": "FL",
    "zip_code": ADDRESS["zip_code"],
}
PROVENANCE_UTM = {
    "source": "canary-utm-source",
    "medium": "canary-utm-medium",
    "campaign": "canary-utm-campaign",
    "term": "canary-utm-term",
    "content": "canary-utm-content",
}
PROVENANCE_NAMES = {"first_name": "Canaryfirst", "last_name": "Canarylast"}
PROVENANCE_TEXT = (
    "Leak at 1234 canary-line-one ave, call 305 555 0142 or mail canary-mail@example.invalid"
)
PROVENANCE_CANARIES = (
    "Canary-Line-One",
    "canary-line-one",
    "Canary-Line-Two",
    "Canary-City",
    "canary-utm",
    "Canaryfirst",
    "Canarylast",
    "canary-mail",
    "0142",
    "canary-account@example.invalid",
    "5550143",
)


async def test_no_customer_controlled_field_reaches_a_pro(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    customer = await make_caller(db_session)
    await db_session.execute(
        update(User)
        .where(User.id == customer.id)
        .values(email="canary-account@example.invalid", phone="+13055550143", **PROVENANCE_NAMES)
    )
    category_id = await make_category(db_session, questions=QUESTIONS)
    created = await create(
        db_client,
        customer,
        category_id=str(category_id),
        description=PROVENANCE_TEXT,
        intake_answers={"notes": PROVENANCE_TEXT},
        address=PROVENANCE_ADDRESS,
        utm=PROVENANCE_UTM,
    )
    assert created.status_code == 201, created.text
    request_id = uuid.UUID(created.json()["id"])
    await RequestStateMachine(db_session).transition(request_id, RequestStatus.FINDING_PRO, SYSTEM)
    pro = await make_pro(db_session)
    dispatch_id = await dispatch(db_session, request_id, pro)

    listing, detail = await pro_reads(db_client, pro, dispatch_id)

    for response in (listing, detail):
        for canary in PROVENANCE_CANARIES:
            assert canary.lower() not in response.text.lower(), canary
    assert detail.json()["location"] == {"zip_code": ADDRESS["zip_code"], "city": "Orlando"}
    assert detail.json()["text_redacted"] is True
