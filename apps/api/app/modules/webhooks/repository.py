import uuid
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.webhooks.models import WebhookEvent, WebhookEventStatus


class WebhookEventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def insert_new(
        self,
        *,
        stripe_event_id: str,
        event_type: str,
        livemode: bool,
        stripe_created_at: datetime,
        status: WebhookEventStatus,
        payload: dict[str, object] | None,
    ) -> uuid.UUID | None:
        """The new row's id, or None when a row with this event id exists. Race-safe: a
        concurrent insert of the same id waits for the other transaction, then does nothing if
        it committed. An event stored as anything but pending is settled at once."""
        statement = (
            insert(WebhookEvent)
            .values(
                stripe_event_id=stripe_event_id,
                event_type=event_type,
                livemode=livemode,
                stripe_created_at=stripe_created_at,
                status=status,
                payload=payload,
                processed_at=None if status is WebhookEventStatus.PENDING else func.now(),
            )
            .on_conflict_do_nothing(index_elements=[WebhookEvent.stripe_event_id])
            .returning(WebhookEvent.id)
        )
        return (await self._session.execute(statement)).scalar_one_or_none()

    async def find(self, stripe_event_id: str) -> tuple[uuid.UUID, WebhookEventStatus] | None:
        """The id and status of the event's row."""
        statement = select(WebhookEvent.id, WebhookEvent.status).where(
            WebhookEvent.stripe_event_id == stripe_event_id
        )
        row = (await self._session.execute(statement)).one_or_none()
        return None if row is None else (row.id, row.status)

    async def get_for_update(self, webhook_event_id: uuid.UUID) -> WebhookEvent | None:
        """The row, locked until the transaction ends: one worker handles it at a time."""
        statement = (
            select(WebhookEvent).where(WebhookEvent.id == webhook_event_id).with_for_update()
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def settle(
        self, webhook_event_id: uuid.UUID, status: WebhookEventStatus, *, attempts: int
    ) -> None:
        """Processed or ignored: done for good, so the payload goes."""
        await self._session.execute(
            update(WebhookEvent)
            .where(WebhookEvent.id == webhook_event_id)
            .values(status=status, attempts=attempts, processed_at=func.now(), payload=None)
        )

    async def record_failure(
        self,
        webhook_event_id: uuid.UUID,
        *,
        attempts: int,
        error_class: str,
        status: WebhookEventStatus,
    ) -> None:
        """A handler run failed: pending (to run again) or failed (no run left). The payload
        stays for a later reprocess."""
        await self._session.execute(
            update(WebhookEvent)
            .where(WebhookEvent.id == webhook_event_id)
            .values(status=status, attempts=attempts, last_error=error_class)
        )
