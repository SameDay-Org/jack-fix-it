"""The requests' part of an account deletion (#97).

A request a job or a payment points at stays, but loses what the customer typed (its
description and intake answers, replaced). A request the customer can still leave is
cancelled by the customer: open (no quote accepted yet), or accepted with nothing paid and no
job (the payment sheet was never finished): no pro may quote on it any more, and its accepted
quote no longer holds its pro. The request's media rows go at once, so nothing serves them;
the caller deletes their files from storage (accounts.cleanup): the originals, the safe copies,
and for a row without one, every key its copy can get (a copy still being made, or one a
failed try uploaded after all).
"""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from typing import Final

from sqlalchemy import Select, and_, delete, or_, select, update
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

# The statuses a customer may cancel from before any quote is accepted.
OPEN: Final = (
    RequestStatus.RECEIVED,
    RequestStatus.REVIEWING,
    RequestStatus.FINDING_PRO,
    RequestStatus.QUOTE_READY,
)
CANCELLABLE: Final = (*OPEN, RequestStatus.ACCEPTED)
# Every extension a safe copy can have (media.sanitize).
SAFE_EXTENSIONS: Final = tuple(
    sorted({output.extension for output in IMAGE_OUTPUTS.values()} | set(VIDEO_EXTENSIONS.values()))
)


@dataclass(frozen=True)
class HeldRequest:
    request_id: uuid.UUID
    status: RequestStatus  # as locked


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

    @staticmethod
    def accepted_request_ids() -> Select[uuid.UUID]:
        """The ids of the requests still accepted, as a statement (quotes.erasure: an accepted
        quote holds its pro only while its request does)."""
        return select(ServiceRequest.id).where(ServiceRequest.status == RequestStatus.ACCEPTED)

    async def hold_cancellable(
        self, customer_id: uuid.UUID, with_a_job: Select[uuid.UUID]
    ) -> list[HeldRequest]:
        """Locks, in id order, each of the customer's requests the deletion may cancel: open,
        or accepted without a job (jobs.erasure's statement). Taken before the user's row, in
        the order a payment takes them (the request, then the user), and held to the commit:
        nothing accepts, pays or expires them meanwhile. Each with its status as locked."""
        statement = (
            select(ServiceRequest.id)
            .where(
                ServiceRequest.customer_id == customer_id,
                or_(
                    ServiceRequest.status.in_(OPEN),
                    and_(
                        ServiceRequest.status == RequestStatus.ACCEPTED,
                        ServiceRequest.id.not_in(with_a_job),
                    ),
                ),
            )
            .order_by(ServiceRequest.id)
        )
        machine = RequestStateMachine(self._session)
        held: list[HeldRequest] = []
        for request_id in list(await self._session.scalars(statement)):
            locked = await machine.lock(request_id)
            if locked is not None:
                held.append(HeldRequest(request_id, locked.status))
        return held

    async def cancel(
        self, customer: UserAccount, held: list[HeldRequest], *, keep: Collection[uuid.UUID]
    ) -> int:
        """Cancels, as the customer and through the state machine, each held request still
        open or accepted, but those in `keep` (a job or a payment still open, read under the
        locks); how many. Runs before any other write of the deletion: a transition drains the
        unit of work first."""
        machine = RequestStateMachine(self._session)
        cancelled = 0
        for request in held:
            if request.request_id in keep or request.status not in CANCELLABLE:
                continue
            await machine.transition(request.request_id, RequestStatus.CANCELLED, customer)
            cancelled += 1
        return cancelled

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
                select(
                    RequestMedia.id,
                    RequestMedia.file_key,
                    RequestMedia.safe_key,
                    RequestMedia.safe_status,
                ).where(RequestMedia.request_id.in_(mine))
            )
        ).all()
        keys: list[str] = []
        in_flight = False
        for media_id, file_key, safe_key, safe_status in rows:
            keys.append(file_key)
            if safe_key is not None:
                keys.append(safe_key)
            else:
                # A copy still being made, or one a failed try uploaded after all: its key is
                # derived from the row (media_copies.safe_key_for), whatever its extension.
                keys.extend(safe_key_for(media_id, extension) for extension in SAFE_EXTENSIONS)
            in_flight = in_flight or safe_status is MediaSafeStatus.PENDING
        await self._session.execute(
            delete(RequestMedia)
            .where(RequestMedia.request_id.in_(mine))
            .execution_options(synchronize_session=False)
        )
        return ErasedMedia(keys=keys, copy_in_flight=in_flight)
