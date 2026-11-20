from pydantic import BaseModel, ConfigDict, Field

from app.config import PASSWORD_MAX_LENGTH


class AccountDeletionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str = Field(
        min_length=1,
        max_length=PASSWORD_MAX_LENGTH,
        description="The account's current password: the confirmation that the holder asks.",
    )
