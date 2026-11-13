"""Two-sided reviews (#77; Cesar 2026-10-29): once a job is confirmed, its customer and its pro
each review the other, once.

- Who: the job's customer and its pro, each for their own side. Anyone else, and an unknown job,
  get the same 404 through one statement scoped to the caller (JobPartiesReader.parties_for).
- When: only once the job was confirmed, by the customer (#66) or by the 48 h auto-confirm
  (#67): confirmed, or paid out after that (jobs.service.is_reviewable). Every other job is 409
  `job_not_reviewable`. A reviewable job never stops being one, so no lock is taken.
- Once: UNIQUE (job_id, author_id). A second review, one after the other or at the same time, is
  409 `already_reviewed`: the constraint decides, so two submits at once create exactly one.
- The target is the author's counterpart on that job, read from the job, never from the client.
- Ratings: `overall` and, optionally, communication, quality, punctuality and value from the
  customer; from the pro, communication and punctuality only (quality and value are a 422).
- The comment may later show publicly (#78), so it goes through the same contact redaction as
  the chat (app.redaction.redact_contacts) and only the redacted text is stored: no original is
  kept anywhere. `comment_redacted` tells the author that something was masked.
- Reading: an author reads back their own review only (`mine`), never the other side's. A
  user's rating is the average of `overall` over the published reviews of them, with the
  count, computed by a query.
- Publication (Foreman 2026-11-13, for Cesar's veto): a review counts for its target only once
  it is published: the target reviewed the same job too, or REVIEW_PUBLISH_AFTER_DAYS passed
  since the job's confirmation (repository.published). No cron and no column: the rating's
  query decides, from the job's confirmed_at and the server's clock. So nobody reads the other
  side's score before writing their own, and a review is not hidden for good by a target who
  never writes one. `mine`, `can_review` and `already_reviewed` do not depend on it.

Never logged: the comment. Logs carry ids, the author's side and whether a comment was masked.
"""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import violated_constraint
from app.errors import NotFoundError
from app.modules.jobs.service import JobParties, JobPartiesReader
from app.modules.pros.service import ProService
from app.modules.reviews.errors import (
    AlreadyReviewedError,
    InvalidReviewInputError,
    JobNotReviewableError,
)
from app.modules.reviews.models import (
    COMMENT_MAX_LENGTH,
    ONE_PER_AUTHOR,
    Review,
    ReviewAuthorRole,
)
from app.modules.reviews.repository import ReviewRepository
from app.modules.reviews.schemas import (
    MyReviewOut,
    RatingOut,
    ReviewCreatedOut,
    ReviewIn,
    ReviewOut,
)
from app.modules.users.types import UserAccount
from app.redaction import redact_contacts

logger = logging.getLogger(__name__)

# What only the job's customer rates: the work and its price. A pro rates a customer on
# communication and punctuality.
CUSTOMER_ONLY_DIMENSIONS = ("quality", "value")


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class ReviewConfig:
    # How long after a job's confirmation a review of it is published without its target's.
    publish_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "ReviewConfig":
        return cls(publish_after=timedelta(days=settings.review_publish_after_days))


class ReviewService:
    def __init__(
        self,
        session: AsyncSession,
        config: ReviewConfig,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._session = session
        self._config = config
        self._clock = clock
        self._reviews = ReviewRepository(session)
        self._jobs = JobPartiesReader(session, ProService(session))

    async def create(
        self, user: UserAccount, job_id: uuid.UUID, data: ReviewIn
    ) -> ReviewCreatedOut:
        """Stores the caller's review of their counterpart on the job, and commits."""
        parties = await self._parties(user, job_id)
        role, target_id = _side(parties, user.id)
        if role is ReviewAuthorRole.PRO and any(
            getattr(data, dimension) is not None for dimension in CUSTOMER_ONLY_DIMENSIONS
        ):
            raise InvalidReviewInputError
        if not _reviewable(parties, user.id):
            raise JobNotReviewableError
        comment, redacted = _redacted(data.comment)
        review = Review(
            job_id=job_id,
            author_id=user.id,
            target_id=target_id,
            author_role=role,
            overall=data.overall,
            communication=data.communication,
            quality=data.quality,
            punctuality=data.punctuality,
            value=data.value,
            comment=comment,
        )
        # The constraint is the one-per-side rule: a review committed earlier, or by a request
        # running at the same time (this insert waits for it), refuses this one.
        savepoint = await self._session.begin_nested()
        try:
            review = await self._reviews.add(review)
        except IntegrityError as error:
            await savepoint.rollback()
            if violated_constraint(error) == ONE_PER_AUTHOR:
                raise AlreadyReviewedError from None
            raise
        await savepoint.commit()
        await self._session.commit()
        logger.info(
            "review_created",
            extra={
                "review_id": str(review.id),
                "job_id": str(job_id),
                "author_id": str(user.id),
                "target_id": str(target_id),
                "author_role": role.value,
                "has_comment": comment is not None,
                "comment_redacted": redacted,
            },
        )
        return ReviewCreatedOut(
            id=review.id, created_at=review.created_at, comment_redacted=redacted
        )

    async def mine(self, user: UserAccount, job_id: uuid.UUID) -> MyReviewOut:
        """The caller's own review of the job, and whether they may still write one. Never the
        other side's review: the repository reads by author."""
        parties = await self._parties(user, job_id)
        review = await self._reviews.by_author(job_id, user.id)
        return MyReviewOut(
            review=None if review is None else _out(review),
            can_review=review is None and _reviewable(parties, user.id),
        )

    async def rating(self, user: UserAccount) -> RatingOut:
        """The caller's own rating: the average of `overall` over the published reviews of
        them, to one decimal, and how many there are. A review the caller did not answer yet
        is left out until its job's confirmation is the publication window old."""
        confirmed_by = self._clock() - self._config.publish_after
        average, count = await self._reviews.rating_of(
            user.id, JobPartiesReader.confirmations(), confirmed_by
        )
        return RatingOut(average=None if average is None else float(average), count=count)

    async def _parties(self, user: UserAccount, job_id: uuid.UUID) -> JobParties:
        """The job's parties when the caller is one of them; 404 for a job of others and for
        an unknown one alike."""
        parties = await self._jobs.parties_for(user.id, job_id)
        if parties is None:
            raise NotFoundError
        return parties


def _side(parties: JobParties, user_id: uuid.UUID) -> tuple[ReviewAuthorRole, uuid.UUID]:
    """The caller's side on the job and their counterpart's user id."""
    if user_id == parties.customer_id:
        return ReviewAuthorRole.CUSTOMER, parties.pro_user_id
    return ReviewAuthorRole.PRO, parties.customer_id


def _reviewable(parties: JobParties, user_id: uuid.UUID) -> bool:
    """Whether the caller may review this job at all: it was confirmed, and its other side is
    someone else (nobody reviews themselves; the database refuses it too)."""
    _, target_id = _side(parties, user_id)
    return parties.reviewable and target_id != user_id


def _redacted(comment: str | None) -> tuple[str | None, bool]:
    """The comment as it is stored, and whether the redactor masked something in it."""
    if comment is None:
        return None, False
    result = redact_contacts(comment)
    text = result.text.strip()
    if not text or len(text) > COMMENT_MAX_LENGTH:
        # Nothing left once invisible characters are dropped, or (in theory) masks longer than
        # what they replaced past the limit.
        raise InvalidReviewInputError
    return text, result.redacted


def _out(review: Review) -> ReviewOut:
    return ReviewOut(
        id=review.id,
        overall=review.overall,
        communication=review.communication,
        quality=review.quality,
        punctuality=review.punctuality,
        value=review.value,
        comment=review.comment,
        created_at=review.created_at,
    )
