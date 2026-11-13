import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import ColumnElement, Subquery, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.reviews.models import Review


class ReviewRepository:
    """Queries only: reviews."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, review: Review) -> Review:
        """Inserts the review and reads back what Postgres set (id, timestamps). A second
        review of the job by its author breaks ONE_PER_AUTHOR (IntegrityError)."""
        self._session.add(review)
        await self._session.flush()
        await self._session.refresh(review)
        return review

    async def by_author(self, job_id: uuid.UUID, author_id: uuid.UUID) -> Review | None:
        """The author's own review of the job. The author is always part of the statement, so
        it never reads the other side's."""
        statement = select(Review).where(Review.job_id == job_id, Review.author_id == author_id)
        return (await self._session.scalars(statement)).one_or_none()

    async def rating_of(
        self, target_id: uuid.UUID, confirmations: Subquery, confirmed_by: datetime
    ) -> tuple[Decimal | None, int]:
        """The average of `overall` over the published reviews of this user, rounded to one
        decimal by Postgres on the exact numeric (a tie rounds away from zero: 4.25 is 4.3),
        and their count; (None, 0) with none. `confirmations` is the jobs module's `job_id`,
        `confirmed_at` subquery; `confirmed_by` as in published()."""
        statement = (
            select(func.round(func.avg(Review.overall), 1), func.count())
            .join(confirmations, confirmations.c.job_id == Review.job_id)
            .where(Review.target_id == target_id, published(confirmations, confirmed_by))
        )
        average, count = (await self._session.execute(statement)).one()
        return average, count


def published(confirmations: Subquery, confirmed_by: datetime) -> ColumnElement[bool]:
    """Whether a review counts for its target and may be shown to them (the publication rule,
    Foreman 2026-11-13): its target reviewed the same job too, or the job was confirmed at or
    before `confirmed_by` (now minus the publication window). Until then the review exists,
    and blocks a second one by its author, but nothing shows its score to its target: nobody
    sees a rating of a job before writing their own, and nobody hides one for good by never
    writing. A condition on Review, for a statement that joins `confirmations` (`job_id`,
    `confirmed_at`) on the review's job; a job with no confirmed_at never passes the window.
    Everything that exposes a score to its target goes through it (#78 too)."""
    answer = aliased(Review)
    answered = exists().where(answer.job_id == Review.job_id, answer.author_id == Review.target_id)
    return or_(answered, confirmations.c.confirmed_at <= confirmed_by)
