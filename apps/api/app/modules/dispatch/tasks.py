"""Worker side of dispatch (D9.1, #48): the ARQ task POST /v1/requests queues."""

import uuid
from typing import Any

from app.modules.dispatch.service import DispatchService


async def dispatch_request(ctx: dict[str, Any], request_id: str) -> str:
    """ARQ task: dispatches one request in its own transaction and returns the outcome. A
    database error fails the job (ARQ logs it); the request keeps its status, and the BDC can
    run dispatch again (#82)."""
    async with ctx["session_factory"]() as session:
        outcome = await DispatchService(session).dispatch_request(uuid.UUID(request_id))
        await session.commit()
    return str(outcome)
