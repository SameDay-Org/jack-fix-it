"""The Live Activity tokens (#596, PR 2a): POST /v1/jobs/{job_id}/live/token, the customer's."""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.models import Device, DevicePlatform
from app.modules.jobs.models import JobStatus, LiveActivityToken
from tests.job_world import JobWorld, Party, build_world, make_job, record_pushes
from tests.test_pro_location_api import FORBIDDEN, NOT_FOUND
from tests.test_requests_api import RecordingQueue

TOKEN = "a1b2c3d4" * 8  # 64 hex characters, as ActivityKit gives them
NEW_TOKEN = "0f" * 40
NOT_LIVE = {"error": {"code": "job_not_live", "message": "The job is not under way."}}
DEVICE_NOT_FOUND = {
    "error": {
        "code": "device_not_found",
        "message": "No device of yours has this push token. Register the device first.",
    }
}
VALIDATION = {"error": {"code": "validation_error", "message": "The request is invalid."}}


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The job pushes (#65) are queued here, never on Redis."""
    return record_pushes(app)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


def url(job_id: uuid.UUID) -> str:
    return f"/v1/jobs/{job_id}/live/token"


async def a_device(session: AsyncSession, party: Party) -> str:
    """A registered iPhone of `party`; its Expo push token."""
    expo_token = f"ExponentPushToken[live-{uuid.uuid4().hex[:12]}]"
    session.add(
        Device(
            user_id=party.id,
            expo_push_token=expo_token,
            platform=DevicePlatform.IOS,
            last_seen_at=datetime.now(UTC),
        )
    )
    await session.flush()
    return expo_token


def body(expo_token: str, token: str = TOKEN, **extra: Any) -> dict[str, Any]:
    return {"expo_push_token": expo_token, "live_activity_token": token, **extra}


async def send(
    client: httpx.AsyncClient, job_id: uuid.UUID, party: Party, payload: dict[str, Any]
) -> httpx.Response:
    return await client.post(url(job_id), json=payload, headers=party.headers)


async def kept(session: AsyncSession, job_id: uuid.UUID) -> list[tuple[uuid.UUID, str]]:
    rows = await session.execute(
        select(LiveActivityToken.device_id, LiveActivityToken.token)
        .where(LiveActivityToken.job_id == job_id)
        .execution_options(populate_existing=True)
    )
    return [(device_id, token) for device_id, token in rows]


async def device_id_of(session: AsyncSession, expo_token: str) -> uuid.UUID:
    found = await session.scalar(select(Device.id).where(Device.expo_push_token == expo_token))
    assert found is not None
    return found


async def test_the_customer_keeps_one_token_per_job_and_device(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    iphone, ipad = (
        await a_device(db_session, world.customer),
        await a_device(db_session, world.customer),
    )

    with caplog.at_level(logging.DEBUG):
        first = await send(db_client, job.id, world.customer, body(iphone))
        again = await send(db_client, job.id, world.customer, body(iphone, NEW_TOKEN))
        other = await send(db_client, job.id, world.customer, body(ipad))

    for response in (first, again, other):
        assert response.status_code == 204, response.text
        assert response.content == b""
    # One row per device: the activity's new token replaced the old one.
    assert sorted(await kept(db_session, job.id)) == sorted(
        [
            (await device_id_of(db_session, iphone), NEW_TOKEN),
            (await device_id_of(db_session, ipad), TOKEN),
        ]
    )
    # The logs name the job and the device, never a token.
    output = "\n".join(record.getMessage() + str(record.__dict__) for record in caplog.records)
    assert "live_activity_token_kept" in output
    for secret in (TOKEN, NEW_TOKEN, iphone, ipad):
        assert secret not in output


@pytest.mark.parametrize(
    "status",
    [JobStatus.ON_THE_WAY, JobStatus.IN_PROGRESS, JobStatus.COMPLETED],
)
async def test_any_stage_under_way_takes_a_token(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)
    response = await send(
        db_client, job.id, world.customer, body(await a_device(db_session, world.customer))
    )
    assert response.status_code == 204, response.text


@pytest.mark.parametrize(
    "status",
    [JobStatus.SCHEDULED, JobStatus.CONFIRMED, JobStatus.CANCELLED, JobStatus.DISPUTED],
)
async def test_a_job_not_under_way_is_409(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)

    response = await send(
        db_client, job.id, world.customer, body(await a_device(db_session, world.customer))
    )

    assert (response.status_code, response.json()) == (409, NOT_LIVE)
    assert await kept(db_session, job.id) == []


async def test_only_the_jobs_customer(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    stranger = await a_device(db_session, world.other_customer)

    not_theirs = await send(db_client, job.id, world.other_customer, body(stranger))
    unknown = await send(db_client, uuid.uuid4(), world.customer, body(stranger))
    roles = [
        await send(db_client, job.id, party, body(stranger))
        for party in (world.pro, world.agent, world.admin)
    ]
    anonymous = await db_client.post(url(job.id), json=body(stranger))

    assert (not_theirs.status_code, not_theirs.json()) == (404, NOT_FOUND)
    assert (unknown.status_code, unknown.json()) == (404, NOT_FOUND)
    for response in roles:
        assert (response.status_code, response.json()) == (403, FORBIDDEN)
    assert anonymous.status_code == 401
    assert await kept(db_session, job.id) == []


async def test_the_device_must_be_the_callers(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    """Another user's device, or a push token no device has: 404 device_not_found."""
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    someone_elses = await a_device(db_session, world.other_customer)

    for expo_token in (someone_elses, "ExponentPushToken[never-registered]"):
        response = await send(db_client, job.id, world.customer, body(expo_token))
        assert (response.status_code, response.json()) == (404, DEVICE_NOT_FOUND)
    assert await kept(db_session, job.id) == []


@pytest.mark.parametrize(
    "payload",
    [
        {"live_activity_token": "zz" * 32},  # not hex
        {"live_activity_token": "ab" * 15},  # 30 characters: under 32
        {"live_activity_token": "ab" * 257},  # 514 characters: over 512
        {"expo_push_token": "not-an-expo-token"},
        {"extra": "field"},
    ],
    ids=["not_hex", "too_short", "too_long", "bad_expo_token", "unknown_field"],
)
async def test_a_token_of_the_wrong_shape_is_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    payload: dict[str, Any],
) -> None:
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    response = await send(
        db_client,
        job.id,
        world.customer,
        {**body(await a_device(db_session, world.customer)), **payload},
    )
    assert (response.status_code, response.json()) == (422, VALIDATION)


async def test_the_devices_delete_takes_its_tokens(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.ON_THE_WAY)
    iphone = await a_device(db_session, world.customer)
    assert (await send(db_client, job.id, world.customer, body(iphone))).status_code == 204

    await db_session.execute(delete(Device).where(Device.expo_push_token == iphone))

    assert await kept(db_session, job.id) == []
