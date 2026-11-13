import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.modules.auth.permissions import AppUser
from app.modules.reviews.models import COMMENT_MAX_LENGTH
from app.modules.reviews.schemas import MyReviewOut, RatingOut, ReviewCreatedOut, ReviewIn
from app.modules.reviews.service import ReviewService
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The job's customer and pro review each other once it is confirmed (#77).
router = APIRouter(prefix="/jobs/{job_id}/reviews", tags=["reviews"])
# The caller's own rating, as a customer or as a pro (#77, #252).
rating_router = APIRouter(prefix="/users/me/rating", tags=["reviews"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_review_service(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ReviewService:
    return ReviewService(session)


Reviews = Annotated[ReviewService, Depends(get_review_service)]


async def limit_review_creates(
    user: AppUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """REVIEW_CREATE_LIMIT reviews per user per REVIEW_CREATE_WINDOW_SECONDS, over all their
    jobs. A refused attempt (an invalid body, a job that cannot be reviewed) counts too."""
    await enforce_limit(
        limiter,
        "review_create",
        str(user.id),
        limit=settings.review_create_limit,
        window_seconds=settings.review_create_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


_ACCESS: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
    status.HTTP_403_FORBIDDEN: _error("forbidden: only customers and pros."),
}
_JOB_NOT_FOUND = _error(
    "not_found: no job with this id of which the caller is the customer or the pro."
)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ReviewCreatedOut,
    summary="Review the other side of my job",
    dependencies=[Depends(limit_review_creates)],
    responses={
        **_ACCESS,
        status.HTTP_404_NOT_FOUND: _JOB_NOT_FOUND,
        status.HTTP_409_CONFLICT: _error(
            "job_not_reviewable: the job was not confirmed (by the customer or automatically): "
            "it is scheduled, on the way, in progress, completed, disputed, refunded or "
            "cancelled, or was paid out without a confirmation; already_reviewed: the caller "
            "already reviewed this job."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a rating missing, not an integer or outside 1 to 5; quality or "
            "value sent by the job's pro (the customer alone rates them); a comment blank, "
            f"longer than {COMMENT_MAX_LENGTH} characters or with nothing visible in it; an "
            "unknown field; a job_id that is not a UUID."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: {
            **_error("rate_limited: too many reviews; retry later."),
            "headers": {
                "Retry-After": {
                    "description": "Seconds until the current limit window ends.",
                    "schema": {"type": "integer"},
                }
            },
        },
    },
)
async def create_review(
    job_id: uuid.UUID, data: ReviewIn, user: AppUser, reviews: Reviews
) -> ReviewCreatedOut:
    """The caller's review of the other side of a job they took part in: the customer reviews
    the pro, the pro reviews the customer. One review per side per job, only once the job was
    confirmed, never edited. Who is reviewed comes from the job, not from the body.

    The customer may rate communication, quality, punctuality and value next to `overall`; the
    pro may rate communication and punctuality only (quality or value from the pro is a 422).

    Contact details in the comment are masked before it is stored, and only the masked text is
    kept; `comment_redacted` says so."""
    return await reviews.create(user, job_id, data)


@router.get(
    "/mine",
    response_model=MyReviewOut,
    summary="Read my review of a job",
    responses={
        **_ACCESS,
        status.HTTP_404_NOT_FOUND: _JOB_NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a job_id that is not a UUID."
        ),
    },
)
async def read_my_review(job_id: uuid.UUID, user: AppUser, reviews: Reviews) -> MyReviewOut:
    """The caller's own review of the job, or null, and whether they may still write one. It
    never returns the other side's review, whether or not the caller wrote theirs."""
    return await reviews.mine(user, job_id)


@rating_router.get(
    "",
    response_model=RatingOut,
    summary="Read my rating",
    responses=_ACCESS,
)
async def read_my_rating(user: AppUser, reviews: Reviews) -> RatingOut:
    """The caller's own rating, as a customer or as a pro: the average of the overall ratings
    they received, to one decimal, and how many; null and 0 with none."""
    return await reviews.rating(user)
