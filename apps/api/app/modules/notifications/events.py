"""The transactional pushes a feature sends after its commit (D10.4, #55): one function each.

Each one queues the push (enqueue_push) and never fails the action it announces: the action
is already committed, so a Redis error or a timeout is logged with ids only and dropped. The
message id is the event's own id, so announcing the same event twice sends it once. Whether
the user is active, and in which language, the worker decides at send time (push_tasks).
"""

import logging
import uuid
from collections.abc import Mapping

from redis.exceptions import RedisError

from app.modules.notifications.service import enqueue_push
from app.queue import JobQueue

logger = logging.getLogger(__name__)


async def push_new_request(
    queue: JobQueue,
    *,
    pro_user_id: uuid.UUID,
    dispatch_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To a pro, for a request dispatched to them (#48); opens the opportunity (#49)."""
    await _push(
        queue,
        pro_user_id,
        message_id=f"dispatch:{dispatch_id}",
        kind="new_request",
        params={"public_code": public_code},
        deep_link=f"/opportunities/{dispatch_id}",
        timeout_seconds=timeout_seconds,
    )


async def push_new_quote(
    queue: JobQueue,
    *,
    customer_id: uuid.UUID,
    quote_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the customer, for a quote a pro sent on their request (#50); opens the request."""
    await _push(
        queue,
        customer_id,
        message_id=f"quote:{quote_id}",
        kind="new_quote",
        params={"public_code": public_code},
        deep_link=f"/requests/{request_id}",
        timeout_seconds=timeout_seconds,
    )


async def _push(
    queue: JobQueue,
    user_id: uuid.UUID,
    *,
    message_id: str,
    kind: str,
    params: Mapping[str, str],
    deep_link: str,
    timeout_seconds: float,
) -> None:
    try:
        await enqueue_push(
            queue,
            user_id,
            message_id=message_id,
            title_key=f"push.{kind}.title",
            body_key=f"push.{kind}.body",
            params=params,
            deep_link=deep_link,
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        # The message id is the event's kind and id: ids only.
        logger.error(
            "push_enqueue_failed", extra={"user_id": str(user_id), "message_id": message_id}
        )
