"""Re-dispatch of requests no dispatch reached (#478): the sweep, the kick for a pro who may have
become eligible, overlapping runs, logs and settings. Real database; the queues are recorded.

The approval's and the profile's kicks are tested with their routes (test_pro_review_api.py,
test_pros_profile_api.py), payouts enabled with its webhook (test_account_updated.py)."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from redis.exceptions import RedisError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.dispatch.kicks import RedispatchKick
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.dispatch.tasks import (
    dispatch_request,
    redispatch_for_pro,
    sweep_stalled,
)
from app.modules.pros.models import ProVerificationStatus
from app.modules.requests.models import RequestStatus, ServiceRequest
from app.modules.service_areas.models import ServiceArea
from app.observability import JsonFormatter
from tests.conftest import make_settings
from tests.test_dispatch import (
    LOG_BASE,
    Committed,
    World,
    dispatched_to,
    free_zips,
    make_pro,
    make_request,
    sessions_of,
    status_of,
    task_ctx,
)
from tests.test_dispatch import committed as committed
from tests.test_dispatch import world as world
from tests.test_redispatch_backlog import Clock, MemoryHistory
from tests.test_requests_api import ENQUEUE_TIMEOUT, RecordingQueue


def sweep_ctx(session_factory: Any, queue: RecordingQueue, **settings: object) -> dict[str, Any]:
    return {
        "session_factory": session_factory,
        "redis": queue,
        "settings": make_settings(job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT, **settings),
    }


def queued(queue: RecordingQueue) -> list[str]:
    """The requests whose dispatch the queue holds, in queueing order."""
    return [
        str(args[0]) for function, args in queue.jobs.values() if function == "dispatch_request"
    ]


async def created(session: AsyncSession, request_id: uuid.UUID, at: datetime) -> None:
    await session.execute(
        update(ServiceRequest).where(ServiceRequest.id == request_id).values(created_at=at)
    )


def memory_history() -> MemoryHistory:
    return MemoryHistory(Clock(datetime.now(UTC)))


async def sweep(session: AsyncSession, **settings: object) -> RecordingQueue:
    queue = RecordingQueue()
    await sweep_stalled(sweep_ctx(sessions_of(session), queue, **settings), memory_history())
    return queue


# --- The sweep ---------------------------------------------------------------------------------


async def test_a_request_no_pro_could_take_is_dispatched_once_a_pro_can(
    db_session: AsyncSession, world: World
) -> None:
    """Sent while no pro was eligible: no row, still received. A pro becomes eligible (approved,
    payouts enabled, the category, an area with the ZIP); the next sweep queues the request's
    dispatch, which sends it to the pro, moves it to finding_pro and pushes the pro."""
    request_id = await make_request(db_session, world)
    first = await dispatch_request(task_ctx(db_session, RecordingQueue()), str(request_id))
    assert first == "no_eligible_pros"
    assert await dispatched_to(db_session, request_id) == set()
    pro = await make_pro(db_session, world)

    queue = await sweep(db_session)

    # The sweep queues the request's own dispatch job: nothing is dispatched inline.
    assert queue.jobs[f"dispatch:{request_id}"] == ("dispatch_request", (str(request_id),))
    assert await dispatched_to(db_session, request_id) == set()
    pushes = RecordingQueue()
    assert await dispatch_request(task_ctx(db_session, pushes), str(request_id)) == "sent"
    assert await dispatched_to(db_session, request_id) == {pro}
    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO
    assert [job for job in pushes.jobs if job.startswith("push:dispatch:")] != []


@pytest.mark.parametrize("row_status", list(DispatchStatus))
async def test_a_request_with_any_dispatch_row_is_left_to_the_existing_flow(
    db_session: AsyncSession, world: World, row_status: DispatchStatus
) -> None:
    """Back in reviewing (the BDC pulled it back) with a row in any status, even declined or
    expired: never queued here, and never offered again to that pro."""
    earlier = await make_pro(db_session, world, category="other")
    await make_pro(db_session, world)
    taken = await make_request(db_session, world, status=RequestStatus.REVIEWING)
    db_session.add(
        RequestDispatch(
            request_id=taken, pro_id=earlier, sent_at=datetime.now(UTC), status=row_status
        )
    )
    await db_session.flush()
    fresh = await make_request(db_session, world)

    queue = await sweep(db_session)

    assert str(taken) not in queued(queue)
    assert str(fresh) in queued(queue)


@pytest.mark.parametrize("status", list(RequestStatus))
async def test_only_received_or_reviewing_requests_with_a_category_are_swept(
    db_session: AsyncSession, world: World, status: RequestStatus
) -> None:
    await make_pro(db_session, world)
    with_category = await make_request(db_session, world, status=status)
    without = await make_request(db_session, world, status=status, categorized=False)

    queue = await sweep(db_session)

    dispatchable = status in {RequestStatus.RECEIVED, RequestStatus.REVIEWING}
    assert (str(with_category) in queued(queue)) is dispatchable
    assert str(without) not in queued(queue)


async def test_the_sweep_reads_a_bounded_batch_oldest_first(
    db_session: AsyncSession, world: World
) -> None:
    """REDISPATCH_BATCH_SIZE per run, oldest first: the rest wait for the next run. Dated in 2020,
    before anything else in the database."""
    now = datetime(2020, 1, 10, tzinfo=UTC)
    ids = [await make_request(db_session, world) for _ in range(3)]
    for request_id, days in zip(ids, [2, 4, 3], strict=True):
        await created(db_session, request_id, now - timedelta(days=days))
    queue = RecordingQueue()

    await sweep_stalled(
        sweep_ctx(sessions_of(db_session), queue, redispatch_batch_size=2),
        MemoryHistory(Clock(now)),
        clock=lambda: now,
    )

    assert queued(queue) == [str(ids[1]), str(ids[2])]


async def test_requests_older_than_the_max_age_are_not_swept(
    db_session: AsyncSession, world: World
) -> None:
    now = datetime(2020, 2, 1, tzinfo=UTC)
    old, young = await make_request(db_session, world), await make_request(db_session, world)
    await created(db_session, old, now - timedelta(days=7, minutes=1))
    await created(db_session, young, now - timedelta(days=6, hours=23))
    queue = RecordingQueue()

    await sweep_stalled(
        sweep_ctx(sessions_of(db_session), queue), MemoryHistory(Clock(now)), clock=lambda: now
    )

    assert str(young) in queued(queue)
    assert str(old) not in queued(queue)


async def test_overlapping_runs_make_one_set_of_rows(committed: Committed) -> None:
    """Two sweeps and a kick at once queue the request's dispatch once (its job id); its
    dispatch run twice at once (a sweep's and a kick's, or the BDC's) inserts the rows once:
    the second waits on the request's lock and finds the first's rows. Then nothing is queued."""
    queue = RecordingQueue()
    ctx = sweep_ctx(committed.sessions, queue)
    history = memory_history()
    await asyncio.gather(
        sweep_stalled(ctx, history),
        sweep_stalled(ctx, history),
        redispatch_for_pro(ctx, str(committed.pro_ids[0])),
    )
    job_id = f"dispatch:{committed.request_id}"
    assert queue.jobs[job_id] == ("dispatch_request", (str(committed.request_id),))

    run = sweep_ctx(committed.sessions, RecordingQueue())
    outcomes = await asyncio.gather(
        dispatch_request(run, str(committed.request_id)),
        dispatch_request(run, str(committed.request_id)),
    )

    assert sorted(outcomes) == ["already_dispatched", "sent"]
    async with committed.sessions() as check:
        count = await check.scalar(
            select(func.count())
            .select_from(RequestDispatch)
            .where(RequestDispatch.request_id == committed.request_id)
        )
        assert count == len(committed.pro_ids)
    after = RecordingQueue()
    # A fresh history: the request is left out for its rows, not for its retry window.
    await sweep_stalled(sweep_ctx(committed.sessions, after), memory_history())
    assert job_id not in after.jobs


async def test_the_sweep_logs_counts_and_ids_only(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    """One queue failure is logged with the request's id and never stops the next; the run's
    summary carries counts only. A dispatch already queued is skipped."""
    first, second = await make_request(db_session, world), await make_request(db_session, world)
    queue = RecordingQueue()
    await queue.enqueue_job("dispatch_request", str(second), _job_id=f"dispatch:{second}")

    class FailsFirst(RecordingQueue):
        async def enqueue_job(
            self, function: str, *args: object, _job_id: str | None = None
        ) -> object:
            if _job_id == f"dispatch:{first}":
                raise RedisError("down")
            return await queue.enqueue_job(function, *args, _job_id=_job_id)

    with caplog.at_level(logging.INFO):
        await sweep_stalled(sweep_ctx(sessions_of(db_session), FailsFirst()), memory_history())

    [failed] = [r for r in caplog.records if r.getMessage() == "redispatch_enqueue_failed"]
    payload = json.loads(JsonFormatter().format(failed))
    assert set(payload) - LOG_BASE == {"service_request_id"}
    assert payload["service_request_id"] == str(first)
    [summary] = [r for r in caplog.records if r.getMessage() == "redispatch_swept"]
    counts = {key: summary.__dict__[key] for key in ("swept", "enqueued", "skipped", "failed")}
    assert counts["failed"] == 1
    assert counts["skipped"] >= 1  # the second's dispatch was queued already
    assert counts["swept"] == counts["enqueued"] + counts["skipped"] + counts["failed"]
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    for secret in ("probe-description", "@x.com", world.zip_code):
        assert secret not in output


async def test_a_sweep_that_cannot_read_ends_the_run(caplog: pytest.LogCaptureFixture) -> None:
    def broken() -> Any:
        raise OSError("database down")

    queue = RecordingQueue()
    with caplog.at_level(logging.INFO):
        await sweep_stalled(sweep_ctx(broken, queue), memory_history())

    assert queue.jobs == {}
    [error] = [r for r in caplog.records if r.getMessage() == "redispatch_sweep_unavailable"]
    assert (error.levelno, error.__dict__["error"]) == (logging.ERROR, "OSError")


# --- The kick ----------------------------------------------------------------------------------


async def other_area_request(session: AsyncSession, world: World) -> uuid.UUID:
    """A stalled request in the pro's category whose address is in another active area."""
    [zip_code] = free_zips(1)
    session.add(ServiceArea(region="Test", city="Tampa", state="FL", zip_code=zip_code))
    address = Address(
        user_id=world.customer_id, line1="2 Main St", city="Tampa", state="FL", zip_code=zip_code
    )
    session.add(address)
    await session.flush()
    request_id = await make_request(session, world)
    await session.execute(
        update(ServiceRequest).where(ServiceRequest.id == request_id).values(address_id=address.id)
    )
    return request_id


async def test_the_kick_queues_the_stalled_requests_the_pro_could_take(
    db_session: AsyncSession, world: World
) -> None:
    pro = await make_pro(db_session, world)
    mine = await make_request(db_session, world)
    elsewhere = await other_area_request(db_session, world)
    other_category = await make_request(db_session, world)
    await db_session.execute(
        update(ServiceRequest)
        .where(ServiceRequest.id == other_category)
        .values(category_id=world.other_category_id)
    )
    queue = RecordingQueue()

    await redispatch_for_pro(sweep_ctx(sessions_of(db_session), queue), str(pro))

    assert queued(queue) == [str(mine)]
    assert str(elsewhere) not in queued(queue)
    assert await dispatched_to(db_session, mine) == set()  # queued, never dispatched inline


@pytest.mark.parametrize(
    "pro_fields",
    [
        {"verification": ProVerificationStatus.PENDING},
        {"payouts": False},
        {"area": "inactive"},
    ],
    ids=["not_approved", "payouts_off", "inactive_area"],
)
async def test_the_kick_queues_nothing_for_a_pro_who_cannot_take_requests(
    db_session: AsyncSession, world: World, pro_fields: dict[str, Any]
) -> None:
    pro = await make_pro(db_session, world, **pro_fields)
    await make_request(db_session, world)
    queue = RecordingQueue()

    await redispatch_for_pro(sweep_ctx(sessions_of(db_session), queue), str(pro))

    assert queue.jobs == {}


async def test_a_kick_is_one_job_per_pro_while_it_is_queued() -> None:
    queue = RecordingQueue()
    kick = RedispatchKick(queue, ENQUEUE_TIMEOUT)
    pro_id = uuid.uuid4()

    await kick.after_commit(pro_id, "approved")
    await kick.after_commit(pro_id, "coverage_changed")

    assert queue.jobs == {f"redispatch-pro:{pro_id}": ("redispatch_for_pro", (str(pro_id),))}
    assert len(queue.before) == 2


@pytest.mark.parametrize(
    "broken",
    [RecordingQueue(failure=RedisError("down")), RecordingQueue(hang=True)],
    ids=["redis_error", "timeout"],
)
async def test_a_kick_that_cannot_be_queued_is_logged_and_never_raises(
    broken: RecordingQueue, caplog: pytest.LogCaptureFixture
) -> None:
    pro_id = uuid.uuid4()

    with caplog.at_level(logging.INFO):
        await asyncio.wait_for(
            RedispatchKick(broken, ENQUEUE_TIMEOUT).after_commit(pro_id, "approved"), timeout=5
        )

    [record] = [r for r in caplog.records if r.getMessage() == "redispatch_kick_failed"]
    payload = json.loads(JsonFormatter().format(record))
    assert set(payload) - LOG_BASE == {"pro_id", "reason"}
    assert (payload["pro_id"], payload["reason"]) == (str(pro_id), "approved")


# --- Settings ----------------------------------------------------------------------------------

DEFAULTS = {
    "REDISPATCH_SWEEP_MINUTES": 5,
    "REDISPATCH_SWEEP_TIMEOUT_SECONDS": 240,
    "REDISPATCH_MAX_AGE_DAYS": 7,
    "REDISPATCH_BATCH_SIZE": 100,
}


@pytest.mark.parametrize("name", list(DEFAULTS))
@pytest.mark.parametrize("value", ["", "oops", "0", "-1", "1.5", chr(0xB2)])
def test_an_invalid_redispatch_setting_falls_back_to_its_default(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, name: str, value: str
) -> None:
    """The API and the worker still start: the value is its default, with a warning naming the
    setting and nothing else."""
    monkeypatch.setenv(name, value)

    with caplog.at_level(logging.WARNING):
        settings = make_settings()

    assert getattr(settings, name.lower()) == DEFAULTS[name]
    [warning] = [r for r in caplog.records if r.getMessage() == "setting_invalid_default_used"]
    payload = json.loads(JsonFormatter().format(warning))
    assert set(payload) - LOG_BASE == {"setting"}
    assert payload["setting"] == name


@pytest.mark.parametrize("name", list(DEFAULTS))
def test_a_valid_redispatch_setting_is_kept(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setenv(name, " 45 ")

    assert getattr(make_settings(), name.lower()) == 45


def test_without_redispatch_settings_the_defaults_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in DEFAULTS:
        monkeypatch.delenv(name, raising=False)

    settings = make_settings()

    assert {name: getattr(settings, name.lower()) for name in DEFAULTS} == DEFAULTS


def test_the_sweep_minutes_above_an_hour_fall_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REDISPATCH_SWEEP_MINUTES", "61")

    assert make_settings().redispatch_sweep_minutes == 5
