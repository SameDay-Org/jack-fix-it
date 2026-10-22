"""Devices: the Expo push tokens of a user's phones (D10.3, #54)."""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum


class DevicePlatform(StrEnum):
    IOS = "ios"
    ANDROID = "android"


class Device(IdTimestampsMixin, Base):
    """One phone that receives pushes. A token belongs to one user at a time: a phone that
    changes hands moves to its new owner."""

    __tablename__ = "devices"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    expo_push_token: Mapped[str] = mapped_column(String(255), unique=True)
    platform: Mapped[DevicePlatform] = mapped_column(str_enum(DevicePlatform, "device_platform"))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
