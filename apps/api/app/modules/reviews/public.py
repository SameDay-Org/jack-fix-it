"""A pro's public profile and their published reviews, for any signed-in user (#78; Foreman
2026-11-20).

- Who is shown: only an approved pro whose account is active with the pro role. No profile,
  pending, rejected, suspended or no longer a pro's: the same 404, decided by one statement
  (ProService.visible_profile), so nobody can probe who applied. A pro reads their own profile
  through /v1/pros/me.
- What: the public name ("María P.", withheld when it shows a contact), the verified flag, the
  rating and its count and the jobs completed (ratings.ProRatings: published reviews only, by
  query), the years of experience, the bio with contacts masked (app.redaction, the pro's own
  email and phone first), the active categories and the month they joined. Never the photo
  (#53: until Cesar decides on moderation), a contact, an address, a document or license, the
  account's id or anything about payouts.
- The reviews: published ones only (repository.published: the pro reviewed the job too, or the
  window passed), newest first, cursor paged. Each one's overall rating, its comment as stored
  (contacts were masked when it was written), the reviewer's public name and the day. Never a
  review's or a user's id.
"""

import base64
import binascii
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.modules.jobs.service import JobPartiesReader
from app.modules.pros.service import ProService
from app.modules.reviews.errors import InvalidReviewInputError
from app.modules.reviews.ratings import ProRatings, utc_now
from app.modules.reviews.repository import ReviewRepository
from app.modules.reviews.schemas import (
    ProProfilePublicOut,
    PublicReviewOut,
    PublicReviewPage,
)
from app.modules.reviews.service import ReviewConfig
from app.modules.users.service import UserService
from app.redaction import KnownValues, redact_text


@dataclass(frozen=True)
class PageLimits:
    default: int
    maximum: int


class PublicPros:
    def __init__(
        self,
        session: AsyncSession,
        config: ReviewConfig,
        limits: PageLimits,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._pros = ProService(session)
        self._users = UserService(session)
        self._reviews = ReviewRepository(session)
        self._ratings = ProRatings(session, config.publish_after, clock)
        self._config = config
        self._limits = limits
        self._clock = clock

    async def profile(self, pro_id: uuid.UUID) -> ProProfilePublicOut:
        """The pro's public profile (see the module doc); 404 for anyone not shown."""
        pro = await self._pros.visible_profile(pro_id)
        if pro is None:
            raise NotFoundError
        rating = (await self._ratings.of({pro_id: pro.user_id}))[pro_id]
        # The pro's own details, for the known-value pass only: never logged or returned.
        contact = (await self._users.contact_points({pro.user_id})).get(pro.user_id)
        known = KnownValues(
            emails=(contact.email,) if contact else (),
            phones=(contact.phone,) if contact and contact.phone else (),
        )
        return ProProfilePublicOut(
            id=pro_id,
            name=pro.name,
            rating_avg=rating.text,
            rating_count=rating.count,
            jobs_count=rating.jobs_completed,
            years_of_experience=pro.years_of_experience,
            verified=True,  # only an approved pro is shown
            bio=None if pro.bio is None else redact_text(pro.bio, known).text,
            categories=pro.categories,
            member_since=pro.created_at.astimezone(UTC).date().replace(day=1),
        )

    async def reviews(
        self, pro_id: uuid.UUID, *, cursor: str | None, limit: int | None
    ) -> PublicReviewPage:
        """One page of the pro's published reviews (see the module doc); 404 for anyone not
        shown, 422 for a cursor this API did not write."""
        after = _decode_cursor(cursor) if cursor else None
        user_id = await self._pros.visible_user_id(pro_id)
        if user_id is None:
            raise NotFoundError
        size = min(limit or self._limits.default, self._limits.maximum)
        rows = await self._reviews.published_page(
            user_id,
            JobPartiesReader.confirmations(),
            self._clock() - self._config.publish_after,
            after=after,
            limit=size + 1,
        )
        page, more = rows[:size], len(rows) > size
        names = await self._users.public_names({row.author_id for row in page})
        return PublicReviewPage(
            items=[
                PublicReviewOut(
                    rating=row.overall,
                    comment=row.comment,
                    reviewer=names.get(row.author_id),
                    reviewer_deleted=names.is_deleted(row.author_id),
                    created_on=row.created_at.astimezone(UTC).date(),
                )
                for row in page
            ],
            next_cursor=_encode_cursor(page[-1].created_at, page[-1].id) if more else None,
        )


def _encode_cursor(created_at: datetime, review_id: uuid.UUID) -> str:
    raw = f"{created_at.isoformat()}|{review_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, review_id = raw.split("|")
        decoded = datetime.fromisoformat(created_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(review_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidReviewInputError from None
