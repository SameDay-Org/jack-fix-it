import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.integrations.storage import StorageProvider, get_storage_provider
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import PanelUser
from app.modules.ops.schemas import (
    AssignedFilter,
    BucketFilter,
    ClaimOut,
    QueuePage,
    QueueSummary,
    RequestCard,
)
from app.modules.ops.service import OpsConfig, OpsQueueService
from app.modules.requests.queue import RequestStatus

# The BDC and admins work the requests in the panel (#81). No HTTP cache may keep an answer:
# the card carries the customer's contacts.
staff_router = APIRouter(prefix="/admin/requests", tags=["ops"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_ops_queue_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    storage: Annotated[StorageProvider, Depends(get_storage_provider)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> OpsQueueService:
    return OpsQueueService(session, storage, OpsConfig.from_settings(settings))


Queue = Annotated[OpsQueueService, Depends(get_ops_queue_service)]
_STAFF_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
}
_NOT_FOUND = _error("request_not_found: no request with this id.")
_BAD_ID = _error("validation_error: a request_id that is not a UUID.")


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
