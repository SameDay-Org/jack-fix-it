import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class DispatchStatus(StrEnum):
    SENT = "sent"
    VIEWED = "viewed"  # the pro opened it in the feed (#49)
    DECLINED = "declined"
    QUOTED = "quoted"  # the pro sent a quote (#50)
    EXPIRED = "expired"


class RequestDispatch(IdTimestampsMixin, Base):
    """A request sent to one pro (D9.1, #48). One row per request and pro, so a re-run of
    dispatch never sends the same request to the same pro twice."""

    __tablename__ = "request_dispatches"
    __table_args__ = (UniqueConstraint("request_id", "pro_id"),)

    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("service_requests.id"), index=True)
    pro_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pro_profiles.id"), index=True)
    status: Mapped[DispatchStatus] = mapped_column(
        str_enum(DispatchStatus, "dispatch_status"), server_default=DispatchStatus.SENT.value
    )
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # When the pro answered (viewed, declined or quoted); response time = responded_at - sent_at.
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
