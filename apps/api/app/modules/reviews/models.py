import uuid
from enum import StrEnum
from typing import Final

from sqlalchemy import CheckConstraint, ForeignKey, Index, SmallInteger, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum

# A rating's bounds, on every dimension.
RATING_MIN: Final = 1
RATING_MAX: Final = 5
# The longest comment, in characters, as stored (redacted, trimmed).
COMMENT_MAX_LENGTH: Final = 1000
# The dimensions next to `overall`; each is optional.
DIMENSIONS: Final = ("communication", "quality", "punctuality", "value")
# One review per side per job. The name is the naming convention's (its first column).
ONE_PER_AUTHOR: Final = "uq_reviews_job_id"

_RANGE: Final = f"BETWEEN {RATING_MIN} AND {RATING_MAX}"


class ReviewAuthorRole(StrEnum):
    """The author's side on the reviewed job."""

    CUSTOMER = "customer"
    PRO = "pro"


class Review(IdTimestampsMixin, Base):
    """One side's review of the other after a job was confirmed (#77): at most one per author
    per job, never edited.

    `target_id` is the author's counterpart on that job (the pro's user for the customer, the
    customer for the pro), derived from the job and never taken from the client. `comment` is
    the author's text after the contact redaction (app.redaction), the only form ever stored:
    it may later show publicly (#78). It is never logged.
    """

    __tablename__ = "reviews"
    __table_args__ = (
        CheckConstraint(f"overall {_RANGE}", name="overall_range"),
        *(CheckConstraint(f"{column} {_RANGE}", name=f"{column}_range") for column in DIMENSIONS),
        CheckConstraint(
            f"char_length(comment) BETWEEN 1 AND {COMMENT_MAX_LENGTH}", name="comment_length"
        ),
        CheckConstraint("author_id <> target_id", name="author_is_not_target"),
        # Also serves the job_id foreign key.
        UniqueConstraint("job_id", "author_id"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"))
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    author_role: Mapped[ReviewAuthorRole] = mapped_column(str_enum(ReviewAuthorRole, "author_role"))
    overall: Mapped[int] = mapped_column(SmallInteger)
    communication: Mapped[int | None] = mapped_column(SmallInteger)
    quality: Mapped[int | None] = mapped_column(SmallInteger)
    punctuality: Mapped[int | None] = mapped_column(SmallInteger)
    value: Mapped[int | None] = mapped_column(SmallInteger)
    comment: Mapped[str | None] = mapped_column(Text)


# A user's rating and their reviews newest first (#78, #252); also serves the target_id
# foreign key.
Index("ix_reviews_target_id_created_at", Review.target_id, Review.created_at.desc())
