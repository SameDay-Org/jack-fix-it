"""#96 skeptic repro: a pro's opportunity list redacts every row on the event loop, and the
redactor is quadratic on letter-digit runs ("a1" * 1000, 2000 chars, the description cap).

A customer posts requests through POST /v1/requests (10 per hour per account: two accounts
here), each is dispatched to the same pro, and the pro reads GET /v1/pros/me/opportunities
(default page of 20). The secure property: one list read costs well under a second of this
thread's CPU (the event loop's), whatever the customers typed. The benign case is the control.

Moved into the suite with #528; the unit test is renamed for what it asserts (linear), and a
test that the page's redaction runs in a worker thread is added.
"""

import threading
import time
import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import get_storage
from app.modules.jobs.service import SYSTEM
from app.modules.requests import service as requests_service
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.service_areas.models import ServiceArea
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter
from app.redaction import KnownValues, RedactionResult, redact_text
from tests.conftest import InMemoryRateLimiter
from tests.helpers import async_best_seconds_without_gc, best_seconds_without_gc
from tests.test_opportunities_api import BASE, dispatch, make_pro
from tests.test_requests_api import (
    ADDRESS,
    NOW,
    FakeStorage,
    RecordingQueue,
    create,
    make_caller,
    make_category,
)

ROWS = 20  # request_list_default_limit
PER_ACCOUNT = 10  # request_create_limit per request_create_window_seconds
HOSTILE = "a1" * 1000  # 2000 chars: the description's max_length
BENIGN = ("Water leaks under the kitchen sink, near the cabinet. " * 40)[:2000]
# Twice the 0.25 s read budget the redaction tests give one read (test_opportunities_redaction).
LIST_BUDGET_SECONDS = 0.5


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
async def storage(app: FastAPI, db_session: AsyncSession) -> FakeStorage:
    db_session.add(
        ServiceArea(region="Test Region", city="Orlando", state="FL", zip_code=ADDRESS["zip_code"])
    )
    await db_session.flush()
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return fake


def test_redactor_is_linear_on_letter_digit_runs() -> None:
    """Doubling the run should about double the cost of a linear redactor."""

    def cost(text: str) -> float:
        return best_seconds_without_gc(
            lambda: redact_text(text, KnownValues()), clock=time.perf_counter
        )

    half, full = cost("a1" * 500), cost(HOSTILE)
    assert full / half < 2.5, f"1000 chars {half:.3f} s, 2000 chars {full:.3f} s"


@pytest.mark.parametrize("description", [BENIGN, HOSTILE], ids=["benign", "hostile"])
async def test_one_opportunity_list_read_stays_cheap(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    description: str,
) -> None:
    pro = await make_pro(db_session)
    category_id = await make_category(db_session)
    machine = RequestStateMachine(db_session)
    for _ in range(ROWS // PER_ACCOUNT):
        customer = await make_caller(db_session)
        for _ in range(PER_ACCOUNT):
            response = await create(
                db_client, customer, category_id=str(category_id), description=description
            )
            assert response.status_code == 201, response.text
            request_id = uuid.UUID(response.json()["id"])
            await machine.transition(request_id, RequestStatus.FINDING_PRO, SYSTEM)
            await dispatch(db_session, request_id, pro)

    async def read() -> None:
        response = await db_client.get(BASE, params={"limit": ROWS}, headers=pro.caller.headers)
        assert response.status_code == 200, response.text
        assert len(response.json()["items"]) == ROWS

    seconds = await async_best_seconds_without_gc(read, clock=time.thread_time)

    assert seconds < LIST_BUDGET_SECONDS, (
        f"one list read of {ROWS} rows took {seconds:.3f} s of event-loop CPU"
    )


async def test_the_page_is_redacted_off_the_event_loop(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#528: what a list read still redacts runs in a worker thread, so a page of long texts
    never holds the event loop (the thread the test, and so the app, runs on)."""
    pro = await make_pro(db_session)
    category_id = await make_category(db_session)
    customer = await make_caller(db_session)
    machine = RequestStateMachine(db_session)
    for _ in range(2):
        response = await create(db_client, customer, category_id=str(category_id))
        assert response.status_code == 201, response.text
        request_id = uuid.UUID(response.json()["id"])
        await machine.transition(request_id, RequestStatus.FINDING_PRO, SYSTEM)
        await dispatch(db_session, request_id, pro)
    threads: list[int] = []

    def recording(text: str, known: KnownValues) -> RedactionResult:
        threads.append(threading.get_ident())
        return redact_text(text, known)

    monkeypatch.setattr(requests_service, "redact_text", recording)
    response = await db_client.get(BASE, headers=pro.caller.headers)

    assert response.status_code == 200, response.text
    assert len(response.json()["items"]) == 2
    assert len(threads) >= 2  # one description per row, at least
    assert threading.get_ident() not in threads
