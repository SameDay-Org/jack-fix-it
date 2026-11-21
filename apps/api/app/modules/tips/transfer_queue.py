"""Handing a tip's transfer to the worker (#273 PR A2). A leaf (it imports the queue port only),
so the tip webhook can queue a release after its commit without importing the release itself.
"""

import logging
import uuid
from typing import Final

from redis.exceptions import RedisError

from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

# The worker function's name (tips.transfer_tasks.release_tip_transfer, in app/worker.py).
RELEASE_TIP_TRANSFER_TASK: Final = "release_tip_transfer"


async def enqueue_tip_transfer(queue: JobQueue, tip_id: uuid.UUID, timeout_seconds: float) -> None:
    """Queues the release of the tip's transfer, after the commit of the event it succeeded
    through. One queued run per tip at a time (the tip id names it). Never raises for a queue
    failure: the tip stands, and the sweep (release_succeeded_tips) releases it on its next
    run. Logged with the tip id only."""
    try:
        await enqueue(
            queue,
            RELEASE_TIP_TRANSFER_TASK,
            str(tip_id),
            job_id=f"release-tip-transfer:{tip_id}",
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        logger.error("tip_transfer_enqueue_failed", extra={"tip_id": str(tip_id)})
