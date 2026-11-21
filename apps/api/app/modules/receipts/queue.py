"""Handing a receipt email to the worker (#62). A leaf (it imports the queue port only), so the
payment and tip webhooks can queue one after their commit without importing what sends it,
which reads payments and tips."""

import logging
import uuid
from typing import Final

from redis.exceptions import RedisError

from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

# The worker functions' names (receipts.tasks, registered in app/worker.py).
PAYMENT_RECEIPT_TASK: Final = "send_payment_receipt"
TIP_RECEIPT_TASK: Final = "send_tip_receipt"


async def enqueue_payment_receipt(
    queue: JobQueue, payment_id: uuid.UUID, timeout_seconds: float
) -> None:
    """Queues the payment's receipt email, after the commit that booked its job. One queued run
    per payment (its id names it). Never raises for a queue failure: the booking stands, and
    the receipt stays in the app. Logged with the payment id only."""
    try:
        await enqueue(
            queue,
            PAYMENT_RECEIPT_TASK,
            str(payment_id),
            job_id=f"payment-receipt:{payment_id}",
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        logger.error("payment_receipt_enqueue_failed", extra={"payment_id": str(payment_id)})


async def enqueue_tip_receipt(queue: JobQueue, tip_id: uuid.UUID, timeout_seconds: float) -> None:
    """Queues the tip's receipt email, after the commit of the event it succeeded through. As
    enqueue_payment_receipt: one run per tip, never raises for the queue."""
    try:
        await enqueue(
            queue,
            TIP_RECEIPT_TASK,
            str(tip_id),
            job_id=f"tip-receipt:{tip_id}",
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        logger.error("tip_receipt_enqueue_failed", extra={"tip_id": str(tip_id)})
