"""The customer confirms a completed job (#66, API): POST /v1/requests/{id}/job/confirm, and the
customer's view carries confirm_by while the job is completed (#67's window)."""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs import execution
from app.modules.jobs.confirmation import confirm_by
from app.modules.jobs.models import Job, JobStatus
from app.modules.requests.models import ServiceRequest
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.job_world import (
    LEAKS,
    JobWorld,
    build_world,
    events,
    job_row,
    make_accepted_request,
    make_job,
    record_pushes,
)
from tests.test_requests_api import EVENTS, RecordingQueue

NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_COMPLETED = {
    "error": {
        "code": "job_not_completed",
        "message": "Only a job marked done and waiting for your confirmation can be confirmed.",
    }
}
# The settings' default (tests/conftest.py builds them without overrides).
WINDOW = timedelta(hours=48)
NOT_CONFIRMABLE = [
    JobStatus.SCHEDULED,
    JobStatus.ON_THE_WAY,
    JobStatus.IN_PROGRESS,
    JobStatus.DISPUTED,
    JobStatus.PAID_OUT,
    JobStatus.REFUNDED,
    JobStatus.CANCELLED,
]


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    EVENTS.clear()
    return record_pushes(app)


@pytest.fixture
def commits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each commit appends to EVENTS, which RecordingQueue reads at every enqueue."""
    commit = AsyncSession.commit

    async def recorded(self: AsyncSession) -> None:
        await commit(self)
        EVENTS.append("commit")

    monkeypatch.setattr(AsyncSession, "commit", recorded)


def confirm_path(job: Job) -> str:
    return f"/v1/requests/{job.request_id}/job/confirm"


def view_path(job: Job) -> str:
    return f"/v1/requests/{job.request_id}/job"


async def completed_job(
    session: AsyncSession, world: JobWorld, completed_at: datetime | None = None
) -> Job:
    completed_at = completed_at or datetime.now(UTC) - timedelta(hours=3)
    return await make_job(session, world, JobStatus.COMPLETED, completed_at=completed_at)


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


async def test_customer_confirms_a_completed_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await completed_job(db_session, world)
    before = datetime.now(UTC)

    response = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(job.id)
    assert body["status"] == "confirmed"
    assert body["customer_status"] == "customerStatus.completed"
    assert body["confirm_by"] is None
    row = await job_row(db_session, job.id)
    assert row.status is JobStatus.CONFIRMED
    assert row.confirmed_at is not None
    assert row.confirmed_at >= before
    # One transaction shares now() here, so the created event may sort either side of it.
    [event] = [e for e in await events(db_session, job.id) if e.type == "status_changed"]
    assert (event.type, event.from_status, event.to_status, event.actor_id) == (
        "status_changed",
        JobStatus.COMPLETED,
        JobStatus.CONFIRMED,
        world.customer.id,
    )
    assert sorted(entry["status"] for entry in body["timeline"]) == ["confirmed", "scheduled"]


async def test_confirming_again_answers_the_job_unchanged(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await completed_job(db_session, world)
    first = await db_client.post(confirm_path(job), headers=world.customer.headers)
    confirmed_at = (await job_row(db_session, job.id)).confirmed_at
    count = len(await events(db_session, job.id))

    again = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert again.status_code == 200
    assert again.json() == first.json()
    assert (await job_row(db_session, job.id)).confirmed_at == confirmed_at
    assert len(await events(db_session, job.id)) == count


@pytest.mark.parametrize("status", NOT_CONFIRMABLE)
async def test_confirm_is_refused_unless_the_job_is_completed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)
    count = len(await events(db_session, job.id))

    response = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert response.status_code == 409
    assert response.json() == NOT_COMPLETED
    row = await job_row(db_session, job.id)
    assert (row.status, row.confirmed_at) == (status, None)
    assert len(await events(db_session, job.id)) == count


async def test_another_customers_job_is_not_found(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await completed_job(db_session, world)

    response = await db_client.post(confirm_path(job), headers=world.other_customer.headers)

    assert response.status_code == 404
    assert response.json() == NOT_FOUND
    assert (await job_row(db_session, job.id)).status is JobStatus.COMPLETED


async def test_unknown_request_and_request_without_job_are_not_found(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    request, _ = await make_accepted_request(db_session, world, world.pro)

    for request_id in (uuid.uuid4(), request.id):
        response = await db_client.post(
            f"/v1/requests/{request_id}/job/confirm", headers=world.customer.headers
        )
        assert response.status_code == 404
        assert response.json() == NOT_FOUND


async def test_pro_and_staff_are_forbidden_and_anonymous_unauthorized(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await completed_job(db_session, world)

    for party in (world.pro, world.agent, world.admin):
        response = await db_client.post(confirm_path(job), headers=party.headers)
        assert response.status_code == 403
        assert response.json() == FORBIDDEN
    anonymous = await db_client.post(confirm_path(job))
    assert anonymous.status_code == 401
    assert (await job_row(db_session, job.id)).status is JobStatus.COMPLETED


async def test_view_carries_confirm_by_while_completed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    completed_at = datetime(2030, 1, 15, 16, 45, 12, 345678, tzinfo=UTC)
    job = await completed_job(db_session, world, completed_at=completed_at)

    response = await db_client.get(view_path(job), headers=world.customer.headers)

    assert response.status_code == 200
    assert parse(response.json()["confirm_by"]) == completed_at + WINDOW


@pytest.mark.parametrize("status", [*NOT_CONFIRMABLE, JobStatus.CONFIRMED])
async def test_view_has_no_confirm_by_in_other_statuses(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    # completed_at stays once the job moves on (confirmed, disputed, paid out...).
    job = await make_job(db_session, world, status, completed_at=datetime.now(UTC))

    response = await db_client.get(view_path(job), headers=world.customer.headers)

    assert response.status_code == 200
    assert response.json()["confirm_by"] is None


async def test_confirm_pushes_the_pro_once_after_the_commit(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    commits: None,
) -> None:
    job = await completed_job(db_session, world)
    request = await db_session.get(ServiceRequest, job.request_id)
    assert request is not None

    response = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert response.status_code == 200
    assert queue.jobs == {
        f"push:job_confirmed:{job.id}": (
            "send_push",
            (
                str(world.pro.id),
                f"job_confirmed:{job.id}",
                "push.job_confirmed.title",
                "push.job_confirmed.body",
                {"public_code": request.public_code},
                f"/jobs/{job.id}",
            ),
        )
    }
    assert queue.before == ["commit"]  # queued after the confirm's commit, once
    again = await db_client.post(confirm_path(job), headers=world.customer.headers)
    assert again.status_code == 200
    assert len(queue.before) == 1  # a repeat pushes nothing, not even a deduplicated one


@pytest.mark.parametrize("status", NOT_CONFIRMABLE)
async def test_a_refused_confirm_pushes_nothing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    status: JobStatus,
) -> None:
    job = await make_job(db_session, world, status)

    response = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert response.status_code == 409
    assert queue.before == []


async def test_a_failed_push_enqueue_never_fails_the_confirm(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    broken = RecordingQueue(failure=RedisError("probe-secret-text-66"))
    app.dependency_overrides[get_job_queue] = lambda: broken
    job = await completed_job(db_session, world)

    with caplog.at_level(logging.INFO):
        response = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert response.status_code == 200
    assert response.json()["status"] == "confirmed"
    assert len(broken.before) == 1  # tried once
    [record] = [r for r in caplog.records if r.getMessage() == "push_enqueue_failed"]
    assert record.levelno == logging.ERROR
    assert "probe-secret-text-66" not in caplog.text


def test_confirm_by_follows_the_window() -> None:
    completed_at = datetime(2030, 1, 15, 16, 45, tzinfo=UTC)
    job = Job(status=JobStatus.COMPLETED, completed_at=completed_at)

    assert confirm_by(job, timedelta(hours=24)) == completed_at + timedelta(hours=24)
    assert confirm_by(Job(status=JobStatus.COMPLETED, completed_at=None), WINDOW) is None
    assert confirm_by(Job(status=JobStatus.DISPUTED, completed_at=completed_at), WINDOW) is None


async def test_confirm_logs_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await completed_job(db_session, world)
    caplog.set_level(logging.INFO, logger=execution.__name__)

    response = await db_client.post(confirm_path(job), headers=world.customer.headers)

    assert response.status_code == 200
    [record] = [r for r in caplog.records if r.getMessage() == "job_confirmed"]
    line = json.loads(JsonFormatter().format(record))
    assert line["job_id"] == str(job.id)
    assert line["pro_id"] == str(world.pro.profile_id)
    text = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert not any(leak in text for leak in LEAKS)
