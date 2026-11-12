"""What other modules see of a user: enums and frozen values, never the ORM model (ADR 0003)."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, StrEnum
from typing import Final, Literal

# The app languages a user may pick: at sign-up and in PATCH /v1/auth/me (#218).
Locale = Literal["en", "es"]


class UserRole(StrEnum):
    CUSTOMER = "customer"
    PRO = "pro"
    # agent and admin only use the admin/BDC panel.
    AGENT = "agent"
    ADMIN = "admin"


class UserStatus(StrEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"


class Keep(Enum):
    """A field a PATCH did not send: the stored value stays (None would clear it)."""

    KEEP = "keep"


KEEP: Final = Keep.KEEP


@dataclass(frozen=True)
class ContactPoints:
    """A user's email and phone. PII: only for masking them in text shown to the other party
    (#172, #188), never logged or returned."""

    email: str
    phone: str | None


@dataclass(frozen=True)
class UserAccount:
    id: uuid.UUID
    email: str
    role: UserRole
    locale: str
    status: UserStatus
    # The ID card's code (#250): 8 Crockford base32 characters, fixed at creation.
    public_code: str
    created_at: datetime
    # E.164; set together with phone_verified_at when verified by SMS code (#26).
    phone: str | None = None
    phone_verified_at: datetime | None = None
    # PII (#165): both set or both None. Never logged.
    first_name: str | None = None
    last_name: str | None = None
    # The card's city and state (#250): both set or both None. PII, never logged.
    home_city: str | None = None
    home_state: str | None = None
    # The ID photo's upload key (#250); the API signs a URL for it, never shows the key.
    photo_key: str | None = None


@dataclass(frozen=True)
class UserCredentials:
    """For login only: the account plus its password hash, which never leaves the API."""

    account: UserAccount
    password_hash: str
