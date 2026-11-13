"""Reviews as their author and their target see them (#77).

An author reads back their own review only; the other side's review of the same job never
leaves the API here. A user's rating is the average and the count alone: no review, no author.
"""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.reviews.models import COMMENT_MAX_LENGTH, RATING_MAX, RATING_MIN

# A JSON integer only: no "5", no 5.0, no true.
Rating = Annotated[int, Field(ge=RATING_MIN, le=RATING_MAX, strict=True)]
Comment = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=COMMENT_MAX_LENGTH, pattern=NO_NUL
    ),
]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overall: Rating = Field(description="The overall rating, 1 (worst) to 5 (best).")
    communication: Rating | None = Field(default=None, description="Optional, 1 to 5.")
    quality: Rating | None = Field(
        default=None,
        description="Optional, 1 to 5. From the job's customer only: refused (422) from the pro.",
    )
    punctuality: Rating | None = Field(default=None, description="Optional, 1 to 5.")
    value: Rating | None = Field(
        default=None,
        description="Optional, 1 to 5. From the job's customer only: refused (422) from the pro.",
    )
    comment: Comment | None = Field(
        default=None,
        description="Optional text, trimmed. Contact details in it (phones, emails, links, "
        "handles, addresses) are replaced by ••• before it is stored; only the masked text is "
        "kept.",
    )


class ReviewCreatedOut(_Out):
    id: uuid.UUID
    created_at: datetime
    comment_redacted: bool = Field(
        description="True when something in the comment was masked: the app tells the author "
        "that contact details are not shared in reviews. False otherwise, and with no comment."
    )


class ReviewOut(_Out):
    """The caller's own review, as stored."""

    id: uuid.UUID
    overall: int
    communication: int | None
    quality: int | None
    punctuality: int | None
    value: int | None
    comment: str | None = Field(
        description="The text as stored: contact details were replaced by ••• when it was written."
    )
    created_at: datetime


class MyReviewOut(_Out):
    review: ReviewOut | None = Field(
        description="The caller's own review of this job; null when they wrote none. Never the "
        "other side's."
    )
    can_review: bool = Field(
        description="True while the caller may still review this job: it was confirmed and "
        "they wrote no review yet."
    )


class RatingOut(_Out):
    average: float | None = Field(
        description="The average of the overall ratings the caller received, to one decimal; "
        "null with none (No ratings yet)."
    )
    count: int = Field(description="How many reviews the caller received.")
