"""What other modules see of a user: enums and frozen values, never the ORM model (ADR 0003)."""

import uuid
from dataclasses import dataclass
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
class UserAccount:
    id: uuid.UUID
    email: str
    role: UserRole
    locale: str
    status: UserStatus


@dataclass(frozen=True)
class UserCredentials:
    """For login only: the account plus its password hash, which never leaves the API."""

    account: UserAccount
    password_hash: str
