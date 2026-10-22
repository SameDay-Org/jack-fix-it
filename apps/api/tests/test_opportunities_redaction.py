"""Contacts typed into a request never reach a pro before payment (#172, Vault round 1).

End to end: the request is created through POST /v1/requests by a customer whose account holds
the canary email and phone, at the canary street, then dispatched; the pro's feed and detail
are checked on their serialized values. The customer's own view keeps the text as written.
"""

import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import get_storage
from app.modules.categories.models import Category
from app.modules.jobs.service import SYSTEM
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter
from app.redaction import MASK
from tests.conftest import InMemoryRateLimiter
from tests.test_intake_questions import labels, option
from tests.test_opportunities_api import BASE, Pro, dispatch, make_pro
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
) -> tuple[Caller, Pro, uuid.UUID, uuid.UUID, uuid.UUID]:
    """A request created through the API, moved to finding_pro and dispatched to a new pro."""
    customer = await make_caller(session)
    await session.execute(
        update(User).where(User.id == customer.id).values(email=EMAIL, phone=PHONE)
    )
    category_id = await make_category(session, questions=QUESTIONS)
    response = await create(
        client,
        customer,
        category_id=str(category_id),
        description=description,
        intake_answers=answers or {},
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
    assert body["description"] == f"{MASK}; call {MASK}; repair the sink at {MASK}."
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
        "notes": f"{MASK}; call {MASK}; repair the sink at {MASK}.",
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
