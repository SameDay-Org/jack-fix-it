"""What other modules see of a user: enums and frozen values, never the ORM model (ADR 0003)."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class UserRole(StrEnum):
    CUSTOMER = "customer"
    PRO = "pro"
    # agent and admin only use the admin/BDC panel.
    AGENT = "agent"
    ADMIN = "admin"


class UserStatus(StrEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"


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
    # E.164; set together with phone_verified_at when verified by SMS code (#26).
    phone: str | None = None
    phone_verified_at: datetime | None = None
    # PII (#165): both set or both None. Never logged.
    first_name: str | None = None
    last_name: str | None = None


@dataclass(frozen=True)
class UserCredentials:
    """For login only: the account plus its password hash, which never leaves the API."""

    account: UserAccount
    password_hash: str
