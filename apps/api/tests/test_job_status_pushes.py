"""Pushes on every job status change (D12, #65).

The pro's steps through the API (On my way, check-in, start, Job's done), what the Stripe
webhook worker does (the job booked, a canceled payment that reopened the quotes) and the
unpaid sweep's local cancel (#297): each push is queued after the commit, once, to the right
user with the right kind, params and deep link; never for a refused or rolled-back action; a
queue failure never fails the action and is logged with ids; and the arrival code is in no
payload.
"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from arq import Retry
from fastapi import FastAPI
from redis.exceptions import RedisError
from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.jobs.execution import JobExecutionConfig, JobExecutionService
from app.modules.jobs.models import Job, JobPhotoKind, JobStatus
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.notifications import catalog, deep_links
from app.modules.notifications.preferences import KIND_GROUP, PreferenceGroup
from app.modules.payments.models import Payment, PaymentStatus
from app.modules.payments.tasks import cancel_unpaid_payments
from app.modules.pros.models import ProProfile
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.service import QuoteSettlement
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserAccount
from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus
from app.modules.webhooks.service import process_job_id
from app.modules.webhooks.tasks import process_stripe_event
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.conftest import InMemoryJobLocationStore, make_settings
from tests.helpers import as_status_writer
from tests.job_world import JobWorld, build_world, make_job, record_pushes
from tests.test_job_photos_api import FakeStorage, photo_row, safe_key
from tests.test_payment_webhooks import (
    CANCELED,
    MAX_ATTEMPTS,
    SECRET,
    SUCCEEDED,
    Market,
    market,
)
from tests.test_payments_api import PUBLISHABLE_KEY, FakeStripePayments
from tests.test_requests_api import ENQUEUE_TIMEOUT, EVENTS, RecordingQueue
from tests.test_unpaid_payments import WINDOW, aged, set_payment

__all__ = ["market"]  # a fixture, used by name

CODE = "0427"
HERE = {"lat": 28.538336, "lng": -81.379234}
JOB_KINDS = (
    "job_booked",
    "job_scheduled",
    "job_on_the_way",
    "job_checked_in",
    "job_started",
    "job_done",
    "job_confirmed",  # to the pro (#66, #67): test_job_confirm_api.py, test_job_auto_confirm.py
    "booking_not_completed",
)
LOG_FIELDS = {"timestamp", "level", "logger", "message", "request_id"}


@pytest.fixture
def settings() -> Settings:
    # The webhook market's settings, with a short enqueue bound so a hung Redis ends quickly.
    return make_settings(
        stripe_webhook_secret=SECRET,
        stripe_webhook_max_attempts=MAX_ATTEMPTS,
        stripe_publishable_key=PUBLISHABLE_KEY,
        job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT,
        payment_unpaid_cancel_after_seconds=int(WINDOW.total_seconds()),
    )


def records(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.message == message]


def ids_only(record: logging.LogRecord) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(JsonFormatter().format(record))
    return {key: value for key, value in payload.items() if key not in LOG_FIELDS}


def push(
    user_id: uuid.UUID, kind: str, event_id: uuid.UUID, code: str, link: str
) -> tuple[str, tuple[object, ...]]:
    """A queued send_push job as enqueue_push writes it."""
    return (
        "send_push",
        (
            str(user_id),
            f"{kind}:{event_id}",
            f"push.{kind}.title",
            f"push.{kind}.body",
            {"public_code": code},
            link,
        ),
    )


async def public_code_of(session: AsyncSession, request_id: uuid.UUID) -> str:
    code = await session.scalar(
        select(ServiceRequest.public_code).where(ServiceRequest.id == request_id)
    )
    assert code is not None
    return code


# The pro's steps through the API (#63)


@dataclass(frozen=True)
class Step:
    kind: str
    path: str
    status: JobStatus  # the job's status before the step
    fields: dict[str, Any]
    body: dict[str, Any] | None
    repeat_status: int  # the same step again


def _soon() -> datetime:
    return datetime.now(UTC) + timedelta(minutes=30)


STEPS = [
    # Again while on the way: an ETA update, 200, no push.
    Step("job_on_the_way", "on-the-way", JobStatus.SCHEDULED, {}, {"eta_minutes": 15}, 200),
    # Again once checked in: 200 without looking at the code, no push.
    Step(
        "job_checked_in",
        "check-in",
        JobStatus.ON_THE_WAY,
        {"arrival_code": CODE},
        {"arrival_code": CODE, **HERE},
        200,
    ),
    # Again once started: 409, no push.
    Step("job_started", "start", JobStatus.ON_THE_WAY, {"checked_in": True}, None, 409),
    # Again once completed: 200, unchanged, no push.
    Step("job_done", "complete", JobStatus.IN_PROGRESS, {"after_photo": True}, None, 200),
]


async def job_for(session: AsyncSession, world: JobWorld, step: Step) -> Job:
    fields = dict(step.fields)
    after_photo = fields.pop("after_photo", False)
    if fields.pop("checked_in", False):
        fields["checked_in_at"] = datetime.now(UTC)
    if step.status is JobStatus.ON_THE_WAY:
        fields.setdefault("eta_at", _soon())
    job = await make_job(session, world, step.status, **fields)
    if after_photo:  # Job's done needs an after photo whose safe copy is ready (#298)
        await photo_row(session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.READY, safe_key())
    return job


def post(client: httpx.AsyncClient, job_id: uuid.UUID, step: Step, headers: dict[str, str]) -> Any:
    return client.post(f"/v1/pros/me/jobs/{job_id}/{step.path}", json=step.body, headers=headers)


@pytest.fixture
async def world(db_session: AsyncSession) -> JobWorld:
    return await build_world(db_session)


@pytest.fixture(autouse=True)
def storage(app: FastAPI) -> FakeStorage:
    """Signs the photos of a completed job's view (#298)."""
    fake = FakeStorage()
    app.state.storage = fake
    return fake


@pytest.fixture
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


@pytest.mark.parametrize("step", STEPS, ids=[step.kind for step in STEPS])
async def test_each_step_pushes_the_customer_once_after_the_commit(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    commits: None,
    step: Step,
) -> None:
    job = await job_for(db_session, world, step)
    code = await public_code_of(db_session, job.request_id)

    response = await post(db_client, job.id, step, world.pro.headers)

    assert response.status_code == 200, response.text
    assert queue.jobs == {
        f"push:{step.kind}:{job.id}": push(
            world.customer.id, step.kind, job.id, code, f"/requests/{job.request_id}/job"
        )
    }
    assert queue.before == ["commit"]  # queued after the step's commit, once
    # The same step again (a retry, an ETA update): no second push, not even a deduplicated one.
    again = await post(db_client, job.id, step, world.pro.headers)
    assert again.status_code == step.repeat_status, again.text
    assert len(queue.before) == 1


async def test_refused_steps_push_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, queue: RecordingQueue
) -> None:
    scheduled = await make_job(db_session, world)
    on_the_way = await make_job(
        db_session, world, JobStatus.ON_THE_WAY, arrival_code=CODE, eta_at=_soon()
    )
    working = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    on_my_way, check_in, start, done = STEPS
    pro = world.pro.headers

    refused = [
        (await post(db_client, scheduled.id, start, pro), 409),  # check-in required
        (await post(db_client, working.id, done, pro), 409),  # no after photo
        (await post(db_client, working.id, on_my_way, pro), 409),  # not from in progress
        (await post(db_client, scheduled.id, check_in, pro), 409),  # not on the way
        (
            await db_client.post(
                f"/v1/pros/me/jobs/{on_the_way.id}/check-in",
                json={"arrival_code": "9999", **HERE},
                headers=pro,
            ),
            422,
        ),  # a wrong code
        (await post(db_client, scheduled.id, on_my_way, world.other_pro.headers), 404),
        (await post(db_client, scheduled.id, on_my_way, world.customer.headers), 403),
    ]

    assert [response.status_code for response, _ in refused] == [code for _, code in refused]
    assert queue.before == []
    assert queue.jobs == {}


async def _pro_account(session: AsyncSession, world: JobWorld) -> UserAccount:
    user = await session.get(User, world.pro.id)
    assert user is not None
    return UserAccount(
        id=user.id,
        email=user.email,
        role=user.role,
        locale=user.locale,
        status=user.status,
        public_code=user.public_code,
        created_at=user.created_at,
    )


def no_storage() -> Storage:
    raise AssertionError("the commit fails before any photo is signed")


@pytest.mark.parametrize("step", STEPS, ids=[step.kind for step in STEPS])
async def test_no_push_when_the_commit_fails(
    db_session: AsyncSession,
    world: JobWorld,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    step: Step,
) -> None:
    job = await job_for(db_session, world, step)
    pro = await _pro_account(db_session, world)
    recorder = RecordingQueue()
    service = JobExecutionService(
        db_session,
        JobExecutionConfig.from_settings(settings),
        no_storage,
        InMemoryJobLocationStore(),  # the check-in and the start end the live position (#350)
    )
    actions = {
        "job_on_the_way": lambda: service.on_the_way(pro, job.id, 15, recorder),
        "job_checked_in": lambda: service.check_in(
            pro, job.id, CODE, HERE["lat"], HERE["lng"], recorder
        ),
        "job_started": lambda: service.start(pro, job.id, recorder),
        "job_done": lambda: service.complete(pro, job.id, recorder),
    }

    async def fail(self: AsyncSession) -> None:
        raise RuntimeError("synthetic commit failure")

    savepoint = await db_session.begin_nested()  # the request's transaction
    monkeypatch.setattr(AsyncSession, "commit", fail)
    with pytest.raises(RuntimeError):
        await actions[step.kind]()
    monkeypatch.undo()
    await savepoint.rollback()

    assert recorder.before == []
    assert recorder.jobs == {}


@pytest.mark.parametrize("step", STEPS, ids=[step.kind for step in STEPS])
@pytest.mark.parametrize(
    "broken",
    [RecordingQueue(failure=RedisError("down")), RecordingQueue(hang=True)],
    ids=["redis_error", "timeout"],
)
async def test_a_failed_push_enqueue_never_fails_the_step(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    step: Step,
    broken: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
) -> None:
    broken.before.clear()
    app.dependency_overrides[get_job_queue] = lambda: broken
    job = await job_for(db_session, world, step)

    with caplog.at_level(logging.INFO):
        response = await asyncio.wait_for(post(db_client, job.id, step, world.pro.headers), 5)

    assert response.status_code == 200, response.text
    assert len(broken.before) == 1  # tried once
    assert (await db_client.get(f"/v1/pros/me/jobs/{job.id}", headers=world.pro.headers)).json()[
        "status"
    ] == {
        "job_on_the_way": JobStatus.ON_THE_WAY,
        "job_checked_in": JobStatus.ON_THE_WAY,
        "job_started": JobStatus.IN_PROGRESS,
        "job_done": JobStatus.COMPLETED,
    }[step.kind]
    [record] = records(caplog, "push_enqueue_failed")
    assert record.levelno == logging.ERROR
    assert ids_only(record) == {
        "user_id": str(world.customer.id),
        "message_id": f"{step.kind}:{job.id}",
    }


async def test_the_arrival_code_and_eta_are_in_no_job_push(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.modules.jobs.execution.secrets.randbelow", lambda _: 7391)
    job = await make_job(db_session, world)
    base = f"/v1/pros/me/jobs/{job.id}"
    pro = world.pro.headers

    moved = await db_client.post(f"{base}/on-the-way", json={"eta_minutes": 15}, headers=pro)
    view = await db_client.get(f"/v1/requests/{job.request_id}/job", headers=world.customer.headers)
    issued = view.json()["arrival_code"]
    checked = await db_client.post(
        f"{base}/check-in", json={"arrival_code": issued, **HERE}, headers=pro
    )
    started = await db_client.post(f"{base}/start", headers=pro)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.READY, safe_key())
    done = await db_client.post(f"{base}/complete", headers=pro)

    assert [s.status_code for s in (moved, checked, started, done)] == [200, 200, 200, 200]
    assert issued == "7391"
    assert sorted(queue.jobs) == sorted(
        f"push:{kind}:{job.id}"
        for kind in ("job_on_the_way", "job_checked_in", "job_started", "job_done")
    )
    eta = moved.json()["eta_at"]
    for _, args in queue.jobs.values():
        payload = json.dumps(args)
        assert issued not in payload
        assert eta[:16] not in payload  # not even the minute
        _, _, title_key, body_key, params, _ = args
        assert isinstance(params, dict)
        for locale in ("en", "es"):
            for key in (title_key, body_key):
                assert isinstance(key, str)
                assert issued not in catalog.render(locale, key, params)


# What the Stripe webhook worker does (#61)


@dataclass
class CheckingQueue(RecordingQueue):
    """Records, at each enqueue, the market's job count, the last event row's status (None
    without one) and the payment's status as another connection sees them: a push queued before
    the worker's commit would see none of its writes."""

    market: Market | None = None
    seen: list[tuple[int, WebhookEventStatus | None, PaymentStatus | None]] = field(
        default_factory=list
    )

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        assert self.market is not None
        async with self.market.sessions() as session:
            jobs = await session.scalar(
                select(func.count())
                .select_from(Job)
                .where(Job.request_id == self.market.request_id)
            )
            status = (
                await session.scalar(
                    select(WebhookEvent.status).where(
                        WebhookEvent.stripe_event_id == self.market.event_ids[-1]
                    )
                )
                if self.market.event_ids
                else None
            )
            payment = await session.scalar(
                select(Payment.status).where(Payment.id == self.market.payment_id)
            )
        self.seen.append((int(jobs or 0), status, payment))
        return await super().enqueue_job(function, *args, _job_id=_job_id)


# The worker runs' push deadline: CheckingQueue reads the database inside it, which a loaded
# test run can make slower than ENQUEUE_TIMEOUT. The broken-queue tests pass the short one.
WORKER_ENQUEUE_TIMEOUT = 5.0


def worker_settings(market: Market, enqueue_timeout: float) -> Settings:
    return market.settings.model_copy(update={"job_enqueue_timeout_seconds": enqueue_timeout})


async def run(
    market: Market,
    event_id: str,
    queue: object,
    *,
    job_try: int = 1,
    enqueue_timeout: float = WORKER_ENQUEUE_TIMEOUT,
) -> str:
    """The task the receipt queued for the event, with `queue` as the worker's own pool."""
    _, args = market.queue.jobs[process_job_id(event_id)]
    context: dict[str, Any] = {
        "settings": worker_settings(market, enqueue_timeout),
        "session_factory": market.sessions,
        "job_try": job_try,
        "redis": queue,
    }
    return await process_stripe_event(context, str(args[0]))


async def posted(market: Market, event_type: str) -> str:
    event_id = market.new_event_id()
    await market.post(market.body(event_id, event_type))
    return event_id


async def booked(market: Market) -> tuple[uuid.UUID, uuid.UUID, str]:
    """The job, its pro's user and the request's public code."""
    async with market.sessions() as session:
        job_id = await session.scalar(select(Job.id).where(Job.request_id == market.request_id))
        pro_user = await session.scalar(
            select(ProProfile.user_id).where(ProProfile.id == market.pro_ids[0])
        )
        code = await public_code_of(session, market.request_id)
    assert job_id is not None
    assert pro_user is not None
    return job_id, pro_user, code


async def test_a_booked_job_pushes_the_customer_and_the_pro_after_the_commit(
    market: Market,
) -> None:
    event_id = await posted(market, SUCCEEDED)
    queue = CheckingQueue(market=market)

    assert await run(market, event_id, queue) == "processed"

    job_id, pro_user, code = await booked(market)
    assert queue.jobs == {
        f"push:job_booked:{job_id}": push(
            market.customer_id, "job_booked", job_id, code, f"/requests/{market.request_id}/job"
        ),
        f"push:job_scheduled:{job_id}": push(
            pro_user, "job_scheduled", job_id, code, f"/jobs/{job_id}"
        ),
    }
    # Both queued once the job and the processed row were committed.
    assert queue.seen == [(1, WebhookEventStatus.PROCESSED, PaymentStatus.SUCCEEDED)] * 2


async def test_a_repeated_or_late_event_pushes_nothing_more(market: Market) -> None:
    event_id = await posted(market, SUCCEEDED)
    queue = CheckingQueue(market=market)
    assert await run(market, event_id, queue) == "processed"
    assert len(queue.before) == 2

    # The same event again: the row is processed, the run is skipped.
    assert await run(market, event_id, queue) == "skipped"
    # Another succeeded event for the intent: the payment is succeeded already, no new job.
    assert await run(market, await posted(market, SUCCEEDED), queue) == "processed"

    assert len(queue.before) == 2


async def test_a_rolled_back_handler_pushes_nothing_and_its_retry_pushes_once(
    market: Market, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The step after the job's insert fails: the savepoint takes the job back, so nothing is
    announced; the retried run books the job and pushes once."""

    async def fail(*args: object) -> None:
        raise RuntimeError("injected")

    event_id = await posted(market, SUCCEEDED)
    queue = CheckingQueue(market=market)
    monkeypatch.setattr(QuoteSettlement, "reject_others", fail)
    with pytest.raises(Retry):
        await run(market, event_id, queue)
    assert queue.before == []
    assert (await market.state()).jobs == []

    monkeypatch.undo()
    assert await run(market, event_id, queue, job_try=2) == "processed"
    job_id, _, _ = await booked(market)
    assert sorted(queue.jobs) == [f"push:job_booked:{job_id}", f"push:job_scheduled:{job_id}"]
    assert len(queue.before) == 2


async def test_no_push_when_the_worker_commit_fails(
    market: Market, monkeypatch: pytest.MonkeyPatch
) -> None:
    event_id = await posted(market, SUCCEEDED)
    queue = CheckingQueue(market=market)

    async def fail(self: AsyncSession) -> None:
        raise SQLAlchemyError("synthetic commit failure")

    monkeypatch.setattr(AsyncSession, "commit", fail)
    with pytest.raises(Retry):
        await run(market, event_id, queue)
    monkeypatch.undo()

    assert queue.before == []
    assert (await market.state()).jobs == []
    # The retry commits, then pushes.
    assert await run(market, event_id, queue, job_try=2) == "processed"
    assert len(queue.before) == 2


@pytest.mark.parametrize(
    "broken",
    [RecordingQueue(failure=RedisError("down")), RecordingQueue(hang=True)],
    ids=["redis_error", "timeout"],
)
async def test_a_failed_push_enqueue_never_fails_the_event(
    market: Market, broken: RecordingQueue, caplog: pytest.LogCaptureFixture
) -> None:
    broken.before.clear()
    event_id = await posted(market, SUCCEEDED)

    with caplog.at_level(logging.INFO):
        outcome = await asyncio.wait_for(
            run(market, event_id, broken, enqueue_timeout=ENQUEUE_TIMEOUT), 5
        )

    assert outcome == "processed"
    assert len(broken.before) == 2  # each push tried once
    assert (await market.event_row(event_id)).status is WebhookEventStatus.PROCESSED
    job_id, pro_user, _ = await booked(market)
    assert sorted(
        (ids_only(record)["user_id"], ids_only(record)["message_id"])
        for record in records(caplog, "push_enqueue_failed")
    ) == sorted(
        [
            (str(market.customer_id), f"job_booked:{job_id}"),
            (str(pro_user), f"job_scheduled:{job_id}"),
        ]
    )
    for record in records(caplog, "push_enqueue_failed"):
        assert set(ids_only(record)) == {"user_id", "message_id"}


async def test_a_canceled_payment_that_reopens_the_quotes_pushes_the_customer(
    market: Market,
) -> None:
    event_id = await posted(market, CANCELED)
    queue = CheckingQueue(market=market)

    assert await run(market, event_id, queue) == "processed"

    async with market.sessions() as session:
        code = await public_code_of(session, market.request_id)
    assert (await market.state()).request is RequestStatus.QUOTE_READY
    assert queue.jobs == {
        f"push:booking_not_completed:{market.payment_id}": push(
            market.customer_id,
            "booking_not_completed",
            market.payment_id,
            code,
            f"/requests/{market.request_id}",
        )
    }
    assert queue.seen == [(0, WebhookEventStatus.PROCESSED, PaymentStatus.CANCELED)]


async def test_a_canceled_payment_with_no_quote_left_pushes_the_same_true_copy(
    market: Market,
) -> None:
    """The accepted quote expired and no other is live: the request backs out to finding_pro.
    The push still goes, and its copy promises no quote to choose (true in both outcomes)."""
    async with market.sessions() as session:
        await session.execute(
            update(Quote)
            .where(Quote.id == market.accepted_quote)
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await session.execute(
            update(Quote)
            .where(Quote.id.in_(market.quote_ids[1:]))
            .values(status=QuoteStatus.WITHDRAWN)
        )
        await session.commit()
    queue = CheckingQueue(market=market)

    assert await run(market, await posted(market, CANCELED), queue) == "processed"

    assert (await market.state()).request is RequestStatus.FINDING_PRO
    assert list(queue.jobs) == [f"push:booking_not_completed:{market.payment_id}"]
    params = {"public_code": "JF-000124"}
    for locale in ("en", "es"):
        body = catalog.render(locale, "push.booking_not_completed.body", params)
        assert "quote" not in body
        assert "presupuesto" not in body


async def test_a_succeeded_event_that_adopts_its_intent_still_pushes_both(market: Market) -> None:
    """A lost create answer (#296): the payment holds no PaymentIntent and the event's metadata
    names it. The adoption books the job, and both pushes still go after the commit."""
    async with market.sessions() as session:
        await session.execute(
            update(Payment)
            .where(Payment.id == market.payment_id)
            .values(stripe_payment_intent_id=None)
        )
        await session.commit()
    queue = CheckingQueue(market=market)

    assert await run(market, await posted(market, SUCCEEDED), queue) == "processed"

    job_id, _, _ = await booked(market)
    assert sorted(queue.jobs) == [f"push:job_booked:{job_id}", f"push:job_scheduled:{job_id}"]
    assert queue.seen == [(1, WebhookEventStatus.PROCESSED, PaymentStatus.SUCCEEDED)] * 2


async def test_a_canceled_payment_that_reopens_nothing_pushes_nothing(market: Market) -> None:
    async with market.sessions() as session:
        async with as_status_writer(session):
            await session.execute(
                update(ServiceRequest)
                .where(ServiceRequest.id == market.request_id)
                .values(status=RequestStatus.CANCELLED)
            )
        await session.commit()
    queue = CheckingQueue(market=market)

    assert await run(market, await posted(market, CANCELED), queue) == "processed"

    assert queue.before == []


async def sweep(
    market: Market, queue: object, *, enqueue_timeout: float = WORKER_ENQUEUE_TIMEOUT
) -> None:
    """The unpaid sweep (#297), with `queue` as the worker's own pool."""
    await cancel_unpaid_payments(
        {
            "session_factory": market.sessions,
            "settings": worker_settings(market, enqueue_timeout),
            "stripe_payments": FakeStripePayments(),
            "redis": queue,
        }
    )


async def test_a_local_cancel_by_the_unpaid_sweep_pushes_the_customer_once(
    market: Market,
) -> None:
    """No PaymentIntent was ever created: the sweep cancels the payment itself and reopens the
    quotes (no Stripe event follows), then pushes once its transaction is committed."""
    await set_payment(market, stripe_payment_intent_id=None, created_at=aged())
    queue = CheckingQueue(market=market)

    await sweep(market, queue)
    await sweep(market, queue)  # the payment is canceled now: nothing more

    async with market.sessions() as session:
        code = await public_code_of(session, market.request_id)
    assert queue.jobs == {
        f"push:booking_not_completed:{market.payment_id}": push(
            market.customer_id,
            "booking_not_completed",
            market.payment_id,
            code,
            f"/requests/{market.request_id}",
        )
    }
    assert queue.seen == [(0, None, PaymentStatus.CANCELED)]


async def test_a_failed_push_enqueue_never_fails_the_sweep(
    market: Market, caplog: pytest.LogCaptureFixture
) -> None:
    await set_payment(market, stripe_payment_intent_id=None, created_at=aged())
    broken = RecordingQueue(failure=RedisError("down"))

    with caplog.at_level(logging.INFO):
        await sweep(market, broken, enqueue_timeout=ENQUEUE_TIMEOUT)

    assert (await market.state()).payment is PaymentStatus.CANCELED
    [record] = records(caplog, "push_enqueue_failed")
    assert ids_only(record) == {
        "user_id": str(market.customer_id),
        "message_id": f"booking_not_completed:{market.payment_id}",
    }
    assert len(records(caplog, "unpaid_payments_swept")) == 1


async def test_a_sweep_that_cancels_in_stripe_pushes_nothing_itself(market: Market) -> None:
    """With a PaymentIntent the sweep asks Stripe to cancel it; the canceled event's worker
    run pushes (tested above), so the sweep never pushes twice."""
    await set_payment(market, created_at=aged())
    queue = CheckingQueue(market=market)

    await sweep(market, queue)

    assert queue.before == []


# The copy, the mute groups and the deep link


def test_job_kinds_have_en_and_es_copy_with_only_the_public_code() -> None:
    for kind in JOB_KINDS:
        for locale in ("en", "es"):
            copy = catalog.CATALOG[locale]
            assert copy[f"push.{kind}.title"].strip()
            assert catalog.placeholders(copy[f"push.{kind}.title"]) == set()
            assert catalog.placeholders(copy[f"push.{kind}.body"]) == {"public_code"}
            assert catalog.placeholders(copy[f"push.{kind}.body"]) <= catalog.PLACEHOLDERS
        # Transactional: muted only with the other job updates.
        assert KIND_GROUP[kind] is PreferenceGroup.JOB_UPDATES


def test_on_the_way_copy_points_to_the_app_for_the_code() -> None:
    params = {"public_code": "JF-000124"}

    assert catalog.render("en", "push.job_on_the_way.title", params) == "Your pro is on the way"
    assert catalog.render("en", "push.job_on_the_way.body", params) == (
        "Your pro is heading to job JF-000124. Your arrival code is in the app."
    )
    assert catalog.render("es", "push.job_on_the_way.body", params) == (
        "Tu profesional va en camino al trabajo JF-000124. Tu código de llegada está en la app."
    )


def test_the_job_deep_link_is_allowed_and_its_neighbours_refused() -> None:
    request_id = uuid.UUID(int=7)

    assert deep_links.is_allowed(f"/requests/{request_id}/job")
    for path in (
        f"/requests/{request_id}/jobs",
        f"/requests/{request_id}/job/",
        f"/requests/{request_id}/job/x",
        f"/requests/{request_id}/job?x=1",
        f"/requests/{request_id}/../job",
        "/requests/not-a-uuid/job",
        "/requests//job",
        f"https://evil.example/requests/{request_id}/job",
        f"//evil.example/requests/{request_id}/job",
    ):
        assert not deep_links.is_allowed(path), path
