"""#500 round 1: the re-dispatch must make progress through a real backlog.

The shape the Gatekeeper reproduced: REDISPATCH_BATCH_SIZE (and more) older stalled requests in an
active ZIP no pro covers, then a newer one in the covered ZIP, same category, sent while no pro
was eligible. A pro becomes eligible. The kick must queue the covered request alone; the sweep,
with no kick, must reach it within a bounded number of runs, and must try the older ones again
neither never nor every run. Real database; the sweep's history is in memory with expiry on the
test's clock (and RedisRedispatchHistory itself is tested on the real Redis below)."""

import logging
import math
import uuid
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Any

import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.addresses.models import Address
from app.modules.dispatch.history import Cursor, RedisRedispatchHistory
from app.modules.dispatch.models import RequestDispatch
from app.modules.dispatch.service import DISPATCHABLE
from app.modules.dispatch.stalled import history_keep
from app.modules.dispatch.tasks import (
    redispatch_for_pro,
    redispatch_stalled_requests,
    sweep_stalled,
)
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.service_areas.models import ServiceArea
from tests.conftest import make_settings
from tests.helpers import as_status_writer
from tests.test_dispatch import World, make_pro, make_request, sessions_of
from tests.test_dispatch import world as world
from tests.test_requests_api import ENQUEUE_TIMEOUT, RecordingQueue

__all__ = ["world"]

# Before anything else in the database: every request of the run is this test's.
START = datetime(2020, 3, 1, 12, 0, tzinfo=UTC)
CADENCE = timedelta(minutes=5)  # REDISPATCH_SWEEP_MINUTES's default
RETRY = timedelta(minutes=60)  # REDISPATCH_RETRY_MINUTES's default
OLDER = 105  # more than a default batch (100)


@dataclass
class Clock:
    """The test's clock. Each call returns the time and then moves it `lag` on: a run reads it
    when it selects and again when it records, so selection and recording are `lag` apart."""

    now: datetime
    lag: timedelta = timedelta(0)

    def __call__(self) -> datetime:
        current = self.now
        self.now += self.lag
        return current


@dataclass
class MemoryHistory:
    """dispatch.history's contract in memory, with Redis's expiry on the test's clock: the set
    and the cursor are gone `keep` seconds after their last write. `fail_read`/`fail_write`
    make it raise as a Redis that is down would."""

    clock: Clock
    queued: dict[str, float] = field(default_factory=dict)
    stored_cursor: Cursor | None = None
    expires_at: float = 0.0
    fail_read: bool = False
    fail_write: bool = False

    def _expire(self) -> None:
        if self.clock.now.timestamp() >= self.expires_at:
            self.queued.clear()
            self.stored_cursor = None

    async def cursor(self) -> Cursor | None:
        if self.fail_read:
            raise RedisError("down")
        self._expire()
        return self.stored_cursor

    async def queued_at(self, request_ids: Sequence[str]) -> dict[str, float]:
        if self.fail_read:
            raise RedisError("down")
        self._expire()
        return {key: self.queued[key] for key in request_ids if key in self.queued}

    async def record(
        self, queued: Sequence[str], at: float, cursor: Cursor | None, keep_seconds: int
    ) -> None:
        if self.fail_write:
            raise RedisError("down")
        self._expire()
        self.queued.update(dict.fromkeys(queued, at))
        # ZREMRANGEBYSCORE -inf (at - keep): the bound itself goes too.
        self.queued = {
            key: score for key, score in self.queued.items() if score > at - keep_seconds
        }
        self.stored_cursor = cursor
        self.expires_at = self.clock.now.timestamp() + keep_seconds


def ctx_for(session: AsyncSession, queue: RecordingQueue, batch: int) -> dict[str, Any]:
    return {
        "session_factory": sessions_of(session),
        "redis": queue,
        "settings": make_settings(
            job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT, redispatch_batch_size=batch
        ),
    }


def queued_ids(queue: RecordingQueue) -> set[str]:
    return {
        str(args[0]) for function, args in queue.jobs.values() if function == "dispatch_request"
    }


async def backlog(session: AsyncSession, world: World, older: int) -> tuple[list[str], str]:
    """`older` stalled requests at an address in the world's other active ZIP (no pro covers
    it), then one newer request at the world's own address; one second apart, all in the
    world's category, sent while no pro was eligible (no dispatch row)."""
    other_zip = await session.scalar(
        select(ServiceArea.zip_code).where(ServiceArea.id == world.other_area_id)
    )
    assert other_zip is not None
    far = Address(
        user_id=world.customer_id, line1="9 Far St", city="Orlando", state="FL", zip_code=other_zip
    )
    session.add(far)
    await session.flush()
    rows = [
        ServiceRequest(
            customer_id=world.customer_id,
            address_id=far.id,
            category_id=world.category_id,
            description="probe-description backlog",
            status=RequestStatus.RECEIVED,
            origin=RequestOrigin.APP,
            created_at=START - timedelta(days=1) + timedelta(seconds=index),
        )
        for index in range(older)
    ]
    async with as_status_writer(session):
        session.add_all(rows)
        await session.flush()
    covered = await make_request(session, world)
    await session.execute(
        update(ServiceRequest)
        .where(ServiceRequest.id == covered)
        .values(created_at=START - timedelta(days=1) + timedelta(seconds=older))
    )
    return [str(row.id) for row in rows], str(covered)


async def stalled_count(session: AsyncSession) -> int:
    """Every request a sweep at START can read (this test's, and any other in the database)."""
    dispatched = select(RequestDispatch.request_id)
    count = await session.scalar(
        select(func.count())
        .select_from(ServiceRequest)
        .where(
            ServiceRequest.status.in_(DISPATCHABLE),
            ServiceRequest.category_id.is_not(None),
            ServiceRequest.created_at >= START - timedelta(days=7),
            ServiceRequest.id.not_in(dispatched),
        )
    )
    return count or 0


@pytest.mark.parametrize("batch", [100, 1])
async def test_the_kick_queues_only_the_request_the_pro_matches(
    db_session: AsyncSession, world: World, batch: int
) -> None:
    _, covered = await backlog(db_session, world, OLDER)
    pro = await make_pro(db_session, world)
    queue = RecordingQueue()

    await redispatch_for_pro(ctx_for(db_session, queue, batch), str(pro), clock=lambda: START)

    assert queued_ids(queue) == {covered}


@pytest.mark.parametrize("lag", [timedelta(0), timedelta(seconds=1)], ids=["no_lag", "lag_1s"])
@pytest.mark.parametrize("batch", [100, 1])
async def test_the_sweep_reaches_the_covered_request_through_the_backlog(
    db_session: AsyncSession, world: World, batch: int, lag: timedelta
) -> None:
    """No kick: only the sweep. Each run starts a fresh queue (the last run's jobs have run and
    matched no pro). The covered request is queued within one round of the cursor."""
    _, covered = await backlog(db_session, world, OLDER)
    await make_pro(db_session, world)
    bound = math.ceil(await stalled_count(db_session) / batch) + 1
    clock = Clock(START, lag)
    history = MemoryHistory(clock)

    reached_at = None
    for run in range(bound):
        clock.now = START + run * CADENCE
        queue = RecordingQueue()
        await sweep_stalled(ctx_for(db_session, queue, batch), history, clock)
        if covered in queued_ids(queue):
            reached_at = run
            break

    assert reached_at is not None, f"not reached in {bound} runs"


async def test_the_sweep_tries_a_no_match_request_again_about_once_per_window(
    db_session: AsyncSession, world: World
) -> None:
    """The default batch over 150 minutes of runs: the oldest request (no pro covers its ZIP)
    is queued at the start and again once the retry window has passed, not every run."""
    older, _ = await backlog(db_session, world, OLDER)
    clock = Clock(START, timedelta(seconds=1))
    history = MemoryHistory(clock)
    runs = int(timedelta(minutes=150) / CADENCE)

    queued_in: list[int] = []
    for run in range(runs):
        clock.now = START + run * CADENCE
        queue = RecordingQueue()
        await sweep_stalled(ctx_for(db_session, queue, 100), history, clock)
        if older[0] in queued_ids(queue):
            queued_in.append(run)

    assert queued_in[0] == 0
    assert 2 <= len(queued_in) <= 3, queued_in  # 0, then about every 60 minutes
    gaps = [later - earlier for earlier, later in pairwise(queued_in)]
    assert all(gap * CADENCE >= RETRY for gap in gaps), queued_in


async def test_a_history_that_cannot_be_read_ends_the_run(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    await backlog(db_session, world, 2)
    clock = Clock(START)
    history = MemoryHistory(clock, fail_read=True)
    queue = RecordingQueue()

    with caplog.at_level(logging.INFO):
        await sweep_stalled(ctx_for(db_session, queue, 100), history, clock)

    assert queue.jobs == {}
    [error] = [r for r in caplog.records if r.getMessage() == "redispatch_sweep_unavailable"]
    assert error.__dict__["error"] == "RedisError"


async def test_a_history_that_cannot_be_written_queues_nothing(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    """Queueing without the record would leave the cursor in place: the next run would take the
    same batch again. So the run ends before queueing, with one class-only error."""
    await backlog(db_session, world, 2)
    clock = Clock(START)
    history = MemoryHistory(clock, fail_write=True)
    queue = RecordingQueue()

    with caplog.at_level(logging.INFO):
        await sweep_stalled(ctx_for(db_session, queue, 100), history, clock)

    assert queue.jobs == {}
    [error] = [r for r in caplog.records if r.getMessage() == "redispatch_history_unavailable"]
    assert (error.levelno, error.__dict__["error"]) == (logging.ERROR, "RedisError")
    assert [r for r in caplog.records if r.getMessage() == "redispatch_swept"] == []


def test_the_history_keeps_twice_the_longer_of_the_window_and_the_cadence() -> None:
    assert history_keep(RETRY, CADENCE) == 2 * RETRY
    assert history_keep(timedelta(minutes=1), CADENCE) == 2 * CADENCE


async def test_the_cron_keeps_its_history_in_the_queues_redis(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[object] = []

    async def capture(ctx: dict[str, Any], history: object, clock: object = None) -> None:
        seen.append(history)

    monkeypatch.setattr("app.modules.dispatch.tasks.sweep_stalled", capture)
    redis = object()

    await redispatch_stalled_requests({"redis": redis})

    [history] = seen
    assert isinstance(history, RedisRedispatchHistory)


# --- RedisRedispatchHistory on the real Redis --------------------------------------------------


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client: Redis = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


async def test_the_redis_history_records_trims_and_expires(redis: Redis) -> None:
    prefix = f"test-redispatch-{uuid.uuid4().hex}"
    history = RedisRedispatchHistory(redis, prefix=prefix)
    keep = 120
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    cursor = (START, uuid.uuid4())
    try:
        assert await history.cursor() is None
        await history.record([first], 1_000.0, cursor, keep)
        assert await history.cursor() == cursor
        assert await history.queued_at([first, second]) == {first: 1_000.0}
        ttls = [await redis.ttl(f"{prefix}:cursor"), await redis.ttl(f"{prefix}:queued")]
        assert all(0 < ttl <= keep for ttl in ttls), ttls

        # Past the keep: the old entry is trimmed by the next write; a run at the end of the
        # stalled set stores no cursor (the next starts over).
        await history.record([second], 1_000.0 + keep, None, keep)
        assert await history.queued_at([first, second]) == {second: 1_000.0 + keep}
        assert await history.cursor() is None
    finally:
        await redis.delete(f"{prefix}:cursor", f"{prefix}:queued")


async def test_a_cursor_the_history_cannot_read_starts_over(redis: Redis) -> None:
    prefix = f"test-redispatch-{uuid.uuid4().hex}"
    try:
        await redis.set(f"{prefix}:cursor", "not-a-cursor")
        assert await RedisRedispatchHistory(redis, prefix=prefix).cursor() is None
    finally:
        await redis.delete(f"{prefix}:cursor")
