"""The kick after a pro may have become eligible (#478), for the modules where that happens.

A request sent while no pro was eligible keeps no dispatch row; the sweep (dispatch.tasks
redispatch_stalled_requests) queues its dispatch again within REDISPATCH_SWEEP_MINUTES. When a
pro may have just become eligible (approved by staff, payouts enabled, categories or service
areas changed), the module that made the change queues one `redispatch_for_pro` for that pro
after its commit, so the requests waiting for them need not wait for the sweep.

Best effort: one job per pro (job id `redispatch-pro:<pro id>`, deduped while queued); a queue
that fails is logged (ids only) and never undoes or fails the change; the sweep is the net. A
leaf module (it imports no other module), so any module may call it without an import cycle.
"""

import logging
import uuid
from dataclasses import dataclass
from typing import Final

from redis.exceptions import RedisError

from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

REDISPATCH_FOR_PRO_TASK: Final = "redispatch_for_pro"


def redispatch_pro_job_id(pro_id: uuid.UUID) -> str:
    """One kick per pro at a time: a second enqueue while it is queued is a no-op."""
    return f"redispatch-pro:{pro_id}"


@dataclass(frozen=True)
class RedispatchKick:
    queue: JobQueue
    timeout_seconds: float

    async def after_commit(self, pro_id: uuid.UUID, reason: str) -> None:
        """Queues redispatch_for_pro(pro_id). Call it after the change's commit; `reason` is
        a fixed word for the log (approved, payouts_enabled, coverage_changed)."""
        try:
            await enqueue(
                self.queue,
                REDISPATCH_FOR_PRO_TASK,
                str(pro_id),
                job_id=redispatch_pro_job_id(pro_id),
                timeout_seconds=self.timeout_seconds,
            )
        except (RedisError, OSError):  # TimeoutError is an OSError
            logger.error("redispatch_kick_failed", extra={"pro_id": str(pro_id), "reason": reason})
