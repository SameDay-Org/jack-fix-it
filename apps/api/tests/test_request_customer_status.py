"""What the customer's own request views show once the request is paid (#466): its job's
customer status, as app/modules/requests/customer_status.py says ("the job's status takes
over") and the staff queue already shows it. Before the payment, and without a job, the
request's own status."""

import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import JobStatus
from app.modules.jobs.transitions import CUSTOMER_STATUS
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.models import RequestStatus
from app.queue import get_job_queue
from tests.job_world import JobWorld, build_world, make_accepted_request, make_job
from tests.test_disputes_api import FakeStorage, RecordingQueue


@pytest.fixture
async def world(app: FastAPI, db_session: AsyncSession) -> JobWorld:
    app.state.storage = FakeStorage()
    app.dependency_overrides[get_job_queue] = RecordingQueue
    return await build_world(db_session)


async def shown(
    client: httpx.AsyncClient, world: JobWorld, request_id: uuid.UUID
) -> tuple[dict[str, str], dict[str, str]]:
    """(the list item, the detail) of the request, as its customer reads them."""
    listed = await client.get("/v1/requests", headers=world.customer.headers)
    detail = await client.get(f"/v1/requests/{request_id}", headers=world.customer.headers)
    assert (listed.status_code, detail.status_code) == (200, 200), (listed.text, detail.text)
    [item] = [i for i in listed.json()["items"] if i["id"] == str(request_id)]
    return item, detail.json()


@pytest.mark.parametrize("status", list(JobStatus))
async def test_a_paid_request_shows_its_job_s_status_on_the_list_and_the_detail(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
) -> None:
    """A confirmed job reads Completed, a disputed one Needs Attention, and so on: never
    Quote Ready, the accepted request's own key. The request's raw status stays accepted."""
    job = await make_job(db_session, world, status)
    await db_session.commit()

    item, detail = await shown(db_client, world, job.request_id)

    for view in (item, detail):
        assert view["customer_status"] == CUSTOMER_STATUS[status]
        assert view["status"] == RequestStatus.ACCEPTED.value
    assert CUSTOMER_STATUS[status] != REQUEST_CUSTOMER_STATUS[RequestStatus.ACCEPTED]


async def test_a_request_without_a_job_shows_its_own_status(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    """Accepted and not paid yet: still the quote screen's key; and a request beside a paid
    one on the same page keeps its own."""
    request, _ = await make_accepted_request(db_session, world, world.pro)
    paid = await make_job(db_session, world, JobStatus.CONFIRMED)
    await db_session.commit()

    unpaid_item, unpaid_detail = await shown(db_client, world, request.id)
    paid_item, _ = await shown(db_client, world, paid.request_id)

    assert (
        unpaid_item["customer_status"]
        == unpaid_detail["customer_status"]
        == (REQUEST_CUSTOMER_STATUS[RequestStatus.ACCEPTED])
    )
    assert paid_item["customer_status"] == CUSTOMER_STATUS[JobStatus.CONFIRMED]
