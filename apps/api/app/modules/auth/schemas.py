from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    model_validator,
)

from app.config import PASSWORD_MAX_LENGTH
from app.modules.users.names import NAME_MAX_LENGTH, PersonName
from app.modules.users.schemas import UserOut
from app.modules.users.types import UserRole


def _trim_and_lowercase(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


def _lowercase(value: str) -> str:
    # EmailStr may re-normalize the domain; the database only accepts lowercase.
    return value.lower()


# Trimmed and lowercased before the address is validated, so lookups match the stored value.
NormalizedEmail = Annotated[
    EmailStr, BeforeValidator(_trim_and_lowercase), AfterValidator(_lowercase)
]


_NAME_RULES = (
    f"1 to {NAME_MAX_LENGTH} characters after trimming (inner spaces collapsed): letters, "
    "spaces, hyphens, apostrophes and periods. No contact details (an email, phone number, "
    "website or handle, even spelled out). Both or neither."
)


class RegisterRequest(BaseModel):
    email: NormalizedEmail
    password: str = Field(
        max_length=PASSWORD_MAX_LENGTH,
        description=(
            "Between the server's minimum (setting PASSWORD_MIN_LENGTH, 10 by default) and "
            f"{PASSWORD_MAX_LENGTH} characters. No composition rules."
        ),
    )
    # Staff accounts (agent, admin) are never self-registered.
    role: Literal[UserRole.CUSTOMER, UserRole.PRO]
    locale: Literal["en", "es"] = "en"
    # Optional for now, so the current app keeps working; required in a follow-up (#165).
    first_name: PersonName | None = Field(default=None, description=_NAME_RULES)
    last_name: PersonName | None = Field(default=None, description=_NAME_RULES)

    @model_validator(mode="after")
    def _both_names_or_neither(self) -> Self:
        if (self.first_name is None) != (self.last_name is None):
            raise ValueError("first_name and last_name go together")
        return self


class MeUpdateRequest(BaseModel):
    """PATCH /v1/auth/me: the caller's own names. Omit a field to keep it; null is refused."""

    model_config = ConfigDict(extra="forbid")

    first_name: PersonName | None = Field(default=None, description=_NAME_RULES)
    last_name: PersonName | None = Field(default=None, description=_NAME_RULES)

    @model_validator(mode="after")
    def _something_to_set(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("nothing to change")
        if any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("a name cannot be null")
        return self


class LoginRequest(BaseModel):
    email: NormalizedEmail
    password: str = Field(min_length=1, max_length=PASSWORD_MAX_LENGTH)


class AuthResponse(BaseModel):
    user: UserOut
    access_token: str
    refresh_token: str = Field(description="Opaque. Returned once; the server keeps a hash.")
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 - OAuth token type, not a secret
    expires_in: int = Field(description="Seconds until the access token expires.")


class RefreshTokenRequest(BaseModel):
    refresh_token: str = Field(description="The refresh token from the last AuthResponse.")


# E.164: a plus, a country code that does not start with 0, and at most 15 digits in all.
# [0-9], not \d: in Pydantic's regex \d also matches non-ASCII digits (Arabic-Indic,
# fullwidth...), which would give one number many spellings, hashes and rate-limit keys.
E164_PATTERN = r"^\+[1-9][0-9]{7,14}$"


class PhoneSendRequest(BaseModel):
    phone: str = Field(
        pattern=E164_PATTERN,
        description="E.164, e.g. +14075550123, with an allowed country code.",
    )


class PhoneVerifyRequest(BaseModel):
    phone: str = Field(pattern=E164_PATTERN, description="The number the code was sent to.")
    code: str = Field(pattern=r"^[0-9]{4,10}$", description="The code received by SMS.")


class PasswordForgotRequest(BaseModel):
    email: NormalizedEmail


class PasswordResetRequest(BaseModel):
    email: NormalizedEmail
    code: str = Field(pattern=r"^[0-9]{6}$", description="The 6-digit code from the email.")
    new_password: str = Field(
        max_length=PASSWORD_MAX_LENGTH,
        description=(
            "Between the server's minimum (setting PASSWORD_MIN_LENGTH, 10 by default) and "
            f"{PASSWORD_MAX_LENGTH} characters, as at registration."
        ),
    )
