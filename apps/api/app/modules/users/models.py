from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin, str_enum
from app.modules.users.locations import HOME_CITY_MAX_LENGTH, home_state_check_sql
from app.modules.users.public_codes import LENGTH as PUBLIC_CODE_LENGTH
from app.modules.users.public_codes import PATTERN as PUBLIC_CODE_PATTERN
from app.modules.users.public_codes import generate_public_code
from app.modules.users.types import UserRole, UserStatus

# The enums live in types.py so other modules can use them without the ORM model.
__all__ = ["User", "UserRole", "UserStatus"]


class User(IdTimestampsMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        CheckConstraint(f"public_code ~ '{PUBLIC_CODE_PATTERN}'", name="public_code_crockford"),
        CheckConstraint(home_state_check_sql(), name="home_state_us"),
        CheckConstraint("(home_city IS NULL) = (home_state IS NULL)", name="home_together"),
    )

    email: Mapped[str] = mapped_column(String(320), unique=True)
    # E.164; NULL until the user adds one, and several users may have none.
    phone: Mapped[str | None] = mapped_column(String(20), unique=True)
    # Set when the phone was verified by SMS code (#26); NULL while unverified.
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(str_enum(UserRole, "user_role"), index=True)
    # No CHECK: request schemas validate the locale, so adding one needs no migration.
    locale: Mapped[str] = mapped_column(String(8), server_default="en")
    status: Mapped[UserStatus] = mapped_column(
        str_enum(UserStatus, "user_status"), server_default=UserStatus.ACTIVE.value, index=True
    )
    # PII (#165): validated by users.names.PersonName; NULL for accounts created before names,
    # and set together. Never logged.
    first_name: Mapped[str | None] = mapped_column(String(60))
    last_name: Mapped[str | None] = mapped_column(String(60))
    # The ID card's code (#250, users.public_codes): random, unique, fixed at creation. Not a
    # secret, but never logged. UserService.create_user draws it and retries a collision;
    # the default covers every other ORM insert (fixtures), where a collision is an error.
    public_code: Mapped[str] = mapped_column(
        String(PUBLIC_CODE_LENGTH), unique=True, default=generate_public_code
    )
    # Where the user lives, as the card shows it (users.locations): both set or both NULL. PII.
    home_city: Mapped[str | None] = mapped_column(String(HOME_CITY_MAX_LENGTH))
    home_state: Mapped[str | None] = mapped_column(String(2))
    # The ID photo: the user's own profile_photo upload key, never a URL (#250).
    photo_key: Mapped[str | None] = mapped_column(String(512))
    # The Stripe Customer the user's payments attach to (#58): created at the first payment
    # with an idempotency key derived from the user id, then reused; NULL until then. An id
    # on Stripe's side, never logged.
    stripe_customer_id: Mapped[str | None] = mapped_column(String(255), unique=True)
