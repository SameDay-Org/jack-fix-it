"""Dispatch (D9.1, #48): sends a categorized request to up to N eligible pros.

`assign` (#82) is the BDC's manual assignment: one offer for one pro staff chose, on a request
not yet accepted, under the same row lock. The pro must pass every condition below, each
answered apart (AssignRefusal), and must not have the request already; a received or reviewing
request moves to finding_pro with the offer, as the staff member's move. `assignable` lists who
staff may choose from.

`dispatch` locks the request (the state machine's row lock), then:
- held (`info_requested_at`, #82: the BDC asked the customer for more information): nothing.
  A run queued before the hold (the request's first dispatch, the sweep, a kick) ends here;
  staff release it (resume, a status change, an assignment) and the sweep takes it then;
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

Locks (#511): the request's row lock serializes the request's runs, not what makes a pro
eligible. So whoever gets an offer, by hand or by the automatic dispatch, is read again in
the writing transaction under FOR SHARE locks held to its commit, in this order: the request
(FOR UPDATE), the ZIP's active service areas, then for each pro its account, its profile, its
category and area rows. A revocation committed first (an account suspended or no longer a
pro's, a profile not approved or without payouts, a category or area dropped, an area switched
off) is read and the pro gets nothing; one made after waits until the offer is committed.

The account goes before the profile because the one writer of both takes them in that order:
a pro's new ID photo (PATCH /v1/auth/me, #250) locks the account, then writes the profile's
photo while it has none (#511 round 2: the other order deadlocked with it). Every other profile
writer locks the profile FOR UPDATE first and writes no account (the pro's own edit, staff's
review, documents, payouts onboarding, Stripe's account.updated), and the account writers
write the account alone (login, password reset, phone, role). The profile goes before its rows
because every profile writer locks it first. tests/test_dispatch_locks.py runs the real photo
write against both offers. The automatic dispatch ranks without locks, then takes the best
ranked that pass the locked read, up to `dispatch_max_pros`. The eligible list (`assignable`)
is a read and takes no lock.

Logs carry ids, statuses and counts only.
"""

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.service import AddressService
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.dispatch.repository import ACTIVE, DispatchRepository, ProHistory
from app.modules.jobs.service import SYSTEM
from app.modules.pros.service import AssignCandidate, DispatchCandidate, ProService
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.reviews.ratings import ProRatings
from app.modules.service_areas.service import ServiceAreaService
from app.modules.settings.service import SettingsService
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

DISPATCH_TASK: Final = "dispatch_request"
DISPATCHABLE: Final = frozenset({RequestStatus.RECEIVED, RequestStatus.REVIEWING})
# The statuses a request may be offered to one more pro in, by hand (#82): until a quote is
# accepted.
ASSIGNABLE: Final = DISPATCHABLE | {RequestStatus.FINDING_PRO, RequestStatus.QUOTE_READY}


class DispatchOutcome(StrEnum):
    SENT = "sent"
    TO_REVIEW = "to_review"
    NO_ELIGIBLE_PROS = "no_eligible_pros"
    ALREADY_DISPATCHED = "already_dispatched"
    NOT_DISPATCHABLE = "not_dispatchable"
    UNKNOWN_REQUEST = "unknown_request"
    HELD = "held"  # the BDC holds it (#82): nothing until staff release it


class AssignRefusal(StrEnum):
    """Why a manual assignment was refused (#82): the first reason that applies, in this
    order. Nothing was written."""

    UNKNOWN_REQUEST = "unknown_request"
    NOT_ASSIGNABLE = "not_assignable"  # accepted, expired or cancelled
    NOT_CLASSIFIED = "not_classified"  # no category to match a pro against
    UNKNOWN_PRO = "unknown_pro"  # no such profile, or its account is not an active pro
    ALREADY_OFFERED = "already_offered"  # the pro has (or had) this request
    NOT_APPROVED = "not_approved"
    PAYOUTS_DISABLED = "payouts_disabled"
    CATEGORY_MISMATCH = "category_mismatch"
    OUT_OF_AREA = "out_of_area"


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


@dataclass(frozen=True)
class Assignment:
    """A manual assignment made (#82): the offer, for the new request push once the caller
    commits, and the request's status now."""

    dispatch: NewDispatch
    status: RequestStatus


@dataclass(frozen=True)
class AssignablePro:
    """A pro staff may weigh for a request (#82): approved, an active account, in the request's
    category and area. `payouts_enabled` and `already_offered` say whether an assignment
    would go through."""

    pro_id: uuid.UUID
    payouts_enabled: bool
    already_offered: bool


def _unfit(candidate: AssignCandidate) -> AssignRefusal | None:
    """The first condition of receiving the request the profile fails, if any."""
    if not candidate.approved:
        return AssignRefusal.NOT_APPROVED
    if not candidate.payouts_enabled:
        return AssignRefusal.PAYOUTS_DISABLED
    if not candidate.in_category:
        return AssignRefusal.CATEGORY_MISMATCH
    if not candidate.in_area:
        return AssignRefusal.OUT_OF_AREA
    return None


class DispatchService:
    def __init__(self, session: AsyncSession, review_publish_after: timedelta) -> None:
        """`review_publish_after`: REVIEW_PUBLISH_AFTER_DAYS: the ranking reads the pros'
        published ratings (#78)."""
        self._session = session
        self._ratings = ProRatings(session, review_publish_after)
        self._dispatches = DispatchRepository(session)
        self._requests = RequestStateMachine(session)

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
        if request.info_requested_at is not None:
            # Read under the lock: a hold committed after this run was queued still stops it.
            return self._done(DispatchOutcome.HELD, extra)
        if await self._dispatches.exists_for(request.id):
            return self._done(DispatchOutcome.ALREADY_DISPATCHED, extra)
        if request.status is RequestStatus.RECEIVED and request.category_id is None:
            await self._requests.transition(request.id, RequestStatus.REVIEWING, SYSTEM)
            return self._done(DispatchOutcome.TO_REVIEW, extra)
        if request.status not in DISPATCHABLE or request.category_id is None:
            return self._done(
                DispatchOutcome.NOT_DISPATCHABLE, {**extra, "status": str(request.status)}
            )

        areas = await self._areas_of(request.address_id, lock=True)
        ranked = await self._eligible_ranked(request.category_id, areas)
        limit = await SettingsService(self._session).dispatch_max_pros()
        chosen: list[DispatchCandidate] = []
        for candidate in ranked:
            if len(chosen) == limit:
                break
            if await self._still_fit(candidate.pro_id, request.category_id, areas):
                chosen.append(candidate)
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

    async def assign(
        self, request_id: uuid.UUID, pro_id: uuid.UUID, actor: UserAccount
    ) -> Assignment | AssignRefusal:
        """The BDC's manual assignment (#82): one offer for the pro `actor` chose, in the
        caller's transaction (flushes, never commits). The request's row is locked here, so an
        assignment, another one and the automatic dispatch take turns, and none sends a
        request to a pro twice. A received or reviewing request moves to finding_pro with the
        offer, as the actor's move; one finding a pro or with quotes ready gets one more offer
        and stays. `dispatch_max_pros` bounds the automatic dispatch only: staff may add a
        pro beyond it. A refusal writes nothing; the caller announces the offer (the new
        request push) once it commits."""
        request = await self._requests.lock(request_id)
        if request is None:
            return AssignRefusal.UNKNOWN_REQUEST
        if request.status not in ASSIGNABLE:
            return AssignRefusal.NOT_ASSIGNABLE
        if request.category_id is None:
            return AssignRefusal.NOT_CLASSIFIED
        areas = await self._areas_of(request.address_id, lock=True)
        candidate, active = await self._locked_candidate(pro_id, request.category_id, areas)
        if candidate is None or not active:
            return AssignRefusal.UNKNOWN_PRO
        if pro_id in await self._dispatches.pro_ids_of(request.id):
            return AssignRefusal.ALREADY_OFFERED
        unfit = _unfit(candidate)
        if unfit is not None:
            return unfit
        row = RequestDispatch(request_id=request.id, pro_id=pro_id, sent_at=datetime.now(UTC))
        await self._dispatches.add_many([row])
        status = request.status
        if status in DISPATCHABLE:
            status = await self._requests.transition(request.id, RequestStatus.FINDING_PRO, actor)
        logger.info(
            "dispatch_assigned",
            extra={
                "service_request_id": str(request.id),
                "pro_id": str(pro_id),
                "staff_id": str(actor.id),
                "status": str(status),
            },
        )
        return Assignment(NewDispatch(row.id, candidate.user_id, request.public_code), status)

    async def assignable(
        self, request_id: uuid.UUID, category_id: uuid.UUID, address_id: uuid.UUID
    ) -> list[AssignablePro]:
        """The pros staff may weigh for a request in this category at this address (#82):
        approved, an active account, in the category and the area, best ranked first (as
        dispatch ranks), each with whether payouts are enabled and whether it has the request
        already. Reads only."""
        areas = await self._areas_of(address_id)
        found = await ProService(self._session).assign_candidates(category_id, areas)
        active = await UserService(self._session).active_ids_with_role(
            [candidate.user_id for candidate in found], UserRole.PRO
        )
        by_id = {candidate.pro_id: candidate for candidate in found if candidate.user_id in active}
        offered = await self._dispatches.pro_ids_of(request_id)
        history = await self._dispatches.history(list(by_id))
        ranked = rank(
            [DispatchCandidate(c.pro_id, c.user_id, c.rating_avg) for c in by_id.values()],
            history,
        )
        return [
            AssignablePro(pro_id, by_id[pro_id].payouts_enabled, pro_id in offered)
            for pro_id in ranked
        ]

    async def _areas_of(self, address_id: uuid.UUID, *, lock: bool = False) -> set[uuid.UUID]:
        """The active service areas of the address's ZIP (none when it is not served); `lock`:
        FOR SHARE until the transaction ends (see the module doc)."""
        address = await AddressService(self._session).get(address_id)
        if address is None:  # pragma: no cover - the foreign key guarantees it
            return set()
        return await ServiceAreaService(self._session).active_ids_for_zip(
            address.zip_code, lock=lock
        )

    async def _locked_candidate(
        self, pro_id: uuid.UUID, category_id: uuid.UUID, areas: set[uuid.UUID]
    ) -> tuple[AssignCandidate | None, bool]:
        """The profile against the request and whether its account is an active pro's, read
        FOR SHARE and held to the commit: the account first, then the profile and its rows
        (see the module doc). (None, False): no such profile."""
        pros = ProService(self._session)
        # A profile's account never changes: read without a lock, to lock the account first.
        user_id = await pros.user_id_of(pro_id)
        if user_id is None:
            return None, False
        active = await UserService(self._session).active_ids_with_role(
            [user_id], UserRole.PRO, lock=True
        )
        candidate = await pros.assign_candidate(pro_id, category_id, areas, lock=True)
        if candidate is None:  # pragma: no cover - a profile is never deleted
            return None, False
        return candidate, candidate.user_id in active

    async def _still_fit(
        self, pro_id: uuid.UUID, category_id: uuid.UUID, areas: set[uuid.UUID]
    ) -> bool:
        """Whether a pro the unlocked ranking chose still passes every condition, under the
        locks of `_locked_candidate`."""
        candidate, active = await self._locked_candidate(pro_id, category_id, areas)
        return candidate is not None and active and _unfit(candidate) is None

    async def _eligible_ranked(
        self, category_id: uuid.UUID, areas: set[uuid.UUID]
    ) -> list[DispatchCandidate]:
        """Every pro that may receive the request, best ranked first, read without locks:
        `dispatch` reads each one it takes again under locks (`_still_fit`)."""
        candidates = await ProService(self._session).dispatch_candidates(category_id, areas)
        active = await UserService(self._session).active_ids_with_role(
            [c.user_id for c in candidates], UserRole.PRO
        )
        candidates = [c for c in candidates if c.user_id in active]
        # The rating is computed from the published reviews (#78), as every surface shows it.
        ratings = await self._ratings.of({c.pro_id: c.user_id for c in candidates})
        candidates = [replace(c, rating_avg=ratings[c.pro_id].average) for c in candidates]
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
