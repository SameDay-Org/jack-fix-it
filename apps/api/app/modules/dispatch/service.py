"""Dispatch (D9.1, #48): sends a categorized request to up to N eligible pros.

`dispatch_request` locks the request (the state machine's row lock), then by its status:
- received without a category: to reviewing (SYSTEM), for the BDC to classify; no dispatch;
- received or reviewing with a category: the eligible pros, best ranked first, up to
  `dispatch_max_pros` (settings); one request_dispatches row each and the move to finding_pro,
  in the caller's transaction;
- anything else, or rows already there: nothing. A re-run never sends twice: the row lock
  makes concurrent runs take turns, and the second finds the first's work.
No eligible pro: no row, no transition, a log (the BDC alert is #51).

Eligible (context doc section 5): an approved profile with payouts enabled, an active account
with the pro role, the request's category, and an active service area with the address's ZIP.
Ranked by rating (best first, unrated last), then average response time (fastest first, no
answers yet last), then the pro least recently sent a request (never sent first), then the
profile id, so equal pros share the work and the order is deterministic.

Logs carry ids, statuses and counts only.
"""

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.service import AddressService
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.dispatch.repository import ACTIVE, DispatchRepository, ProHistory
from app.modules.jobs.service import SYSTEM
from app.modules.pros.service import DispatchCandidate, ProService
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.service_areas.service import ServiceAreaService
from app.modules.settings.service import SettingsService
from app.modules.users.service import UserService
from app.modules.users.types import UserRole
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

DISPATCH_TASK: Final = "dispatch_request"
_DISPATCHABLE: Final = frozenset({RequestStatus.RECEIVED, RequestStatus.REVIEWING})


class DispatchOutcome(StrEnum):
    SENT = "sent"
    TO_REVIEW = "to_review"
    NO_ELIGIBLE_PROS = "no_eligible_pros"
    ALREADY_DISPATCHED = "already_dispatched"
    NOT_DISPATCHABLE = "not_dispatchable"
    UNKNOWN_REQUEST = "unknown_request"


def dispatch_job_id(request_id: uuid.UUID) -> str:
    """One dispatch job per request: a second enqueue while it is kept is a no-op."""
    return f"dispatch:{request_id}"


async def enqueue_dispatch(queue: JobQueue, request_id: uuid.UUID, timeout_seconds: float) -> bool:
    """Queues dispatch_request for the request (after its commit). See app.queue.enqueue."""
    return await enqueue(
        queue,
        DISPATCH_TASK,
        str(request_id),
        job_id=dispatch_job_id(request_id),
        timeout_seconds=timeout_seconds,
    )


def rank(
    candidates: list[DispatchCandidate], history: dict[uuid.UUID, ProHistory]
) -> list[uuid.UUID]:
    """Best first: rating DESC (unrated last), average response ASC (none last), least
    recently dispatched (never first), then profile id."""

    def key(candidate: DispatchCandidate) -> tuple[bool, float, bool, float, bool, float, str]:
        past = history.get(candidate.pro_id)
        rating = candidate.rating_avg
        response = past.avg_response_seconds if past is not None else None
        last_sent = past.last_sent_at if past is not None else None
        return (
            rating is None,
            -float(rating) if rating is not None else 0.0,
            response is None,
            response if response is not None else 0.0,
            last_sent is not None,
            last_sent.timestamp() if last_sent is not None else 0.0,
            str(candidate.pro_id),
        )

    return [candidate.pro_id for candidate in sorted(candidates, key=key)]


@dataclass(frozen=True)
class ProDispatch:
    """A pro's own dispatch, as quoting needs it (#50)."""

    id: uuid.UUID
    request_id: uuid.UUID
    status: DispatchStatus

    @property
    def active(self) -> bool:
        """Still the pro's to act on: sent or viewed (not declined, quoted or expired)."""
        return self.status in ACTIVE


@dataclass(frozen=True)
class NewDispatch:
    """A dispatch a run created: what the new request push needs after the commit (#55)."""

    id: uuid.UUID
    pro_user_id: uuid.UUID
    public_code: str


@dataclass(frozen=True)
class DispatchResult:
    outcome: DispatchOutcome
    new: tuple[NewDispatch, ...] = ()  # only when SENT


class DispatchService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._dispatches = DispatchRepository(session)
        self._requests = RequestStateMachine(session)

    async def dispatch_request(self, request_id: uuid.UUID) -> DispatchOutcome:
        """dispatch(), the outcome only."""
        return (await self.dispatch(request_id)).outcome

    async def dispatch(self, request_id: uuid.UUID) -> DispatchResult:
        """Dispatches one request in the caller's transaction (flushes, never commits), and
        returns the dispatches it created, for the caller to announce once it commits. Also
        what the BDC runs again after classifying a request (#82) that dispatch took to
        reviewing: it has no rows yet. A request with rows is never dispatched again, including
        one the BDC pulled back from finding_pro; what a re-dispatch does with the old rows is
        open (#82)."""
        extra = {"service_request_id": str(request_id)}
        request = await self._requests.lock(request_id)
        if request is None:
            return self._done(DispatchOutcome.UNKNOWN_REQUEST, extra)
        if await self._dispatches.exists_for(request.id):
            return self._done(DispatchOutcome.ALREADY_DISPATCHED, extra)
        if request.status is RequestStatus.RECEIVED and request.category_id is None:
            await self._requests.transition(request.id, RequestStatus.REVIEWING, SYSTEM)
            return self._done(DispatchOutcome.TO_REVIEW, extra)
        if request.status not in _DISPATCHABLE or request.category_id is None:
            return self._done(
                DispatchOutcome.NOT_DISPATCHABLE, {**extra, "status": str(request.status)}
            )

        chosen = await self._eligible_ranked(request.category_id, request.address_id)
        chosen = chosen[: await SettingsService(self._session).dispatch_max_pros()]
        if not chosen:
            return self._done(
                DispatchOutcome.NO_ELIGIBLE_PROS,
                {**extra, "category_id": str(request.category_id)},
                event="dispatch_no_eligible_pros",
            )
        now = datetime.now(UTC)
        rows = [
            RequestDispatch(request_id=request.id, pro_id=candidate.pro_id, sent_at=now)
            for candidate in chosen
        ]
        await self._dispatches.add_many(rows)
        await self._requests.transition(request.id, RequestStatus.FINDING_PRO, SYSTEM)
        new = tuple(
            NewDispatch(row.id, candidate.user_id, request.public_code)
            for row, candidate in zip(rows, chosen, strict=True)
        )
        return self._done(DispatchOutcome.SENT, {**extra, "count": len(chosen)}, new=new)

    async def _eligible_ranked(
        self, category_id: uuid.UUID, address_id: uuid.UUID
    ) -> list[DispatchCandidate]:
        address = await AddressService(self._session).get(address_id)
        if address is None:  # pragma: no cover - the foreign key guarantees it
            return []
        areas = await ServiceAreaService(self._session).active_ids_for_zip(address.zip_code)
        candidates = await ProService(self._session).dispatch_candidates(category_id, areas)
        active = await UserService(self._session).active_ids_with_role(
            [c.user_id for c in candidates], UserRole.PRO
        )
        candidates = [c for c in candidates if c.user_id in active]
        history = await self._dispatches.history([c.pro_id for c in candidates])
        by_id = {c.pro_id: c for c in candidates}
        return [by_id[pro_id] for pro_id in rank(candidates, history)]

    @staticmethod
    def _done(
        outcome: DispatchOutcome,
        extra: Mapping[str, object],
        *,
        event: str = "dispatch_done",
        new: tuple[NewDispatch, ...] = (),
    ) -> DispatchResult:
        logger.info(event, extra={**extra, "outcome": str(outcome)})
        return DispatchResult(outcome, new)

    async def pro_dispatch(self, dispatch_id: uuid.UUID, pro_id: uuid.UUID) -> ProDispatch | None:
        """The pro's own dispatch in any status; None for another pro's or an unknown id."""
        row = await self._dispatches.get_for_pro(dispatch_id, pro_id)
        return ProDispatch(row.id, row.request_id, row.status) if row is not None else None

    async def mark_quoted(self, dispatch_id: uuid.UUID, now: datetime) -> bool:
        """The pro answered with a quote: sent or viewed -> quoted, responded_at = now, in the
        caller's transaction. False when the dispatch was no longer active."""
        return await self._dispatches.mark_quoted(dispatch_id, now)
