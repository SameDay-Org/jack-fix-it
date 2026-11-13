import uuid
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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

    async def rating_of(self, target_id: uuid.UUID) -> tuple[Decimal | None, int]:
        """The average of `overall` over the reviews of this user, rounded to one decimal by
        Postgres on the exact numeric (a tie rounds away from zero: 4.25 is 4.3), and their
        count; (None, 0) with none."""
        statement = select(func.round(func.avg(Review.overall), 1), func.count()).where(
            Review.target_id == target_id
        )
        average, count = (await self._session.execute(statement)).one()
        return average, count
