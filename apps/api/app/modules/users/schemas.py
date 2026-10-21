import uuid

from pydantic import BaseModel, ConfigDict

from app.modules.users.types import UserRole, UserStatus


class UserOut(BaseModel):
    """The user as the API shows it. Never carries the password hash."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: UserRole
    locale: str
    status: UserStatus
