"""Worker side of Stripe webhooks (D7.3, #40): the ARQ task POST /v1/webhooks/stripe queues."""

import logging
import uuid
from typing import Any

from arq import Retry
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.modules.webhooks.service import ProcessConfig, ProcessOutcome, StripeEventProcessor
from app.queue import JobQueue

logger = logging.getLogger(__name__)


async def process_stripe_event(ctx: dict[str, Any], webhook_event_id: str) -> str:
    """ARQ task: handles one stored event in its own transaction and returns the outcome. ARQ
    gives it STRIPE_WEBHOOK_MAX_ATTEMPTS runs (app/worker.py). A handler error asks for a later
    run until the row is failed; a database error outside the handler leaves the row pending and
    asks for one too, except on the last run, which logs it and ends. Once the event's writes
    are committed (and the session closed), what the handler announced runs: the job pushes
    (#65). A push that cannot be queued is logged, never retried by this task."""
    settings: Settings = ctx["settings"]
    attempt: int = ctx["job_try"]
    last_try = attempt >= settings.stripe_webhook_max_attempts
    processor_config = ProcessConfig.from_settings(settings)
    try:
        async with ctx["session_factory"]() as session:
            result = await StripeEventProcessor(session, processor_config).process(
                uuid.UUID(webhook_event_id), last_try=last_try
            )
    except (SQLAlchemyError, OSError):
        # Its text can hold SQL literals: never logged. TimeoutError is an OSError.
        if last_try:
            logger.error("stripe_webhook_unsettled", extra={"webhook_event_id": webhook_event_id})
            return "unsettled"
        logger.warning("stripe_webhook_task_retry", extra={"webhook_event_id": webhook_event_id})
        raise Retry(defer=settings.stripe_webhook_retry_backoff_seconds * attempt) from None
    if result.outcome is ProcessOutcome.RETRY:
        raise Retry(defer=result.retry_in_seconds)
    if result.after_commit:
        # ARQ's own pool (an ArqRedis) queues the pushes; tests pass a fake queue.
        queue: JobQueue = ctx["redis"]
        for action in result.after_commit:
            await action(queue, settings.job_enqueue_timeout_seconds)
    return str(result.outcome)
