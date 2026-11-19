"""A dispute as each side of the job sees it (#75).

The customer reads back what they reported, their photos (the safe copy once ready, their own
original until then) and its status. The pro reads the same report with the photos' safe copies
only, and their own reply. Neither view names the other side: no contact detail, no user id.
The pro's reply is for the admin who resolves the dispute (#76), so the customer's view leaves it
out.
"""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.modules.addresses.schemas import NO_NUL
from app.modules.disputes.models import (
    TEXT_MAX_LENGTH,
    DisputeReason,
    DisputeResolution,
    DisputeStatus,
)

Text = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=TEXT_MAX_LENGTH, pattern=NO_NUL
    ),
]
UploadKey = Annotated[str, StringConstraints(min_length=1, max_length=256)]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DisputeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason_code: DisputeReason
    description: Text = Field(
        description="What went wrong, as plain text. Contact details are masked before it is "
        "stored; only the masked text is kept."
    )
    photo_keys: list[UploadKey] = Field(
        default_factory=list,
        description="Keys of the caller's own dispute_photo uploads (POST /v1/uploads), in "
        "the order to show them. Optional; at most DISPUTE_PHOTO_MAX_COUNT.",
    )


class DisputeReplyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: Text = Field(
        description="The pro's answer, as plain text, once. Contact details are masked before "
        "it is stored."
    )


class DisputePhotoOut(_Out):
    """One photo of the dispute, signed for a short while."""

    id: uuid.UUID
    content_type: str = Field(examples=["image/jpeg"])
    url: str = Field(description="A signed GET URL, valid until expires_at.")
    expires_at: datetime


class _DisputeOut(_Out):
    id: uuid.UUID
    reason_code: DisputeReason
    description: str
    status: DisputeStatus
    resolution: DisputeResolution | None = Field(
        description="How an admin settled it; null while open."
    )
    created_at: datetime
    resolved_at: datetime | None
    photos: list[DisputePhotoOut]
    photos_pending: int = Field(description="Photos whose copy is still being prepared.")


class CustomerDisputeOut(_DisputeOut):
    """The customer's own report, its description as stored (masked). Their photos show as
    soon as attached: their original until the safe copy is ready."""

    customer_refund_cents: int | None = Field(
        default=None,
        description="What the resolution gives back to the customer (#472): 0 for a release, "
        "part of the payment for a partial, the whole payment for a refund; null while open. "
        "Always sent; optional in the schema so clients built before #472 keep compiling.",
    )


class ProDisputeOut(_DisputeOut):
    """The report on the pro's job: the photos' safe copies only, once ready."""

    reply: str | None = Field(description="The pro's own answer, once given.")
    replied_at: datetime | None


class CustomerDisputeView(_Out):
    dispute: CustomerDisputeOut | None = Field(description="null while none was reported.")
    can_report: bool = Field(
        description="Whether the caller may report a problem now: the job is completed, its "
        "window is open and no problem was reported."
    )
    report_by: datetime | None = Field(
        description="Until when a problem can be reported; null when the job is not completed."
    )


class ProDisputeView(_Out):
    dispute: ProDisputeOut | None = Field(description="null while none was reported.")
    can_reply: bool = Field(description="Whether the pro may still answer: open, no reply yet.")
