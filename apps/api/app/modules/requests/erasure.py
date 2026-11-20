"""The requests' part of an account deletion (#97).

A request a job or a payment points at stays, but loses what the customer typed (its
description and intake answers, replaced). A request still open (no quote accepted) is
cancelled by the customer: nothing has been paid, and no pro may quote on it any more. The
request's media rows go at once, so nothing serves them; the caller deletes their files from
storage (accounts.cleanup): the originals, the safe copies, and for a copy still being made the
key it would get.
"""

import uuid
from dataclasses import dataclass
from typing import Final

from sqlalchemy import Select, delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.media.sanitize import IMAGE_OUTPUTS, VIDEO_EXTENSIONS
from app.modules.requests.media_copies import safe_key_for
from app.modules.requests.models import (
    MediaSafeStatus,
    RequestMedia,
    RequestStatus,
    ServiceRequest,
)
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.users.types import ERASED_TEXT, UserAccount

# The statuses a customer may cancel from: before any quote is accepted.
OPEN: Final = (
    RequestStatus.RECEIVED,
    RequestStatus.REVIEWING,
    RequestStatus.FINDING_PRO,
    RequestStatus.QUOTE_READY,
)
# Every extension a safe copy can have (media.sanitize): a copy still being made gets one.
SAFE_EXTENSIONS: Final = tuple(
    sorted({output.extension for output in IMAGE_OUTPUTS.values()} | set(VIDEO_EXTENSIONS.values()))
)


@dataclass(frozen=True)
class ErasedMedia:
    # The storage keys of the media rows deleted: every original and safe copy they named.
    keys: list[str]
    # A copy was still being made: it may upload its safe copy after the deletion commits.
    copy_in_flight: bool


class RequestErasure:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @staticmethod
    def customer_request_ids(customer_id: uuid.UUID) -> Select[uuid.UUID]:
        """The ids of the customer's requests, as a statement (ops.erasure's notes)."""
        return select(ServiceRequest.id).where(ServiceRequest.customer_id == customer_id)

    async def cancel_open(self, customer: UserAccount) -> int:
        """Cancels each of the customer's requests still open, as the customer, through the
        state machine; how many. Runs before any other write of the deletion: a transition
        drains the unit of work first."""
        statement = (
            select(ServiceRequest.id)
            .where(ServiceRequest.customer_id == customer.id, ServiceRequest.status.in_(OPEN))
            .order_by(ServiceRequest.created_at, ServiceRequest.id)
        )
        request_ids = list(await self._session.scalars(statement))
        machine = RequestStateMachine(self._session)
        for request_id in request_ids:
            await machine.transition(request_id, RequestStatus.CANCELLED, customer)
        return len(request_ids)

    async def erase(self, customer_id: uuid.UUID) -> ErasedMedia:
        """Replaces what the customer typed on every request, and deletes every media row."""
        mine = self.customer_request_ids(customer_id)
        await self._session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.customer_id == customer_id)
            .values(description=ERASED_TEXT, intake_answers={})
            .execution_options(synchronize_session=False)
        )
        rows = (
            await self._session.execute(
                select(RequestMedia.id, RequestMedia.file_key, RequestMedia.safe_key)
                .where(RequestMedia.request_id.in_(mine))
                .add_columns(RequestMedia.safe_status)
            )
        ).all()
        keys: list[str] = []
        in_flight = False
        for media_id, file_key, safe_key, safe_status in rows:
            keys.append(file_key)
            if safe_key is not None:
                keys.append(safe_key)
            if safe_status is MediaSafeStatus.PENDING:
                in_flight = True
                keys.extend(safe_key_for(media_id, extension) for extension in SAFE_EXTENSIONS)
        await self._session.execute(
            delete(RequestMedia)
            .where(RequestMedia.request_id.in_(mine))
            .execution_options(synchronize_session=False)
        )
        return ErasedMedia(keys=keys, copy_in_flight=in_flight)
