"""Worker side of dispatch (D9.1, #48): the ARQ task POST /v1/requests queues."""

import uuid
from typing import Any

from app.config import Settings
from app.modules.dispatch.service import DispatchService
from app.modules.notifications.events import push_new_request
from app.queue import JobQueue


async def dispatch_request(ctx: dict[str, Any], request_id: str) -> str:
    """ARQ task: dispatches one request in its own transaction and returns the outcome. A
    database error fails the job (ARQ logs it); the request keeps its status, and the BDC can
    run dispatch again (#82). Once committed, each dispatched pro gets a new request push
    (#55); a push that cannot be queued is logged, never undone."""
    async with ctx["session_factory"]() as session:
        result = await DispatchService(session).dispatch(uuid.UUID(request_id))
        await session.commit()
    if result.new:
        settings: Settings = ctx["settings"]
        # ARQ's own pool (an ArqRedis) queues the pushes; tests pass a fake queue.
        queue: JobQueue = ctx["redis"]
        for dispatch in result.new:
            await push_new_request(
                queue,
                pro_user_id=dispatch.pro_user_id,
                dispatch_id=dispatch.id,
                public_code=dispatch.public_code,
                timeout_seconds=settings.job_enqueue_timeout_seconds,
            )
    return str(result.outcome)
