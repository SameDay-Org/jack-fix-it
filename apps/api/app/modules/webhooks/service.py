"""Stripe webhooks (D7.3, #40): every event recorded once, then handled once by the worker.

Receiving (POST /v1/webhooks/stripe): the signature is verified on the raw body, then the event
is inserted by its Stripe id (ON CONFLICT DO NOTHING, so a redelivery or a concurrent delivery
finds the first row) and committed. Only then is a pending row queued, under one job id per
event, so a job already queued or running makes the enqueue a no-op. An event of a type with no
handler, or from the other mode (a live event outside production, a test event in it), is
stored as ignored and never queued. A row that cannot be queued answers 500: Stripe delivers
the event again, and the redelivery queues the pending row.

Processing (the worker, `StripeEventProcessor`): the row is locked; anything but pending is left
alone. The handler runs in a savepoint, and the row is marked processed (payload dropped) in the
same transaction. A handler error rolls its writes back, counts the attempt, keeps the class
name of the error and asks for a later run, until the last attempt fails the row.

Logs carry the Stripe event id, its type, the row id, attempts and status only: never the body,
the signature header, the secret or an error's text.
"""

import logging
import uuid
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, Self

from pydantic import SecretStr
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations import stripe_webhooks
from app.modules.webhooks.errors import (
    EnqueueFailedError,
    InvalidPayloadError,
    InvalidSignatureError,
    WebhookNotConfiguredError,
)
from app.modules.webhooks.handlers import StripeEvent, handler_for
from app.modules.webhooks.models import WebhookEventStatus
from app.modules.webhooks.repository import WebhookEventRepository
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

PROCESS_TASK: Final = "process_stripe_event"
# webhook_events.last_error is varchar(255).
_ERROR_CLASS_LENGTH: Final = 255


def process_job_id(stripe_event_id: str) -> str:
    """One processing job per event: a second enqueue while it is queued or running is a no-op."""
    return f"stripe-event:{stripe_event_id}"


async def enqueue_processing(
    queue: JobQueue, webhook_event_id: uuid.UUID, stripe_event_id: str, timeout_seconds: float
) -> bool:
    """Queues process_stripe_event for the row (after its commit). See app.queue.enqueue."""
    return await enqueue(
        queue,
        PROCESS_TASK,
        str(webhook_event_id),
        job_id=process_job_id(stripe_event_id),
        timeout_seconds=timeout_seconds,
    )


@dataclass(frozen=True)
class WebhookConfig:
    secret: SecretStr | None
    tolerance_seconds: int
    enqueue_timeout_seconds: float
    # Production takes live events only; every other environment takes test events only.
    live: bool

    @classmethod
    def from_settings(cls, settings: Settings) -> Self:
        return cls(
            secret=settings.stripe_webhook_secret,
            tolerance_seconds=settings.stripe_webhook_tolerance_seconds,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
            live=settings.app_env == "production",
        )


class StripeWebhookService:
    def __init__(self, session: AsyncSession, queue: JobQueue, config: WebhookConfig) -> None:
        self._session = session
        self._events = WebhookEventRepository(session)
        self._queue = queue
        self._config = config

    def ensure_configured(self) -> None:
        """503 not_configured without the signing secret: the route asks before reading the
        body."""
        self._secret()

    async def receive(self, body: bytes, signature: str | None) -> None:
        """Verifies and records the event, commits, then queues it when it is pending. A
        duplicate is a success: a pending one is queued again (a no-op while its job exists)."""
        try:
            event = stripe_webhooks.verify_event(
                body, signature, self._secret(), self._config.tolerance_seconds
            )
        except stripe_webhooks.InvalidSignatureError:
            logger.warning("stripe_webhook_invalid_signature")
            raise InvalidSignatureError from None
        except stripe_webhooks.InvalidPayloadError:
            logger.warning("stripe_webhook_invalid_payload")
            raise InvalidPayloadError from None

        status = self._status_on_arrival(event)
        row_id = await self._events.insert_new(
            stripe_event_id=event.id,
            event_type=event.type,
            livemode=event.livemode,
            stripe_created_at=event.created,
            status=status,
            payload=event.payload if status is WebhookEventStatus.PENDING else None,
        )
        if row_id is None:
            existing = await self._events.find(event.id)
            if existing is None:
                # Rows are never deleted: the insert found a committed row with this id.
                raise RuntimeError("webhook event row not found after a conflict")
            row_id, status = existing
        await self._session.commit()
        logger.info(
            "stripe_webhook_received",
            extra={
                "stripe_event_id": event.id,
                "event_type": event.type,
                "webhook_event_id": str(row_id),
                "status": str(status),
            },
        )
        if status is WebhookEventStatus.PENDING:
            await self._queue_processing(row_id, event.id)

    def _secret(self) -> str:
        if self._config.secret is None:
            raise WebhookNotConfiguredError
        return self._config.secret.get_secret_value()

    def _status_on_arrival(self, event: stripe_webhooks.VerifiedEvent) -> WebhookEventStatus:
        if event.livemode != self._config.live:
            logger.warning(
                "stripe_webhook_livemode_mismatch",
                extra={"stripe_event_id": event.id, "event_type": event.type},
            )
            return WebhookEventStatus.IGNORED
        if handler_for(event.type) is None:
            return WebhookEventStatus.IGNORED
        return WebhookEventStatus.PENDING

    async def _queue_processing(self, row_id: uuid.UUID, stripe_event_id: str) -> None:
        try:
            await enqueue_processing(
                self._queue, row_id, stripe_event_id, self._config.enqueue_timeout_seconds
            )
        except (RedisError, OSError):  # TimeoutError is an OSError
            logger.error(
                "stripe_webhook_enqueue_failed", extra={"stripe_event_id": stripe_event_id}
            )
            raise EnqueueFailedError from None


class ProcessOutcome(StrEnum):
    PROCESSED = "processed"
    IGNORED = "ignored"
    # Not pending: processed, ignored or failed already.
    SKIPPED = "skipped"
    MISSING = "missing"
    # The handler failed; run again after `retry_in_seconds`.
    RETRY = "retry"
    FAILED = "failed"


@dataclass(frozen=True)
class ProcessResult:
    outcome: ProcessOutcome
    retry_in_seconds: int | None = None


@dataclass(frozen=True)
class ProcessConfig:
    max_attempts: int
    retry_backoff_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> Self:
        return cls(
            max_attempts=settings.stripe_webhook_max_attempts,
            retry_backoff_seconds=settings.stripe_webhook_retry_backoff_seconds,
        )


class StripeEventProcessor:
    def __init__(self, session: AsyncSession, config: ProcessConfig) -> None:
        self._session = session
        self._events = WebhookEventRepository(session)
        self._config = config

    async def process(self, webhook_event_id: uuid.UUID, *, last_try: bool) -> ProcessResult:
        """Handles the pending row once and commits. `last_try`: the worker gives no further
        run, so a handler error fails the row whatever its attempts."""
        row = await self._events.get_for_update(webhook_event_id)
        if row is None:
            logger.warning(
                "stripe_webhook_row_missing", extra={"webhook_event_id": str(webhook_event_id)}
            )
            return ProcessResult(ProcessOutcome.MISSING)
        if row.status is not WebhookEventStatus.PENDING:
            return ProcessResult(ProcessOutcome.SKIPPED)
        log = {
            "stripe_event_id": row.stripe_event_id,
            "event_type": row.event_type,
            "webhook_event_id": str(row.id),
        }
        handler = handler_for(row.event_type)
        if handler is None:
            # Its handler was removed after the event arrived.
            await self._events.settle(row.id, WebhookEventStatus.IGNORED, attempts=row.attempts)
            await self._session.commit()
            logger.info("stripe_webhook_ignored", extra=log)
            return ProcessResult(ProcessOutcome.IGNORED)
        if row.payload is None:
            raise RuntimeError("a pending webhook event has no payload")
        event = StripeEvent(
            stripe_event_id=row.stripe_event_id,
            event_type=row.event_type,
            livemode=row.livemode,
            created=row.stripe_created_at,
            payload=row.payload,
        )
        # Read before the handler runs: a rolled-back savepoint can expire the row.
        row_id, attempts = row.id, row.attempts + 1
        try:
            async with self._session.begin_nested():
                await handler(self._session, event)
        except Exception as error:  # noqa: BLE001 - any handler error is counted, never its text
            return await self._record_failure(
                row_id, attempts, type(error).__name__, last_try=last_try, log=log
            )
        await self._events.settle(row_id, WebhookEventStatus.PROCESSED, attempts=attempts)
        await self._session.commit()
        logger.info("stripe_webhook_processed", extra={**log, "attempts": attempts})
        return ProcessResult(ProcessOutcome.PROCESSED)

    async def _record_failure(
        self,
        row_id: uuid.UUID,
        attempts: int,
        error_class: str,
        *,
        last_try: bool,
        log: dict[str, str],
    ) -> ProcessResult:
        final = last_try or attempts >= self._config.max_attempts
        status = WebhookEventStatus.FAILED if final else WebhookEventStatus.PENDING
        await self._events.record_failure(
            row_id,
            attempts=attempts,
            error_class=error_class[:_ERROR_CLASS_LENGTH],
            status=status,
        )
        await self._session.commit()
        extra = {**log, "attempts": attempts, "status": str(status)}
        if final:
            logger.error("stripe_webhook_failed", extra=extra)
            return ProcessResult(ProcessOutcome.FAILED)
        logger.warning("stripe_webhook_retry", extra=extra)
        return ProcessResult(
            ProcessOutcome.RETRY, retry_in_seconds=self._config.retry_backoff_seconds * attempts
        )
