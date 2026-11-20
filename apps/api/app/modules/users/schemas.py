import uuid
from datetime import UTC, date
from typing import Any

from pydantic import BaseModel, Field

from app.modules.uploads.schemas import PhotoOut
from app.modules.users.types import UserAccount, UserRole, UserStatus


def _without_default(schema: dict[str, Any]) -> None:
    """Leaves a field's default out of the published schema: openapi-typescript types a field
    with a default as always present, one without as optional."""
    schema.pop("default", None)


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
    # Always sent (from_account takes it, without a default); optional in the published schema,
    # so the apps built before #97 still type-check and an older API reads as not required.
    terms_required: bool = Field(
        default=False,
        description="True while a legal document in force for the account is not accepted in "
        "its version (GET /v1/me/terms): the app asks for it before anything else (#97). "
        "Absent from an API older than #97: read it as false.",
        json_schema_extra=_without_default,
    )

    @classmethod
    def from_account(
        cls, account: UserAccount, *, photo: PhotoOut | None, terms_required: bool
    ) -> "UserOut":
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
            terms_required=terms_required,
        )
