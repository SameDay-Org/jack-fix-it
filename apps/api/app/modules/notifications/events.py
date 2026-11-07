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


async def push_quote_accepted(
    queue: JobQueue,
    *,
    pro_user_id: uuid.UUID,
    quote_id: uuid.UUID,
    dispatch_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To a pro, for their quote the customer accepted (#189); opens their opportunity (#49)."""
    await _push(
        queue,
        pro_user_id,
        message_id=f"quote_accepted:{quote_id}",
        kind="quote_accepted",
        params={"public_code": public_code},
        deep_link=f"/opportunities/{dispatch_id}",
        timeout_seconds=timeout_seconds,
    )


# The job's steps (#65). Each happens once per job (the state machine has one edge into each),
# so the job's id and the step name the event: a retried request or Stripe event sends once.


async def push_job_booked(
    queue: JobQueue,
    *,
    customer_id: uuid.UUID,
    job_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the customer, once their payment created the job (#61); opens their job (#64)."""
    await _job_push(
        queue, customer_id, "job_booked", job_id, request_id, public_code, timeout_seconds
    )


async def push_job_scheduled(
    queue: JobQueue,
    *,
    pro_user_id: uuid.UUID,
    job_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the pro, once the customer's payment created their job (#61); opens the job (#63)."""
    await _push(
        queue,
        pro_user_id,
        message_id=f"job_scheduled:{job_id}",
        kind="job_scheduled",
        params={"public_code": public_code},
        deep_link=f"/jobs/{job_id}",
        timeout_seconds=timeout_seconds,
    )


async def push_job_on_the_way(
    queue: JobQueue,
    *,
    customer_id: uuid.UUID,
    job_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the customer, when the pro taps On my way (#63). The copy points to the app for the
    arrival code and the ETA: neither is in the push. An ETA update sends nothing."""
    await _job_push(
        queue, customer_id, "job_on_the_way", job_id, request_id, public_code, timeout_seconds
    )


async def push_job_checked_in(
    queue: JobQueue,
    *,
    customer_id: uuid.UUID,
    job_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the customer, when the pro checks in with the arrival code (#63)."""
    await _job_push(
        queue, customer_id, "job_checked_in", job_id, request_id, public_code, timeout_seconds
    )


async def push_job_started(
    queue: JobQueue,
    *,
    customer_id: uuid.UUID,
    job_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the customer, when the pro starts the job (#63)."""
    await _job_push(
        queue, customer_id, "job_started", job_id, request_id, public_code, timeout_seconds
    )


async def push_booking_not_completed(
    queue: JobQueue,
    *,
    customer_id: uuid.UUID,
    payment_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """To the customer, when a canceled payment reopened their request's quotes (#61, #297);
    opens the request. A payment is canceled once: its id names the event."""
    await _push(
        queue,
        customer_id,
        message_id=f"booking_not_completed:{payment_id}",
        kind="booking_not_completed",
        params={"public_code": public_code},
        deep_link=f"/requests/{request_id}",
        timeout_seconds=timeout_seconds,
    )


async def _job_push(
    queue: JobQueue,
    customer_id: uuid.UUID,
    kind: str,
    job_id: uuid.UUID,
    request_id: uuid.UUID,
    public_code: str,
    timeout_seconds: float,
) -> None:
    """A job step to the customer: opens the job of their request (#64)."""
    await _push(
        queue,
        customer_id,
        message_id=f"{kind}:{job_id}",
        kind=kind,
        params={"public_code": public_code},
        deep_link=f"/requests/{request_id}/job",
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
