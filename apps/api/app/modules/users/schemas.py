import uuid

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.users.types import UserAccount, UserRole, UserStatus


class UserOut(BaseModel):
    """The user as the API shows it. Never carries the password hash."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: UserRole
    locale: str
    status: UserStatus
    phone: str | None = Field(description="E.164, set once verified by SMS code.")
    phone_verified: bool
    first_name: str | None = Field(description="Null for accounts created before names.")
    last_name: str | None = Field(description="Null for accounts created before names.")

    @model_validator(mode="before")
    @classmethod
    def _from_account(cls, data: object) -> object:
        if isinstance(data, UserAccount):
            return {
                "id": data.id,
                "email": data.email,
                "role": data.role,
                "locale": data.locale,
                "status": data.status,
                "phone": data.phone,
                "phone_verified": data.phone_verified_at is not None,
                "first_name": data.first_name,
                "last_name": data.last_name,
            }
        return data
