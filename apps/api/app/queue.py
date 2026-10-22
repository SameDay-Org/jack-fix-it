"""Handing work from the API to the ARQ worker (D9.1, #48).

The API's Redis client is ARQ's own `ArqRedis` (app/main.py), so a route can queue a job. A job
id makes a second enqueue of the same work a no-op while the first is queued, running or kept.
Every enqueue waits at most JOB_ENQUEUE_TIMEOUT_SECONDS.
"""

import asyncio
from typing import Any, Protocol

from arq.connections import ArqRedis
from starlette.requests import Request


class JobQueue(Protocol):
    async def enqueue_job(self, function: str, *args: Any, _job_id: str | None = None) -> object:
        """ARQ's ArqRedis.enqueue_job: None when a job with this id already exists."""
        ...


def get_job_queue(request: Request) -> JobQueue:
    """FastAPI dependency: the app's ArqRedis, created at startup (app.main lifespan)."""
    queue: ArqRedis = request.app.state.redis
    return queue


async def enqueue(
    queue: JobQueue, function: str, *args: Any, job_id: str, timeout_seconds: float
) -> bool:
    """Queues `function(*args)` under `job_id`. False when a job with that id already exists.
    Raises TimeoutError after `timeout_seconds`, RedisError or OSError when Redis fails: the
    caller decides whether the work may be lost."""
    async with asyncio.timeout(timeout_seconds):
        job = await queue.enqueue_job(function, *args, _job_id=job_id)
    return job is not None
