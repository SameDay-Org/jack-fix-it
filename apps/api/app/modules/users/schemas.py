import uuid
from datetime import UTC, date

from pydantic import BaseModel, Field

from app.modules.uploads.schemas import PhotoOut
from app.modules.users.types import UserAccount, UserRole, UserStatus


class UserOut(BaseModel):
    """The user as the API shows it. Never carries the password hash; the ID photo comes as
    a signed URL (#250)."""

    id: uuid.UUID
    email: str
    role: UserRole
    locale: str
    status: UserStatus
    phone: str | None = Field(description="E.164, set once verified by SMS code.")
    phone_verified: bool
    first_name: str | None = Field(description="Null for accounts created before names.")
    last_name: str | None = Field(description="Null for accounts created before names.")
    public_code: str = Field(
        description=(
            "The ID card's code: 8 Crockford base32 characters (0-9, A-Z without I, L, O, U), "
            "fixed at sign-up. Shown grouped as XXXX-XXXX."
        )
    )
    home_city: str | None = Field(description="With home_state; null until set.")
    home_state: str | None = Field(description="A US state or DC code, e.g. FL; null until set.")
    photo: PhotoOut | None = Field(description="The ID photo, a presigned GET; null until set.")
    member_since: date = Field(description="The day (UTC) the account was created.")

    @classmethod
    def from_account(cls, account: UserAccount, *, photo: PhotoOut | None) -> "UserOut":
        """`photo` is the signed URL of `account.photo_key`, or None when there is no key."""
        return cls(
            id=account.id,
            email=account.email,
            role=account.role,
            locale=account.locale,
            status=account.status,
            phone=account.phone,
            phone_verified=account.phone_verified_at is not None,
            first_name=account.first_name,
            last_name=account.last_name,
            public_code=account.public_code,
            home_city=account.home_city,
            home_state=account.home_state,
            photo=photo,
            member_since=account.created_at.astimezone(UTC).date(),
        )
