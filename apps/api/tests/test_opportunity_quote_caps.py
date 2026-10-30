"""#258: the platform's quote caps on the pro's opportunity detail, so the quote form can check
before sending. The detail shows the values quote submission enforces (_check_caps)."""

import logging

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.dispatch.models import DispatchStatus
from app.modules.settings.models import Setting
from app.queue import get_job_queue
from tests.conftest import make_settings
from tests.test_opportunities_api import (
    BASE,
    World,
    build_world,
    dispatch,
    dispatch_row,
    listed,
    make_request,
)
from tests.test_quotes_api import CAPS, TTL_HOURS, quote, set_setting
from tests.test_requests_api import ENQUEUE_TIMEOUT, FakeStorage, RecordingQueue

AMOUNT_CAP = 250_000
DURATION_CAP = 480
NOT_CONFIGURED = {
    "error": {"code": "not_configured", "message": "This feature is not configured yet."}
}


@pytest.fixture
def settings() -> Settings:
    return make_settings(job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT)


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The quote pushes' queue (#55): recorded, never Redis."""
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture(autouse=True)
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


@pytest.fixture(autouse=True)
async def quote_settings(db_session: AsyncSession) -> None:
    """The quote TTL, a fixture value; both caps absent (no cap) unless a test stores one. All in
    the rolled-back test session."""
    await set_setting(db_session, "quote_ttl_hours", TTL_HOURS)
    await db_session.execute(delete(Setting).where(Setting.key.in_(CAPS)))


async def set_caps(session: AsyncSession) -> None:
    await set_setting(session, "quote_max_amount_cents", AMOUNT_CAP)
    await set_setting(session, "quote_max_duration_minutes", DURATION_CAP)


async def test_opportunity_detail_shows_quote_caps(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await set_caps(db_session)
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)

    assert response.status_code == 200, response.text
    caps = {key: response.json()[key] for key in CAPS}
    assert caps == {
        "quote_max_amount_cents": AMOUNT_CAP,
        "quote_max_duration_minutes": DURATION_CAP,
    }


async def test_opportunity_detail_quote_caps_null_without_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)

    assert response.status_code == 200, response.text
    assert {key: response.json()[key] for key in CAPS} == dict.fromkeys(CAPS)


@pytest.mark.parametrize("key", CAPS)
async def test_opportunity_detail_malformed_cap_503_and_not_viewed(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    caplog: pytest.LogCaptureFixture,
    key: str,
) -> None:
    await set_caps(db_session)
    await set_setting(db_session, key, "250000")
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    with caplog.at_level(logging.INFO):
        response = await db_client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)

    assert response.status_code == 503
    assert response.json() == NOT_CONFIGURED
    row = await dispatch_row(db_session, dispatch_id)
    assert (row.status, row.viewed_at) == (DispatchStatus.SENT, None)
    messages = [record.message for record in caplog.records]
    assert "opportunity_opened" not in messages
    [invalid] = [r for r in caplog.records if r.message == "setting_invalid"]
    assert invalid.__dict__["key"] == key


async def test_quote_at_the_shown_cap_is_accepted_and_above_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await set_caps(db_session)
    at_caps = await dispatch(db_session, await make_request(db_session, world), world.me)
    over_amount = await dispatch(db_session, await make_request(db_session, world), world.me)
    over_duration = await dispatch(db_session, await make_request(db_session, world), world.me)
    detail = await db_client.get(f"{BASE}/{at_caps}", headers=world.me.caller.headers)
    max_amount = detail.json()["quote_max_amount_cents"]
    max_duration = detail.json()["quote_max_duration_minutes"]

    exact = await quote(
        db_client, world.me, at_caps, amount_cents=max_amount, duration_minutes=max_duration
    )
    too_much = await quote(db_client, world.me, over_amount, amount_cents=max_amount + 1)
    too_long = await quote(db_client, world.me, over_duration, duration_minutes=max_duration + 1)

    assert (exact.status_code, too_much.status_code, too_long.status_code) == (201, 422, 422)
    assert too_much.json()["error"]["code"] == too_long.json()["error"]["code"]
    assert too_much.json()["error"]["code"] == "validation_error"


async def test_opportunity_list_shows_no_quote_caps(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await set_caps(db_session)
    await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await listed(db_client, world.me)

    assert response.status_code == 200, response.text
    assert response.json()["items"]
    assert "quote_max" not in response.text


def test_openapi_caps_are_required_and_nullable(app: FastAPI) -> None:
    schema = app.openapi()["components"]["schemas"]["OpportunityDetail"]

    assert set(CAPS) <= set(schema["required"])
    for key in CAPS:
        field = schema["properties"][key]
        assert {"type": "null"} in field["anyOf"], key
        assert "default" not in field, key
