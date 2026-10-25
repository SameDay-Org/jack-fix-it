"""Handing work to the ARQ worker: the one queue port for dispatch (#48) and pushes (#54).

The API's Redis client is ARQ's own `ArqRedis` (app/main.py), so a route can queue a job; in the
worker, ARQ's ctx["redis"] is the same kind of pool. A job id makes a second enqueue of the same
work a no-op while the first is queued, running or kept. Every enqueue is bounded by the
caller's timeout: JOB_ENQUEUE_TIMEOUT_SECONDS for dispatch and the event pushes
(notifications.events, #55), PUSH_SEND_TIMEOUT_SECONDS for the push worker's own resends.
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
