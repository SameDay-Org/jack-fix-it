"""What other modules see of a user: enums and frozen values, never the ORM model (ADR 0003)."""

import uuid
from collections.abc import Mapping
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
    # The customer of a request made on the web without an account (#86): never signs in,
    # holds no contact (the request's web contact has it, staff only), is never dispatched.
    GUEST = "guest"
    # The account holder deleted it (#97): anonymised in place, never active again. The row
    # stays because jobs, payments and the audit log point at it.
    DELETED = "deleted"


# A guest's stored email and password hash (#86): an address that is never delivered (the
# .invalid TLD, RFC 2606) and unique per guest, and a hash no password verifies (not a hash).
GUEST_EMAIL_DOMAIN: Final = "guest.invalid"
GUEST_PASSWORD_HASH: Final = "!guest"  # noqa: S105 - no secret: a marker no password verifies
# What replaces free text a deleted account wrote, or that staff wrote about it (#97), where
# the row itself stays: a request's description and address line, a support ticket, a note.
ERASED_TEXT: Final = "Removed when the account was deleted."


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


@dataclass(frozen=True)
class PartyNames:
    """Names as another party sees them, from one read (UserService.public_names,
    first_names). A deleted account (#97) has none: `get` answers None and its id is in
    `deleted`, so a view sends `<who>_deleted` and the apps show their own words for it (#590,
    Cesar's 3B). Never "Deleted user" as data."""

    names: Mapping[uuid.UUID, str | None]
    deleted: frozenset[uuid.UUID]

    def get(self, user_id: uuid.UUID) -> str | None:
        return self.names.get(user_id)

    def is_deleted(self, user_id: uuid.UUID) -> bool:
        return user_id in self.deleted
