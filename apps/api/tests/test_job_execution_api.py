"""The pro's steps on a paid job (D12.2, #63): On my way (ETA + arrival code), check-in with the
customer's code, and start."""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs import execution
from app.modules.jobs.errors import ATTEMPTS_REMAINING_HEADER
from app.modules.jobs.models import Job, JobStatus
from tests.helpers import fields_holding
from tests.job_world import JobWorld, build_world, events, job_row, make_job, record_pushes
from tests.test_requests_api import RecordingQueue

BASE = "/v1/pros/me/jobs"
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
INVALID_TRANSITION = {
    "error": {
        "code": "invalid_transition",
        "message": "The job cannot move to that status from its current one.",
    }
}
CHECK_IN_REQUIRED = {
    "error": {
        "code": "check_in_required",
        "message": "Check in with the customer's arrival code before starting the job.",
    }
}
LOCKED = {
    "error": {
        "code": "arrival_code_locked",
        "message": "Too many wrong arrival codes. Support has been alerted.",
    }
}
CODE = "0427"
WRONG = "9999"
HERE = {"lat": 28.538336, "lng": -81.379234}


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The job pushes (#65) are queued here, never on Redis."""
    return record_pushes(app)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


async def on_the_way_job(session: AsyncSession, world: JobWorld, **fields: Any) -> Job:
    fields.setdefault("arrival_code", CODE)
    fields.setdefault("eta_at", datetime.now(UTC) + timedelta(minutes=30))
    return await make_job(session, world, JobStatus.ON_THE_WAY, **fields)


def post(
    client: httpx.AsyncClient, job_id: uuid.UUID, step: str, headers: dict[str, str], **body: Any
) -> Any:
    return client.post(f"{BASE}/{job_id}/{step}", json=body or None, headers=headers)


async def customer_view(client: httpx.AsyncClient, world: JobWorld, job: Job) -> dict[str, Any]:
    response = await client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# On my way


def _leaves(value: object) -> list[object]:
    """Every scalar in a JSON body."""
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in _leaves(item)]
    if isinstance(value, list):
        return [leaf for item in value for leaf in _leaves(item)]
    return [value]


async def test_on_the_way_sets_eta_and_issues_a_code(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pinned to the scheduled year (START is in 2030), so a substring check of the whole body
    # would fail although no field holds the code; the CSPRNG has its own test below.
    monkeypatch.setattr("app.modules.jobs.execution.secrets.randbelow", lambda _: 2030)
    job = await make_job(db_session, world, arrival_code_attempts=3)
    before = datetime.now(UTC)

    response = await post(db_client, job.id, "on-the-way", world.pro.headers, eta_minutes=30)

    assert response.status_code == 200, response.text
    row = await job_row(db_session, job.id)
    assert row.status is JobStatus.ON_THE_WAY
    assert row.eta_at is not None
    assert before + timedelta(minutes=30) <= row.eta_at <= datetime.now(UTC) + timedelta(minutes=30)
    assert row.arrival_code == "2030"
    assert row.arrival_code_attempts == 0
    assert row.arrival_code_locked_at is None
    [moved] = [e for e in await events(db_session, job.id) if e.type == "status_changed"]
    assert (moved.type, moved.from_status, moved.to_status) == (
        "status_changed",
        JobStatus.SCHEDULED,
        JobStatus.ON_THE_WAY,
    )
    assert moved.actor_id == world.pro.id
    # The pro sees the ETA, never the code; the customer sees both.
    body = response.json()
    assert body["status"] == "on_the_way"
    assert datetime.fromisoformat(body["eta_at"]) == row.eta_at
    assert "arrival_code" not in body
    # No field holds the code; the scheduled start (2030-...) is not a code field.
    assert row.arrival_code not in [str(leaf) for leaf in _leaves(body)]
    assert body["scheduled_start_at"].startswith("2030-")
    view = await customer_view(db_client, world, job)
    assert view["arrival_code"] == row.arrival_code
    assert view["customer_status"] == "customerStatus.professionalOnTheWay"
    assert datetime.fromisoformat(view["eta_at"]) == row.eta_at


async def test_the_code_comes_from_the_csprng_with_leading_zeros(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    draws: list[int] = []

    def randbelow(bound: int) -> int:
        draws.append(bound)
        return 7

    monkeypatch.setattr("app.modules.jobs.execution.secrets.randbelow", randbelow)

    assert execution.new_arrival_code() == "0007"
    assert draws == [10_000]


async def test_repeat_on_the_way_updates_only_the_eta(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world)
    await post(db_client, job.id, "on-the-way", world.pro.headers, eta_minutes=30)
    first = await job_row(db_session, job.id)
    code, first_eta = first.arrival_code, first.eta_at
    assert first_eta is not None

    response = await post(db_client, job.id, "on-the-way", world.pro.headers, eta_minutes=60)

    assert response.status_code == 200, response.text
    row = await job_row(db_session, job.id)
    assert row.status is JobStatus.ON_THE_WAY
    assert row.arrival_code == code
    assert row.eta_at is not None
    assert row.eta_at >= first_eta + timedelta(minutes=29)
    history = await events(db_session, job.id)
    assert sorted(e.type for e in history) == ["created", "eta_updated", "status_changed"]
    [updated] = [e for e in history if e.type == "eta_updated"]
    assert (updated.from_status, updated.to_status, updated.actor_id) == (None, None, world.pro.id)
    assert (updated.lat, updated.lng) == (None, None)


@pytest.mark.parametrize("eta", [4, 241, 0, -5, "30", 30.5, None, True])
async def test_on_the_way_needs_an_eta_from_5_to_240_minutes(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, eta: object
) -> None:
    job = await make_job(db_session, world)

    response = await post(db_client, job.id, "on-the-way", world.pro.headers, eta_minutes=eta)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert (await job_row(db_session, job.id)).status is JobStatus.SCHEDULED


async def test_on_the_way_accepts_the_bounds(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    for eta in (5, 240):
        job = await make_job(db_session, world)
        response = await post(db_client, job.id, "on-the-way", world.pro.headers, eta_minutes=eta)
        assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "status",
    [
        JobStatus.IN_PROGRESS,
        JobStatus.COMPLETED,
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        JobStatus.DISPUTED,
        JobStatus.REFUNDED,
        JobStatus.CANCELLED,
    ],
)
async def test_on_the_way_from_other_states_is_409(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)

    response = await post(db_client, job.id, "on-the-way", world.pro.headers, eta_minutes=30)

    assert (response.status_code, response.json()) == (409, INVALID_TRANSITION)
    row = await job_row(db_session, job.id)
    assert (row.status, row.eta_at, row.arrival_code) == (status, None, None)
    assert len(await events(db_session, job.id)) == 1


# Check-in


async def test_check_in_with_the_right_code_records_location(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await on_the_way_job(db_session, world, arrival_code_attempts=2)

    response = await post(
        db_client, job.id, "check-in", world.pro.headers, arrival_code=CODE, **HERE
    )

    assert response.status_code == 200, response.text
    row = await job_row(db_session, job.id)
    assert row.status is JobStatus.ON_THE_WAY
    assert row.checked_in_at is not None
    assert row.arrival_code is None
    # One test transaction: every event has its now(), so they are matched by type.
    [checked_in] = [e for e in await events(db_session, job.id) if e.type != "created"]
    assert checked_in.type == "checked_in"
    assert (checked_in.from_status, checked_in.to_status) == (None, None)
    assert checked_in.actor_id == world.pro.id
    assert (checked_in.lat, checked_in.lng) == (Decimal("28.538336"), Decimal("-81.379234"))
    assert datetime.fromisoformat(response.json()["checked_in_at"]) == row.checked_in_at
    # The code is no longer shown to the customer; the timeline has the check-in, no location.
    view = await customer_view(db_client, world, job)
    assert view["arrival_code"] is None
    assert sorted(e["type"] for e in view["timeline"]) == ["checked_in", "created"]
    # Field by field, ids and clocks masked: a time like 12:00:28.531 spells "28.53" (#387).
    assert fields_holding("28.53", view) == []


async def test_check_in_is_idempotent_afterwards(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await on_the_way_job(db_session, world)
    first = await post(db_client, job.id, "check-in", world.pro.headers, arrival_code=CODE, **HERE)
    checked_in_at = (await job_row(db_session, job.id)).checked_in_at

    # Again, even with another code: the check-in stands, nothing is counted or written.
    again = await post(db_client, job.id, "check-in", world.pro.headers, arrival_code=WRONG, **HERE)

    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()
    row = await job_row(db_session, job.id)
    assert (row.checked_in_at, row.arrival_code_attempts) == (checked_in_at, 0)
    assert len(await events(db_session, job.id)) == 2


async def test_wrong_code_counts_down(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await on_the_way_job(db_session, world)

    for remaining in (4, 3, 2, 1):
        response = await post(
            db_client, job.id, "check-in", world.pro.headers, arrival_code=WRONG, **HERE
        )
        assert response.status_code == 422
        assert response.json() == {
            "error": {
                "code": "arrival_code_invalid",
                "message": f"The arrival code is not right. Tries left: {remaining}.",
            }
        }
        assert response.headers[ATTEMPTS_REMAINING_HEADER] == str(remaining)

    row = await job_row(db_session, job.id)
    assert (row.arrival_code_attempts, row.arrival_code_locked_at) == (4, None)
    assert (row.checked_in_at, row.arrival_code) == (None, CODE)
    assert len(await events(db_session, job.id)) == 1
    # The right code still works on the last try.
    ok = await post(db_client, job.id, "check-in", world.pro.headers, arrival_code=CODE, **HERE)
    assert ok.status_code == 200, ok.text


async def test_fifth_wrong_code_locks_and_alerts(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await on_the_way_job(db_session, world)
    before = await customer_view(db_client, world, job)
    for _ in range(4):
        await post(db_client, job.id, "check-in", world.pro.headers, arrival_code=WRONG, **HERE)

    with caplog.at_level(logging.INFO):
        fifth = await post(
            db_client, job.id, "check-in", world.pro.headers, arrival_code=WRONG, **HERE
        )
        right = await post(
            db_client, job.id, "check-in", world.pro.headers, arrival_code=CODE, **HERE
        )

    assert (fifth.status_code, fifth.json()) == (423, LOCKED)
    assert (right.status_code, right.json()) == (423, LOCKED)
    row = await job_row(db_session, job.id)
    assert row.arrival_code_attempts == 5
    assert row.arrival_code_locked_at is not None
    assert row.checked_in_at is None
    # One ERROR for the BDC, the job id only.
    [alert] = [r for r in caplog.records if r.getMessage() == "arrival_code_locked"]
    assert alert.levelno == logging.ERROR
    assert alert.__dict__["job_id"] == str(job.id)
    assert "pro_id" not in alert.__dict__
    # The customer's view shows nothing new; the pro's shows the lock.
    assert await customer_view(db_client, world, job) == before
    mine = await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers)
    assert mine.json()["arrival_code_locked"] is True
    # Start stays refused: no check-in.
    start = await post(db_client, job.id, "start", world.pro.headers)
    assert (start.status_code, start.json()) == (409, CHECK_IN_REQUIRED)


async def test_the_attempt_limit_comes_from_settings(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
) -> None:
    app.state.settings = app.state.settings.model_copy(update={"arrival_code_max_attempts": 2})
    job = await on_the_way_job(db_session, world)

    first = await post(db_client, job.id, "check-in", world.pro.headers, arrival_code=WRONG, **HERE)
    second = await post(
        db_client, job.id, "check-in", world.pro.headers, arrival_code=WRONG, **HERE
    )

    assert first.headers[ATTEMPTS_REMAINING_HEADER] == "1"
    assert second.status_code == 423


@pytest.mark.parametrize(
    "body",
    [
        {"arrival_code": "12a4", **HERE},
        {"arrival_code": "12345", **HERE},
        {"arrival_code": "123", **HERE},
        {"arrival_code": "١٢٣٤", **HERE},  # Arabic-Indic digits are not the code's digits
        {"arrival_code": 1234, **HERE},
        {"arrival_code": CODE, "lat": 90.5, "lng": 0},
        {"arrival_code": CODE, "lat": 0, "lng": -180.5},
        {"arrival_code": CODE, "lat": 0},
        {"arrival_code": CODE, **HERE, "checked_in_at": "2026-11-06T00:00:00Z"},
    ],
)
async def test_check_in_validation_counts_no_try(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, body: dict[str, Any]
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await post(db_client, job.id, "check-in", world.pro.headers, **body)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    row = await job_row(db_session, job.id)
    assert (row.arrival_code_attempts, row.checked_in_at) == (0, None)


@pytest.mark.parametrize(
    "status", [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS, JobStatus.CANCELLED]
)
async def test_check_in_needs_a_job_on_the_way(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status, arrival_code=CODE)

    response = await post(
        db_client, job.id, "check-in", world.pro.headers, arrival_code=CODE, **HERE
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "not_on_the_way"
    assert (await job_row(db_session, job.id)).checked_in_at is None


# Start


async def test_start_requires_check_in(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    on_the_way = await on_the_way_job(db_session, world)
    scheduled = await make_job(db_session, world)

    for job in (on_the_way, scheduled):
        response = await post(db_client, job.id, "start", world.pro.headers)
        assert (response.status_code, response.json()) == (409, CHECK_IN_REQUIRED)
        row = await job_row(db_session, job.id)
        assert row.status is not JobStatus.IN_PROGRESS
        assert row.started_at is None


async def test_start_sets_started_at(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await on_the_way_job(db_session, world)
    await post(db_client, job.id, "check-in", world.pro.headers, arrival_code=CODE, **HERE)
    response = await post(db_client, job.id, "start", world.pro.headers)

    assert response.status_code == 200, response.text
    row = await job_row(db_session, job.id)
    assert row.status is JobStatus.IN_PROGRESS
    assert row.started_at is not None
    # The transaction's start time in this rolled-back test session: not after now.
    assert row.started_at <= datetime.now(UTC)
    assert response.json()["status"] == "in_progress"
    assert response.json()["started_at"] is not None
    [last] = [e for e in await events(db_session, job.id) if e.to_status is JobStatus.IN_PROGRESS]
    assert (last.type, last.from_status, last.to_status, last.actor_id) == (
        "status_changed",
        JobStatus.ON_THE_WAY,
        JobStatus.IN_PROGRESS,
        world.pro.id,
    )
    view = await customer_view(db_client, world, job)
    assert view["customer_status"] == "customerStatus.inProgress"
    assert "in_progress" in [e["status"] for e in view["timeline"]]


async def test_start_again_is_409(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS, checked_in_at=datetime.now(UTC))

    response = await post(db_client, job.id, "start", world.pro.headers)

    assert (response.status_code, response.json()) == (409, INVALID_TRANSITION)


# Who may act

STEPS: list[tuple[str, dict[str, Any]]] = [
    ("on-the-way", {"eta_minutes": 30}),
    ("check-in", {"arrival_code": CODE, **HERE}),
    ("start", {}),
]


@pytest.mark.parametrize(("step", "body"), STEPS, ids=[s for s, _ in STEPS])
async def test_another_pros_job_is_404_and_unchanged(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    step: str,
    body: dict[str, Any],
) -> None:
    job = await on_the_way_job(db_session, world, checked_in_at=None)

    for headers in (world.other_pro.headers, world.pro_without_profile.headers):
        response = await post(db_client, job.id, step, headers, **body)
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
    unknown = await post(db_client, uuid.uuid4(), step, world.pro.headers, **body)
    assert (unknown.status_code, unknown.json()) == (404, NOT_FOUND)
    row = await job_row(db_session, job.id)
    assert (row.status, row.arrival_code, row.arrival_code_attempts) == (
        JobStatus.ON_THE_WAY,
        CODE,
        0,
    )
    assert row.checked_in_at is None
    assert len(await events(db_session, job.id)) == 1


@pytest.mark.parametrize(("step", "body"), STEPS, ids=[s for s, _ in STEPS])
@pytest.mark.parametrize("role", ["customer", "agent", "admin"])
async def test_only_pros_take_the_steps(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    step: str,
    body: dict[str, Any],
    role: str,
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await post(db_client, job.id, step, getattr(world, role).headers, **body)

    assert (response.status_code, response.json()) == (403, FORBIDDEN)
    assert (await job_row(db_session, job.id)).arrival_code_attempts == 0


@pytest.mark.parametrize(("step", "body"), STEPS, ids=[s for s, _ in STEPS])
async def test_unauthenticated_steps_are_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, step: str, body: Any
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await post(db_client, job.id, step, {}, **body)

    assert response.status_code == 401
