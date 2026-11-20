from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.accounts.schemas import AccountDeletionIn
from app.modules.accounts.service import AccountDeletionConfig, AccountDeletionService
from app.modules.auth.dependencies import CurrentUser, get_auth_service, get_user_service
from app.modules.auth.service import AuthService
from app.modules.users.service import UserService
from app.queue import JobQueue, get_job_queue
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The account holder's own account (#97).
router = APIRouter(prefix="/me", tags=["account"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_account_deletion_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    users: Annotated[UserService, Depends(get_user_service)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    queue: Annotated[JobQueue, Depends(get_job_queue)],
) -> AccountDeletionService:
    return AccountDeletionService(
        session, users, auth, AccountDeletionConfig.from_settings(settings), queue
    )


async def limit_account_deletion(
    user: CurrentUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """AUTH_RATE_LIMIT_REQUESTS tries per user per AUTH_RATE_LIMIT_WINDOW_SECONDS: the password
    is checked here, so as many guesses as a login allows, no more."""
    await enforce_limit(
        limiter,
        "account_delete_user",
        str(user.id),
        limit=settings.auth_rate_limit_requests,
        window_seconds=settings.auth_rate_limit_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


@router.post(
    "/delete",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Delete my account",
    dependencies=[Depends(limit_account_deletion)],
    responses={
        status.HTTP_204_NO_CONTENT: {
            "description": "Deleted: every session ends now, and the email may sign up again "
            "as a new account."
        },
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing or expired."),
        status.HTTP_403_FORBIDDEN: _error(
            "invalid_password: not the account's password. staff_account: agents and admins "
            "are removed by an administrator."
        ),
        status.HTTP_409_CONFLICT: _error(
            "Something must settle first, one code per reason: active_job (a job in progress, "
            "waiting for confirmation, or, for a pro, for its payout), open_dispute, "
            "refund_pending, payment_in_progress, payout_pending, active_quote (a pro's quote "
            "still open or being paid)."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: no password, or an extra field."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: _error(
            "rate_limited: too many tries; Retry-After says when to try again."
        ),
    },
)
async def delete_my_account(
    data: AccountDeletionIn,
    user: CurrentUser,
    accounts: Annotated[AccountDeletionService, Depends(get_account_deletion_service)],
) -> Response:
    """Deletes the caller's account, confirmed with its current password, as the stores
    require. The account is anonymised: the name, email, phone, addresses, photos, documents,
    devices and saved cards go; jobs, payments and reviews stay for the other side and for tax,
    shown as "Deleted user". A customer's requests still open are cancelled. Every session ends
    at once. Refused while a job, a dispute, a refund, a payment, a payout or a quote is still in
    flight (409, the code says which)."""
    await accounts.delete(user, data.password)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
