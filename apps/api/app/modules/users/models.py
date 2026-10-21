from sqlalchemy import CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum
from app.modules.users.types import UserRole, UserStatus

# The enums live in types.py so other modules can use them without the ORM model.
__all__ = ["User", "UserRole", "UserStatus"]


class User(IdTimestampsMixin, Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("email = lower(email)", name="email_lowercase"),)

    email: Mapped[str] = mapped_column(String(320), unique=True)
    # E.164; NULL until the user adds one, and several users may have none.
    phone: Mapped[str | None] = mapped_column(String(20), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(str_enum(UserRole, "user_role"), index=True)
    # No CHECK: request schemas validate the locale, so adding one needs no migration.
    locale: Mapped[str] = mapped_column(String(8), server_default="en")
    status: Mapped[UserStatus] = mapped_column(
        str_enum(UserStatus, "user_status"), server_default=UserStatus.ACTIVE.value, index=True
    )
