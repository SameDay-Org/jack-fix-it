"""Handing a confirmed job's transfer to the worker (#68). A leaf (it imports the queue port
only), so the jobs module can queue a release after a confirmation without importing the
release itself, which reads jobs.
"""

import logging
import uuid
from typing import Final

from redis.exceptions import RedisError

from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

# The worker function's name (transfer_tasks.release_transfer, registered in app/worker.py).
RELEASE_TRANSFER_TASK: Final = "release_transfer"


async def enqueue_transfer_release(
    queue: JobQueue, job_id: uuid.UUID, timeout_seconds: float
) -> None:
    """Queues the release of the job's transfer, after the commit that confirmed the job. One
    queued run per job at a time (the job id names it). Never raises for a queue failure: the
    confirmation stands, and the sweep (release_confirmed_jobs) releases the job on its next
    run. Logged with the job id only."""
    try:
        await enqueue(
            queue,
            RELEASE_TRANSFER_TASK,
            str(job_id),
            job_id=f"release-transfer:{job_id}",
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        logger.error("transfer_release_enqueue_failed", extra={"job_id": str(job_id)})
