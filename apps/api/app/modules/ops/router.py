import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import StorageProvider, get_storage_provider
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import PanelUser
from app.modules.ops.actions import ActionsConfig, OpsActions, utc_now
from app.modules.ops.schemas import (
    AssignedFilter,
    AssignIn,
    AssignOut,
    BucketFilter,
    ClaimOut,
    ClassifyIn,
    ClassifyOut,
    ContactedOut,
    EligiblePros,
    FollowupDue,
    FollowupIn,
    FollowupOut,
    FollowupsPage,
    FollowupsSummary,
    MoreInfoIn,
    MoreInfoOut,
    NoteIn,
    NoteOut,
    QueuePage,
    QueueSummary,
    RequestCard,
    ResumeOut,
    StaffList,
    StatusChangeIn,
    StatusChangeOut,
)
from app.modules.ops.service import OpsConfig, OpsQueueService
from app.modules.requests.queue import RequestStatus
from app.queue import JobQueue, get_job_queue
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The BDC and admins work the requests in the panel (#81). No HTTP cache may keep an answer:
# the card carries the customer's contacts.
staff_router = APIRouter(prefix="/admin/requests", tags=["ops"], route_class=NoStoreRoute)
# A staff member's follow-ups across requests (#82).
followups_router = APIRouter(prefix="/admin/followups", tags=["ops"], route_class=NoStoreRoute)
# The active agents and admins, for the panel's assignee pickers (#82). Staff only.
staff_members_router = APIRouter(prefix="/admin/staff", tags=["ops"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_ops_queue_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[StorageProvider, Depends(get_storage_provider)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> OpsQueueService:
    return OpsQueueService(session, storage, OpsConfig.from_settings(settings))


Queue = Annotated[OpsQueueService, Depends(get_ops_queue_service)]


def get_ops_clock() -> Callable[[], datetime]:
    """FastAPI dependency: the server's clock for the BDC's actions (a fixed one in tests)."""
    return utc_now


def get_ops_actions(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    clock: Annotated[Callable[[], datetime], Depends(get_ops_clock)],
) -> OpsActions:
    return OpsActions(session, ActionsConfig.from_settings(settings), clock)


async def limit_ops_actions(
    user: PanelUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """OPS_ACTION_LIMIT actions per staff member per OPS_ACTION_WINDOW_SECONDS (#82)."""
    await enforce_limit(
        limiter,
        "ops_action",
        str(user.id),
        limit=settings.ops_action_limit,
        window_seconds=settings.ops_action_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


Actions = Annotated[OpsActions, Depends(get_ops_actions)]
_STAFF_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
}
_NOT_FOUND = _error("request_not_found: no request with this id.")
_BAD_ID = _error("validation_error: a request_id that is not a UUID.")
_LIMITED = _error(
    "rate_limited: more than OPS_ACTION_LIMIT actions in the window; Retry-After says when "
    "to try again."
)


@staff_router.get(
    "",
    response_model=QueuePage,
    summary="The operations queue (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: an unknown bucket, status or assigned, a zip that is not 5 "
            "digits, a q that is not part of a request code, a bad cursor or limit."
        ),
    },
)
async def staff_list_requests(
    user: PanelUser,
    queue: Queue,
    bucket: Annotated[
        BucketFilter, Query(description="One bucket of the queue, or every request.")
    ] = BucketFilter.ALL,
    status_filter: Annotated[
        RequestStatus | None, Query(alias="status", description="Only requests in this status.")
    ] = None,
    category_id: Annotated[uuid.UUID | None, Query()] = None,
    zip_code: Annotated[
        str | None, Query(alias="zip", pattern=r"^[0-9]{5}$", description="A 5-digit ZIP.")
    ] = None,
    assigned: Annotated[
        AssignedFilter, Query(description="Held by the caller, by nobody, or by anyone.")
    ] = AssignedFilter.ANY,
    q: Annotated[
        str | None,
        Query(
            pattern=r"^[A-Za-z0-9-]{1,16}$",
            description="Part of a request code (JF-000124). Nothing else is searched.",
        ),
    ] = None,
    limit: Annotated[int | None, Query(gt=0, description="Page size; capped.")] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> QueuePage:
    """The requests for the BDC and admins. Each is in one bucket, by precedence: problems,
    urgent, new, waiting_customer, waiting_pro, quote_ready, scheduled_today. Inside a bucket
    the request waiting longest comes first; `all` lists every request, newest first. Never a
    phone, an email, a last name or a street."""
    return await queue.page(
        user,
        bucket=bucket,
        status=status_filter,
        category_id=category_id,
        zip_code=zip_code,
        assigned=assigned,
        code=q.upper() if q else None,
        limit=limit,
        cursor=cursor,
    )


@staff_router.get(
    "/summary",
    response_model=QueueSummary,
    summary="How many requests each bucket holds (staff)",
    responses=_STAFF_ACCESS,
)
async def staff_requests_summary(user: PanelUser, queue: Queue) -> QueueSummary:
    """The count of each bucket and of every request, in one query: light enough to poll."""
    return await queue.summary()


@staff_router.get(
    "/{request_id}",
    response_model=RequestCard,
    summary="A request's card (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _BAD_ID,
    },
)
async def staff_get_request(request_id: uuid.UUID, user: PanelUser, queue: Queue) -> RequestCard:
    """One request for the BDC: the customer's name, phone, email and address, what was
    asked, the privacy-safe media, the quotes, the job and its history. Every read is recorded
    in the audit log with the staff member who made it."""
    return await queue.card(user, request_id)


@staff_router.post(
    "/{request_id}/claim",
    response_model=ClaimOut,
    summary="Take a request (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_409_CONFLICT: _error("request_held: another team member holds it."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _BAD_ID,
    },
)
async def staff_claim_request(request_id: uuid.UUID, user: PanelUser, queue: Queue) -> ClaimOut:
    """Assigns the request to the caller when nobody holds it. The caller's own claim again
    changes nothing. Taking a request is not the first contact: first_contact_at stays as it
    is. Recorded in the audit log."""
    return await queue.claim(user, request_id)


@staff_router.post(
    "/{request_id}/release",
    response_model=ClaimOut,
    summary="Let go of a request (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_409_CONFLICT: _error(
            "request_held: another team member holds it (an admin may release it)."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _BAD_ID,
    },
)
async def staff_release_request(request_id: uuid.UUID, user: PanelUser, queue: Queue) -> ClaimOut:
    """Unassigns a request the caller holds; an admin may release anyone's. Releasing a
    request nobody holds changes nothing. Recorded in the audit log."""
    return await queue.release(user, request_id)


# --- The BDC's actions (#82) -------------------------------------------------------------------

_ACTION_ERRORS: dict[int | str, dict[str, Any]] = {
    **_STAFF_ACCESS,
    status.HTTP_403_FORBIDDEN: _error(
        "forbidden: only active agents and admins (checked again as the action is written)."
    ),
    status.HTTP_404_NOT_FOUND: _NOT_FOUND,
    status.HTTP_409_CONFLICT: _error(
        "request_held: another agent holds the request (they, or an admin, act on it)."
    ),
    status.HTTP_429_TOO_MANY_REQUESTS: _LIMITED,
}


@staff_router.post(
    "/{request_id}/notes",
    status_code=status.HTTP_201_CREATED,
    response_model=NoteOut,
    summary="Add an internal note to a request (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={
        **_ACTION_ERRORS,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a note empty or over 2000 characters, or a bad request_id."
        ),
    },
)
async def staff_add_note(
    request_id: uuid.UUID, data: NoteIn, user: PanelUser, actions: Actions
) -> NoteOut:
    """Plain text for the team, kept as written: never shown to the customer or the pro.
    Notes are only added. Recorded in the audit log (without the text)."""
    return await actions.add_note(user, request_id, data.body)


@staff_router.post(
    "/{request_id}/contacted",
    response_model=ContactedOut,
    summary="Mark the customer contacted (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={**_ACTION_ERRORS, status.HTTP_422_UNPROCESSABLE_CONTENT: _BAD_ID},
)
async def staff_mark_contacted(
    request_id: uuid.UUID, user: PanelUser, actions: Actions
) -> ContactedOut:
    """Sets the first contact time once: the queue's timer stops. Again keeps the first time
    (no error). Recorded in the audit log."""
    return await actions.mark_contacted(user, request_id)


@staff_router.post(
    "/{request_id}/classify",
    response_model=ClassifyOut,
    summary="Set a request's category (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={
        **_ACTION_ERRORS,
        status.HTTP_409_CONFLICT: _error(
            "request_held: another agent holds the request. request_not_classifiable: the "
            "request is past reviewing (dispatch took it)."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "category_inactive: the category is not active; validation_error: a bad id."
        ),
    },
)
async def staff_classify_request(
    request_id: uuid.UUID, data: ClassifyIn, user: PanelUser, actions: Actions
) -> ClassifyOut:
    """Only while the request is received or reviewing, to an active category. Runs nothing
    else. Recorded in the audit log."""
    return await actions.classify(user, request_id, data.category_id)


_INVALID_TRANSITION = (
    "request_held: another agent holds the request. invalid_transition: the request cannot "
    "move there from its current status."
)


@staff_router.post(
    "/{request_id}/more-info",
    response_model=MoreInfoOut,
    summary="Ask the customer for more information (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={**_ACTION_ERRORS, status.HTTP_409_CONFLICT: _error(_INVALID_TRANSITION)},
)
async def staff_request_more_info(
    request_id: uuid.UUID, data: MoreInfoIn, user: PanelUser, actions: Actions
) -> MoreInfoOut:
    """Keeps the question as an internal note, moves the request to reviewing (the state
    machine's staff edge) and holds it there: no re-dispatch takes it until staff resume it,
    change its status or assign a pro. The customer is not messaged (`customer_notified` is
    false): no channel takes a staff message yet. Recorded in the audit log."""
    return await actions.request_more_info(user, request_id, data.question)


@staff_router.post(
    "/{request_id}/resume",
    response_model=ResumeOut,
    summary="Release a request held for the customer's answer (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses=_ACTION_ERRORS,
)
async def staff_resume_request(
    request_id: uuid.UUID, user: PanelUser, actions: Actions
) -> ResumeOut:
    """Clears the hold; the next re-dispatch sweep takes the request when it can (received or
    reviewing, a category, no offer yet). A request not on hold: nothing changes. Recorded in
    the audit log."""
    return await actions.resume(user, request_id)


@staff_router.post(
    "/{request_id}/status",
    response_model=StatusChangeOut,
    summary="Change a request's status (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={**_ACTION_ERRORS, status.HTTP_409_CONFLICT: _error(_INVALID_TRANSITION)},
)
async def staff_change_request_status(
    request_id: uuid.UUID, data: StatusChangeIn, user: PanelUser, actions: Actions
) -> StatusChangeOut:
    """Only to one of the card's allowed_status_changes, through the request state machine,
    with the reason kept as an internal note. Releases a hold. Recorded in the audit log."""
    return await actions.change_status(user, request_id, data.to, data.reason)


@staff_router.get(
    "/{request_id}/eligible-pros",
    response_model=EligiblePros,
    summary="The pros a request may be assigned to (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _BAD_ID,
    },
)
async def staff_eligible_pros(
    request_id: uuid.UUID, user: PanelUser, actions: Actions
) -> EligiblePros:
    """The approved pros in the request's category and area, best ranked first (as dispatch
    ranks them), each with whether payouts are enabled and whether they have the request
    already: first name and last initial, no contact. At most OPS_ELIGIBLE_PROS_LIMIT (`more`
    says when others match). Empty for a request with no category or past quoting."""
    return await actions.eligible_pros(request_id)


@staff_router.post(
    "/{request_id}/assign",
    response_model=AssignOut,
    summary="Offer a request to a pro (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={
        **_ACTION_ERRORS,
        status.HTTP_404_NOT_FOUND: _error(
            "request_not_found: no request with this id. pro_not_found: no pro profile with "
            "this id, or its account is no longer an active pro."
        ),
        status.HTTP_409_CONFLICT: _error(
            "request_held: another agent holds the request. invalid_transition: the request "
            "is accepted, expired or cancelled. request_not_classified: it has no category "
            "yet. One code per reason the pro cannot take it: pro_already_offered (they have, "
            "or had, this request), pro_not_approved, pro_payouts_disabled, "
            "pro_category_mismatch, pro_out_of_area. Nothing was written."
        ),
    },
)
async def staff_assign_pro(
    request_id: uuid.UUID,
    data: AssignIn,
    user: PanelUser,
    actions: Actions,
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> AssignOut:
    """One offer for the pro the agent chose, made by dispatch: the pro must be approved, with
    payouts enabled, in the request's category and area, and not have the request already. A
    received or reviewing request moves to finding a pro; one finding a pro or with quotes
    ready stays where it is. Releases a hold. The pro gets the new request push. Recorded in
    the audit log."""
    return await actions.assign_pro(user, request_id, data.pro_id, queue)


@staff_router.post(
    "/{request_id}/followups",
    status_code=status.HTTP_201_CREATED,
    response_model=FollowupOut,
    summary="Schedule a follow-up on a request (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={
        **_ACTION_ERRORS,
        status.HTTP_403_FORBIDDEN: _error(
            "forbidden: only active agents and admins; only an admin gives a follow-up to "
            "someone else."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "followup_due_out_of_range: due in the past or more than OPS_FOLLOWUP_MAX_DAYS "
            "ahead; assignee_not_staff: the assignee is not an active agent or admin; "
            "validation_error: a note empty or over 500 characters, a bad id."
        ),
    },
)
async def staff_schedule_followup(
    request_id: uuid.UUID, data: FollowupIn, user: PanelUser, actions: Actions
) -> FollowupOut:
    """The caller's by default. Recorded in the audit log (without the note)."""
    return await actions.schedule_followup(user, request_id, data)


@staff_router.post(
    "/{request_id}/followups/{followup_id}/done",
    response_model=FollowupOut,
    summary="Mark a follow-up done (staff)",
    dependencies=[Depends(limit_ops_actions)],
    responses={
        **_STAFF_ACCESS,
        status.HTTP_403_FORBIDDEN: _error(
            "forbidden: only its assignee or an admin, an active one."
        ),
        status.HTTP_404_NOT_FOUND: _error("followup_not_found: none with this id here."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _BAD_ID,
        status.HTTP_429_TOO_MANY_REQUESTS: _LIMITED,
    },
)
async def staff_followup_done(
    request_id: uuid.UUID, followup_id: uuid.UUID, user: PanelUser, actions: Actions
) -> FollowupOut:
    """Done once: again changes nothing. Recorded in the audit log."""
    return await actions.followup_done(user, request_id, followup_id)


@followups_router.get(
    "",
    response_model=FollowupsPage,
    summary="My follow-ups (staff)",
    responses={
        **_STAFF_ACCESS,
        status.HTTP_403_FORBIDDEN: _error(
            "forbidden: only active agents and admins; only an admin names an assignee "
            "(their own id included)."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: a bad cursor or limit."),
    },
)
async def staff_list_followups(
    user: PanelUser,
    actions: Actions,
    due: Annotated[
        FollowupDue,
        Query(description="today: due by the end of today in BUSINESS_TIME_ZONE, overdue too."),
    ] = FollowupDue.TODAY,
    assignee: Annotated[
        uuid.UUID | None,
        Query(description="Whose follow-ups (admins only; an agent reads their own without it)."),
    ] = None,
    limit: Annotated[int | None, Query(gt=0, description="Page size; capped.")] = None,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> FollowupsPage:
    """The follow-ups not done, the most overdue first. Each names its request by code and
    status: never a contact."""
    return await actions.due_followups(user, assignee=assignee, due=due, limit=limit, cursor=cursor)


@followups_router.get(
    "/summary",
    response_model=FollowupsSummary,
    summary="How many of my follow-ups are due today (staff)",
    responses={**_STAFF_ACCESS},
)
async def staff_followups_summary(user: PanelUser, actions: Actions) -> FollowupsSummary:
    """The caller's open follow-ups due by the end of today in the business time zone, overdue
    ones included: the nav badge, equal to the default follow-ups list's length."""
    return await actions.followups_summary(user)


@staff_members_router.get(
    "",
    response_model=StaffList,
    summary="The active agents and admins (staff)",
    responses={**_STAFF_ACCESS},
)
async def staff_members(user: PanelUser, actions: Actions) -> StaffList:
    """Id, first name and role of every active agent and admin, for assigning a follow-up and
    filtering the follow-ups list. No contact."""
    return await actions.staff_members(user)
