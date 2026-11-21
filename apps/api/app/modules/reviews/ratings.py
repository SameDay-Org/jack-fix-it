"""A pro's rating and the jobs they completed, computed by query wherever a pro is shown (#78;
Foreman 2026-11-20): the public profile, quote cards, the job's pro card, dispatch's ranking.

Nothing is stored. #77's publication rule (repository.published) decides from the clock which
reviews count, so an aggregate kept up by review writes would go stale when a review's window
passes with no write. The `pro_profiles.rating_avg` and `jobs_count` columns stay in the table,
unread (expand-only).

- The rating: the mean `overall` of the pro's published reviews to one decimal, rounded half up
  in integer math (`rounded_average`), and their count; None and 0 with none, never 0.0. Every
  surface reads it through here, and shows it with `rating_text`.
- Jobs completed: the pro's confirmed jobs, paid out since included (jobs: is_reviewable).

Two grouped queries (the reviews, the jobs), whatever the number of pros.
"""

import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.service import JobPartiesReader
from app.modules.pros.service import ProService
from app.modules.reviews.repository import ReviewRepository


def rounded_average(total: int, count: int) -> Decimal | None:
    """The mean of `count` ratings summing to `total`, to one decimal, rounded half up, in
    integer math: 14 / 3 is 4.7, 17 / 4 (4.25) is 4.3, 9 / 2 is 4.5. None with no rating (No
    ratings yet), never 0.0."""
    if count == 0:
        return None
    tenths = (20 * total + count) // (2 * count)
    return Decimal(tenths).scaleb(-1)


def rating_text(average: Decimal | None) -> str | None:
    """The rating as every response shows it: one decimal ("4.7", "5.0"); None with none."""
    return None if average is None else format(average, ".1f")


@dataclass(frozen=True)
class ProRating:
    average: Decimal | None
    count: int
    jobs_completed: int

    @property
    def text(self) -> str | None:
        return rating_text(self.average)


def utc_now() -> datetime:
    return datetime.now(UTC)


class ProRatings:
    """The ratings of pros, by profile id (see the module doc). `publish_after` is
    REVIEW_PUBLISH_AFTER_DAYS (reviews.service.ReviewConfig)."""

    def __init__(
        self,
        session: AsyncSession,
        publish_after: timedelta,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._reviews = ReviewRepository(session)
        self._jobs = JobPartiesReader(session, ProService(session))
        self._publish_after = publish_after
        self._clock = clock

    async def of(self, users_by_pro: Mapping[uuid.UUID, uuid.UUID]) -> dict[uuid.UUID, ProRating]:
        """Each pro's rating and jobs completed, for the pros given as {profile id: user id};
        every one of them gets an entry. Two queries, whatever the count."""
        if not users_by_pro:
            return {}
        sums = await self._reviews.ratings_of(
            set(users_by_pro.values()),
            JobPartiesReader.confirmations(),
            self._clock() - self._publish_after,
        )
        completed = await self._jobs.completed_counts(set(users_by_pro))
        ratings: dict[uuid.UUID, ProRating] = {}
        for pro_id, user_id in users_by_pro.items():
            total, count = sums.get(user_id, (0, 0))
            ratings[pro_id] = ProRating(
                rounded_average(total, count), count, completed.get(pro_id, 0)
            )
        return ratings
