"""Stripe's account.updated keeps a pro's payouts_enabled current (D7.2, #280).

The worker side runs process_stripe_event on committed rows, as the worker does, with the
handler bound to a fake Stripe Connect client that answers the account's state now and records
every read. The receiving side posts signed bodies to POST /v1/webhooks/stripe/connect, the
Connect endpoint, whose signing secret is its own.
"""

import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from arq import Retry
from fastapi import FastAPI
from sqlalchemy import URL, delete, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.integrations import stripe_connect
from app.integrations.stripe_connect import (
    AccountState,
    StripeExpressConnect,
    StripeRejectedError,
    StripeUnavailableError,
)
from app.modules.payouts.webhook_handlers import (
    ACCOUNT_UPDATED,
    account_updated_handler,
)
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.modules.webhooks import handlers
from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus
from app.modules.webhooks.service import WebhookConfig
from app.modules.webhooks.tasks import process_stripe_event
from tests.conftest import make_settings
from tests.test_requests_api import RecordingQueue
from tests.test_stripe_webhooks_api import _serving, sign

PLATFORM_SECRET = "whsec_test_platform_fixture_not_real"
CONNECT_SECRET = "whsec_test_connect_fixture_not_real_280"
CONNECT_PATH = "/v1/webhooks/stripe/connect"
PLATFORM_PATH = "/v1/webhooks/stripe"


@dataclass
class FakeConnect:
    """retrieve_account answers `enabled` as Stripe's state now; `errors` are raised first, in
    order; `on_retrieve` runs inside the read."""

    enabled: bool = True
    retrieved: list[str] = field(default_factory=list)
    errors: list[Exception] = field(default_factory=list)
    on_retrieve: Callable[[], Awaitable[None]] | None = None

    async def retrieve_account(self, account_id: str) -> AccountState:
        self.retrieved.append(account_id)
        if self.on_retrieve is not None:
            await self.on_retrieve()
        if self.errors:
            raise self.errors.pop(0)
        return AccountState(
            details_submitted=True, payouts_enabled=self.enabled, requirements_due=False
        )


@dataclass
class World:
    sessions: async_sessionmaker[AsyncSession]
    account_id: str
    pro_id: uuid.UUID
    user_id: uuid.UUID
    event_rows: list[uuid.UUID]

    async def payouts_enabled(self) -> bool:
        async with self.sessions() as session:
            value = await session.scalar(
                select(ProProfile.payouts_enabled).where(ProProfile.id == self.pro_id)
            )
        assert value is not None
        return value

    async def set_profile(self, **values: object) -> None:
        async with self.sessions() as session:
            profile = await session.get(ProProfile, self.pro_id)
            assert profile is not None
            for name, value in values.items():
                setattr(profile, name, value)
            await session.commit()

    async def add_event(
        self,
        *,
        account: object = None,
        payouts_enabled_in_payload: bool = False,
        object_kind: str = "account",
        object_id: object = None,
    ) -> tuple[uuid.UUID, str]:
        """A stored, pending account.updated event (as the route stores it); its row id and
        Stripe event id."""
        event_id = f"evt_test_{uuid.uuid4().hex}"
        connected = self.account_id if account is None else account
        payload = {
            "id": event_id,
            "object": "event",
            "type": ACCOUNT_UPDATED,
            "account": connected,
            "data": {
                "object": {
                    "id": connected if object_id is None else object_id,
                    "object": object_kind,
                    # What the event says; the handler must read Stripe instead.
                    "payouts_enabled": payouts_enabled_in_payload,
                }
            },
        }
        row = WebhookEvent(
            stripe_event_id=event_id,
            event_type=ACCOUNT_UPDATED,
            livemode=False,
            stripe_created_at=datetime(2026, 11, 16, tzinfo=UTC),
            status=WebhookEventStatus.PENDING,
            attempts=0,
            payload=payload,
        )
        async with self.sessions() as session:
            session.add(row)
            await session.commit()
        self.event_rows.append(row.id)
        return row.id, event_id

    async def event_row(self, row_id: uuid.UUID) -> WebhookEvent:
        async with self.sessions() as session:
            row = await session.get(WebhookEvent, row_id)
        assert row is not None
        return row


@pytest.fixture
async def world(test_database_url: URL) -> AsyncIterator[World]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    tag = uuid.uuid4().hex[:12]
    async with sessions() as session:
        user = User(email=f"p280-{tag}@x.com", password_hash="x", role=UserRole.PRO)
        session.add(user)
        await session.flush()
        profile = ProProfile(
            user_id=user.id,
            stripe_account_id=f"acct_probe280{tag}",
            payouts_enabled=False,
            verification_status=ProVerificationStatus.APPROVED,
        )
        session.add(profile)
        await session.commit()
    rows: list[uuid.UUID] = []
    try:
        yield World(sessions, f"acct_probe280{tag}", profile.id, user.id, rows)
    finally:
        async with sessions() as session:
            await session.execute(delete(WebhookEvent).where(WebhookEvent.id.in_(rows)))
            await session.execute(delete(ProProfile).where(ProProfile.id == profile.id))
            await session.execute(delete(User).where(User.id == user.id))
            await session.commit()
        await engine.dispose()


@pytest.fixture
def stripe(monkeypatch: pytest.MonkeyPatch) -> FakeConnect:
    fake = FakeConnect()
    monkeypatch.setitem(handlers.HANDLERS, ACCOUNT_UPDATED, account_updated_handler(lambda: fake))
    return fake


@dataclass
class PushQueue(RecordingQueue):
    """Records each push and whether payouts_enabled was already committed when it was queued."""

    world: World | None = None
    committed_at_enqueue: list[bool] = field(default_factory=list)

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        if self.world is not None:
            self.committed_at_enqueue.append(await self.world.payouts_enabled())
        return await super().enqueue_job(function, *args, _job_id=_job_id)


def ctx(world: World, queue: PushQueue, *, job_try: int = 1) -> dict[str, Any]:
    return {
        "settings": make_settings(),
        "session_factory": world.sessions,
        "job_try": job_try,
        "redis": queue,
    }


def pushes(queue: PushQueue) -> list[str]:
    return [job_id for job_id in queue.jobs if job_id.startswith("push:payouts_enabled:")]


def rendered(caplog: pytest.LogCaptureFixture) -> str:
    return caplog.text + "".join(str(r.__dict__) for r in caplog.records)


# The worker side.


async def test_payouts_turned_on_for_an_approved_pro_are_announced_once_after_the_commit(
    world: World, stripe: FakeConnect, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    queue = PushQueue(world=world)
    row_id, event_id = await world.add_event()

    assert await process_stripe_event(ctx(world, queue), str(row_id)) == "processed"

    assert await world.payouts_enabled() is True
    assert stripe.retrieved == [world.account_id]
    assert pushes(queue) == [f"push:payouts_enabled:{event_id}"]
    # Queued once the change was committed, never before.
    assert queue.committed_at_enqueue == [True]
    [changed] = [r for r in caplog.records if r.getMessage() == "payouts_enabled_changed"]
    assert (changed.__dict__["pro_id"], changed.__dict__["payouts_enabled"]) == (
        str(world.pro_id),
        True,
    )
    assert world.account_id not in rendered(caplog)

    # The same event again (a redelivery, a second run): handled once.
    assert await process_stripe_event(ctx(world, queue), str(row_id)) == "skipped"
    # Another event while nothing changed: read, nothing stored, nobody told.
    again, _ = await world.add_event()
    assert await process_stripe_event(ctx(world, queue), str(again)) == "processed"
    assert len(stripe.retrieved) == 2
    assert len(pushes(queue)) == 1


async def test_payouts_turned_on_for_a_pro_not_approved_are_stored_but_not_announced(
    world: World, stripe: FakeConnect
) -> None:
    await world.set_profile(verification_status=ProVerificationStatus.PENDING)
    queue = PushQueue()
    row_id, _ = await world.add_event()

    assert await process_stripe_event(ctx(world, queue), str(row_id)) == "processed"

    assert await world.payouts_enabled() is True
    assert pushes(queue) == []


async def test_payouts_turned_off_again_are_stored_and_not_announced(
    world: World, stripe: FakeConnect, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    await world.set_profile(payouts_enabled=True)
    stripe.enabled = False
    queue = PushQueue()
    row_id, _ = await world.add_event(payouts_enabled_in_payload=True)

    assert await process_stripe_event(ctx(world, queue), str(row_id)) == "processed"

    assert await world.payouts_enabled() is False
    assert pushes(queue) == []
    [changed] = [r for r in caplog.records if r.getMessage() == "payouts_enabled_changed"]
    assert changed.__dict__["payouts_enabled"] is False


@pytest.mark.parametrize(("in_payload", "in_stripe"), [(False, True), (True, False)])
async def test_the_state_read_from_stripe_wins_over_the_event(
    world: World, stripe: FakeConnect, in_payload: bool, in_stripe: bool
) -> None:
    """An old event arriving after a newer state (or a payload that says otherwise): the
    stored value is what Stripe says now."""
    await world.set_profile(payouts_enabled=in_payload)
    stripe.enabled = in_stripe
    queue = PushQueue()
    row_id, _ = await world.add_event(payouts_enabled_in_payload=in_payload)

    assert await process_stripe_event(ctx(world, queue), str(row_id)) == "processed"

    assert await world.payouts_enabled() is in_stripe


async def test_an_account_no_pro_holds_is_acknowledged(
    world: World, stripe: FakeConnect, caplog: pytest.LogCaptureFixture
) -> None:
    unknown = f"acct_probe280unknown{uuid.uuid4().hex[:8]}"
    queue = PushQueue()
    row_id, event_id = await world.add_event(account=unknown)

    assert await process_stripe_event(ctx(world, queue), str(row_id)) == "processed"

    assert stripe.retrieved == []
    assert await world.payouts_enabled() is False
    [record] = [r for r in caplog.records if r.getMessage() == "account_event_unknown_account"]
    assert (record.__dict__["stripe_event_id"], record.__dict__["event_type"]) == (
        event_id,
        ACCOUNT_UPDATED,
    )
    assert unknown not in rendered(caplog)
    assert (await world.event_row(row_id)).status is WebhookEventStatus.PROCESSED


@pytest.mark.parametrize(
    "error",
    [StripeUnavailableError(request_id="req_280"), StripeRejectedError(code="account_invalid")],
    ids=["unavailable", "rejected"],
)
async def test_a_stripe_failure_is_retried_and_writes_nothing(
    world: World, stripe: FakeConnect, error: Exception
) -> None:
    stripe.errors = [error]
    queue = PushQueue()
    row_id, _ = await world.add_event()

    with pytest.raises(Retry):
        await process_stripe_event(ctx(world, queue), str(row_id))

    assert await world.payouts_enabled() is False
    assert pushes(queue) == []
    row = await world.event_row(row_id)
    assert (row.status, row.attempts, row.last_error) == (
        WebhookEventStatus.PENDING,
        1,
        type(error).__name__,
    )

    assert await process_stripe_event(ctx(world, queue, job_try=2), str(row_id)) == "processed"
    assert await world.payouts_enabled() is True
    assert len(pushes(queue)) == 1


async def test_without_a_stripe_key_the_event_waits(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(handlers.HANDLERS, ACCOUNT_UPDATED, account_updated_handler(lambda: None))
    row_id, _ = await world.add_event()

    with pytest.raises(Retry):
        await process_stripe_event(ctx(world, PushQueue()), str(row_id))

    assert await world.payouts_enabled() is False
    assert (await world.event_row(row_id)).last_error == "PayoutsNotConfiguredError"


@pytest.mark.parametrize("case", ["not_an_account", "no_id", "other_account"])
async def test_a_malformed_event_fails_with_its_id_and_type_only(
    world: World, stripe: FakeConnect, caplog: pytest.LogCaptureFixture, case: str
) -> None:
    match case:
        case "not_an_account":
            row_id, event_id = await world.add_event(object_kind="charge")
        case "no_id":
            row_id, event_id = await world.add_event(object_id=17)
        case _:
            row_id, event_id = await world.add_event(object_id=f"{world.account_id}other")
    settings = make_settings()

    outcome = await process_stripe_event(
        ctx(world, PushQueue(), job_try=settings.stripe_webhook_max_attempts), str(row_id)
    )

    assert outcome == "failed"
    assert stripe.retrieved == []
    assert await world.payouts_enabled() is False
    [record] = [r for r in caplog.records if r.getMessage() == "account_event_malformed"]
    assert (record.__dict__["stripe_event_id"], record.__dict__["event_type"]) == (
        event_id,
        ACCOUNT_UPDATED,
    )
    assert world.account_id not in rendered(caplog)


async def test_the_profile_row_is_locked_over_the_stripe_read(
    world: World, stripe: FakeConnect
) -> None:
    """Two events for one account read Stripe one after the other, so the last answer is the
    one stored (as the payouts status does)."""
    locked: list[bool] = []

    async def probe() -> None:
        async with world.sessions() as other:
            await other.execute(text("SET LOCAL lock_timeout = '1ms'"))
            try:
                await other.execute(
                    select(ProProfile.id)
                    .where(ProProfile.id == world.pro_id)
                    .with_for_update(nowait=True)
                )
            except DBAPIError:
                locked.append(True)
            else:
                locked.append(False)
            await other.rollback()

    stripe.on_retrieve = probe
    row_id, _ = await world.add_event()

    assert await process_stripe_event(ctx(world, PushQueue()), str(row_id)) == "processed"

    assert locked == [True]


def test_account_updated_is_registered_for_the_connect_endpoint() -> None:
    assert handlers.handler_for(ACCOUNT_UPDATED) is not None
    assert frozenset({ACCOUNT_UPDATED}) == handlers.CONNECT_EVENT_TYPES


def test_the_workers_client_follows_the_stripe_key(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, expected in (
        (None, type(None)),
        ("sk_test_fixture-not-a-real-key", StripeExpressConnect),
    ):
        settings = make_settings(stripe_secret_key=key)
        monkeypatch.setattr(stripe_connect, "get_settings", lambda settings=settings: settings)
        stripe_connect.worker_stripe_connect.cache_clear()
        try:
            assert isinstance(stripe_connect.worker_stripe_connect(), expected)
        finally:
            stripe_connect.worker_stripe_connect.cache_clear()


# The Connect endpoint.


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        stripe_webhook_secret=PLATFORM_SECRET, stripe_connect_webhook_secret=CONNECT_SECRET
    )


def connect_body(event_id: str, event_type: str = ACCOUNT_UPDATED) -> bytes:
    account = "acct_probe280route"
    return json.dumps(
        {
            "id": event_id,
            "object": "event",
            "type": event_type,
            "account": account,
            "livemode": False,
            "created": 1_763_000_000,
            "data": {"object": {"id": account, "object": "account"}},
        }
    ).encode()


async def post(
    client: httpx.AsyncClient, path: str, body: bytes, signature: str | None
) -> httpx.Response:
    headers = {"Content-Type": "application/json"}
    if signature is not None:
        headers["Stripe-Signature"] = signature
    return await client.post(path, content=body, headers=headers)


async def test_the_connect_endpoint_takes_account_updated_signed_with_its_own_secret(
    app: FastAPI, test_database_url: URL
) -> None:
    async with _serving(app, test_database_url) as webhook:
        event_id = webhook.new_id()
        body = connect_body(event_id)

        response = await post(webhook.client, CONNECT_PATH, body, sign(body, CONNECT_SECRET))

        assert response.status_code == 200
        [row] = await webhook.rows(event_id)
        assert row.status is WebhookEventStatus.PENDING
        assert len(webhook.queue.jobs) == 1


@pytest.mark.parametrize(
    ("path", "secret"),
    [
        (CONNECT_PATH, PLATFORM_SECRET),  # the platform's secret does not sign Connect events
        (CONNECT_PATH, None),  # no header
        (CONNECT_PATH, "whsec_wrong"),
        (PLATFORM_PATH, CONNECT_SECRET),  # nor the Connect secret platform events
    ],
    ids=["platform_secret", "missing", "wrong", "connect_secret_on_platform"],
)
async def test_a_body_not_signed_with_the_routes_own_secret_is_refused(
    app: FastAPI,
    test_database_url: URL,
    caplog: pytest.LogCaptureFixture,
    path: str,
    secret: str | None,
) -> None:
    caplog.set_level(logging.DEBUG)
    async with _serving(app, test_database_url) as webhook:
        event_id = webhook.new_id()
        body = connect_body(event_id)

        response = await post(
            webhook.client, path, body, None if secret is None else sign(body, secret)
        )

        assert (response.status_code, response.json()["error"]["code"]) == (
            400,
            "invalid_signature",
        )
        assert await webhook.rows(event_id) == []
    for value in (CONNECT_SECRET, PLATFORM_SECRET):
        assert value not in rendered(caplog)


async def test_another_event_type_on_the_connect_endpoint_is_stored_ignored(
    app: FastAPI, test_database_url: URL
) -> None:
    async with _serving(app, test_database_url) as webhook:
        event_id = webhook.new_id()
        body = connect_body(event_id, "payment_intent.succeeded")

        response = await post(webhook.client, CONNECT_PATH, body, sign(body, CONNECT_SECRET))

        assert response.status_code == 200
        [row] = await webhook.rows(event_id)
        assert (row.status, row.payload) == (WebhookEventStatus.IGNORED, None)
        assert webhook.queue.jobs == {}


async def test_without_the_connect_secret_the_connect_endpoint_answers_503(
    app: FastAPI, test_database_url: URL, settings: Settings
) -> None:
    app.state.settings = make_settings(stripe_webhook_secret=PLATFORM_SECRET)
    async with _serving(app, test_database_url) as webhook:
        body = connect_body(webhook.new_id())

        response = await post(webhook.client, CONNECT_PATH, body, sign(body, CONNECT_SECRET))

        assert (response.status_code, response.json()["error"]["code"]) == (503, "not_configured")


def test_the_connect_secret_is_never_shown() -> None:
    settings = make_settings(stripe_connect_webhook_secret=CONNECT_SECRET)

    assert CONNECT_SECRET not in repr(settings)
    assert CONNECT_SECRET not in str(settings)
    assert CONNECT_SECRET not in repr(WebhookConfig.connect_from_settings(settings))
