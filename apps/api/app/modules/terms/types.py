"""What other modules see of terms: the document kinds, never the ORM model (ADR 0003)."""

from collections.abc import Mapping
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from app.modules.users.types import UserRole


class TermsKind(StrEnum):
    TERMS = "terms"
    PRIVACY = "privacy"
    PRO_AGREEMENT = "pro_agreement"


# The documents each role accepts (#97), in the order the apps show them. Staff accept none
# here: their accounts are made by script (scripts/create_staff_user.py).
KINDS_BY_ROLE: Final[Mapping[UserRole, tuple[TermsKind, ...]]] = MappingProxyType(
    {
        UserRole.CUSTOMER: (TermsKind.TERMS, TermsKind.PRIVACY),
        UserRole.PRO: (TermsKind.TERMS, TermsKind.PRIVACY, TermsKind.PRO_AGREEMENT),
        UserRole.AGENT: (),
        UserRole.ADMIN: (),
    }
)
