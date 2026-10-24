import asyncio
import importlib
import uuid
from collections.abc import AsyncIterator, Awaitable, Iterator
from types import ModuleType
from typing import cast

import pytest
from arq import func
from arq.connections import ArqRedis
from arq.worker import Function, Worker, create_worker
from sqlalchemy.exc import ProgrammingError

from app.config import Settings, get_settings
from app.modules.dispatch.tasks import dispatch_request
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES
from app.worker import WorkerSettings


@pytest.fixture
def worker_module(monkeypatch: pytest.MonkeyPatch) -> Iterator[ModuleType]:
    # WorkerSettings reads REDIS_URL at import time, like the real `arq` process does.
    monkeypatch.setenv("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    get_settings.cache_clear()
    import app.worker

    yield importlib.reload(app.worker)
    get_settings.cache_clear()


def test_worker_registers_at_least_one_function(worker_module: ModuleType) -> None:
    # ARQ refuses to start with zero functions.
    assert worker_module.WorkerSettings.functions


async def test_ping_task_answers_pong(worker_module: ModuleType) -> None:
    assert await worker_module.ping({}) == "pong"


# No job result in Redis (#176): a failed job's result is its pickled exception, and a database
# error's text holds its SQL statement with literals.


def test_every_worker_function_discards_results() -> None:
    for function in WorkerSettings.functions:
        # A bare coroutine would take the worker's default: register it with discarding_result.
        assert isinstance(function, Function), function
        assert (function.keep_result_s, function.keep_result_forever) == (0, False), function.name
    for job in WorkerSettings.cron_jobs:
        assert (job.keep_result_s, job.keep_result_forever) == (0, False), job.name
    # ARQ writes its own result for a job that fails before it runs, with the worker's default.
    assert (WorkerSettings.keep_result, WorkerSettings.keep_result_forever) == (0, False)


def test_registration_keeps_names_tries_and_timeouts() -> None:
    functions = {
        f.name: (f.max_tries, f.timeout_s)
        for f in WorkerSettings.functions
        if isinstance(f, Function)
    }

    # None: the worker's own default, as when the coroutine was registered bare.
    assert functions == {
        "ping": (None, None),
        "dispatch_request": (None, None),
        "send_push": (get_settings().push_max_attempts, None),
        "sanitize_request_media": (
            get_settings().media_sanitize_max_tries + SANITIZE_SPARE_TRIES,
            get_settings().media_sanitize_job_timeout_seconds,
        ),
    }


def test_cron_jobs_and_their_minutes() -> None:
    crons = {job.name: job.minute for job in WorkerSettings.cron_jobs}

    assert crons == {
        "cron:check_push_receipts": set(range(0, 60, get_settings().push_receipt_check_minutes)),
        "cron:sweep_orphan_uploads": set(range(0, 60, get_settings().orphan_upload_sweep_minutes)),
    }


@pytest.fixture
async def redis() -> AsyncIterator[ArqRedis]:
    """The real Redis of REDIS_URL, on a private queue whose keys are deleted afterwards."""
    client = ArqRedis.from_url(Settings().redis_url)
    client.default_queue_name = f"test-worker-{uuid.uuid4().hex}"
    try:
        yield client
    finally:
        keys = [key async for key in client.scan_iter(match=f"*{client.default_queue_name}*")]
        await client.delete(client.default_queue_name, *keys)
        await client.aclose()


async def redis_contents(redis: ArqRedis) -> bytes:
    """Every key and value in Redis: where a leaked literal would show."""
    chunks: list[bytes] = []
    async for key in redis.scan_iter(count=1_000):
        chunks.append(key)
        kind = (await redis.type(key)).decode()
        if kind == "string":
            chunks.append(await redis.get(key) or b"")
        elif kind == "hash":
            # cast: redis-py types these replies as sync or async; this client is async.
            pairs = await cast("Awaitable[dict[bytes, bytes]]", redis.hgetall(key))
            for field, value in pairs.items():
                chunks += [field, value]
        elif kind == "list":
            chunks += await cast("Awaitable[list[bytes]]", redis.lrange(key, 0, -1))
        elif kind == "set":
            chunks += list(await cast("Awaitable[set[bytes]]", redis.smembers(key)))
        elif kind == "zset":
            chunks += await redis.zrange(key, 0, -1)
    return b"|".join(chunks)


def failing_database(canary: str) -> dict[str, object]:
    """A job context whose database refuses a statement holding `canary` as a literal."""

    def session_factory() -> None:
        # Only an error's text: the statement never reaches a database.
        statement = f"UPDATE service_requests SET description = '{canary}'"  # noqa: S608
        raise ProgrammingError(statement, {"description": canary}, Exception("permission denied"))

    return {"session_factory": session_factory}


async def run_burst(worker: Worker) -> None:
    async with asyncio.timeout(15):
        await worker.async_run()


def burst_worker(redis: ArqRedis, ctx: dict[str, object], **overrides: object) -> Worker:
    """The worker as WorkerSettings builds it, on the private queue, without its cron jobs and
    startup (the context is the test's)."""
    options: dict[str, object] = {
        "redis_pool": redis,
        "queue_name": redis.default_queue_name,
        "burst": True,
        "handle_signals": False,
        "poll_delay": 0.01,
        "cron_jobs": None,
        "on_startup": None,
        "on_shutdown": None,
        "ctx": ctx,
    }
    # create_worker types each keyword as its Worker parameter; these are mixed test overrides.
    return create_worker(WorkerSettings, **{**options, **overrides})  # type: ignore[arg-type]


@pytest.mark.parametrize("registered", [True, False])
async def test_failed_job_leaves_no_result_in_redis(redis: ArqRedis, registered: bool) -> None:
    # registered=False is the control: dispatch_request registered bare, with ARQ's default of an
    # hour, keeps the statement's literal in Redis. So the check below can see a leak.
    canary = f"canary-{uuid.uuid4().hex}"
    job_id = f"{redis.default_queue_name}:dispatch"
    overrides: dict[str, object] = {}
    if not registered:
        overrides = {"functions": [func(dispatch_request)], "keep_result": 3_600}
    worker = burst_worker(redis, failing_database(canary), **overrides)

    await redis.enqueue_job("dispatch_request", str(uuid.uuid4()), _job_id=job_id)
    await run_burst(worker)

    assert (worker.jobs_failed, worker.jobs_complete) == (1, 0)
    kept = await redis.exists(f"arq:result:{job_id}")
    leaked = canary.encode() in await redis_contents(redis)
    assert (kept, leaked) == ((0, False) if registered else (1, True))


async def test_job_past_its_tries_leaves_no_result_in_redis(redis: ArqRedis) -> None:
    # ARQ fails such a job before it runs and writes its result with the worker's default.
    job_id = f"{redis.default_queue_name}:dispatch"
    worker = burst_worker(redis, failing_database("unused"))

    await redis.enqueue_job("dispatch_request", str(uuid.uuid4()), _job_id=job_id, _job_try=99)
    await run_burst(worker)

    assert worker.jobs_failed == 1
    assert not await redis.exists(f"arq:result:{job_id}")
