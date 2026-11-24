"""Which legal documents an account must accept, and its acceptances (#97).

The versions in force come from the settings (TERMS_VERSION, PRIVACY_VERSION,
PRO_AGREEMENT_VERSION), since the texts are Cesar's and live in the apps: the API keeps ids
only. A kind whose version is unset requires nothing. A new version requires every account it
applies to to accept it again (KINDS_BY_ROLE). Logs carry the user id, the kind and the version.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.terms.errors import TermsNotCurrentError
from app.modules.terms.repository import TermsRepository
from app.modules.terms.types import KINDS_BY_ROLE, TermsKind
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TermsConfig:
    # The version in force of each kind; None while none is published.
    versions: Mapping[TermsKind, str | None]

    @classmethod
    def from_settings(cls, settings: Settings) -> "TermsConfig":
        return cls(
            MappingProxyType(
                {
                    TermsKind.TERMS: settings.terms_version,
                    TermsKind.PRIVACY: settings.privacy_version,
                    TermsKind.PRO_AGREEMENT: settings.pro_agreement_version,
                }
            )
        )


@dataclass(frozen=True)
class TermsDocument:
    kind: TermsKind
    version: str
    accepted_at: datetime | None

    @property
    def accepted(self) -> bool:
        return self.accepted_at is not None


class TermsService:
    def __init__(self, session: AsyncSession, config: TermsConfig) -> None:
        self._session = session
        self._terms = TermsRepository(session)
        self._config = config

    def _in_force(self, role: UserRole) -> list[tuple[TermsKind, str]]:
        """(kind, version) of each document the role accepts that has a version published."""
        return [
            (kind, version)
            for kind in KINDS_BY_ROLE[role]
            if (version := self._config.versions[kind]) is not None
        ]

    async def documents(self, account: UserAccount) -> list[TermsDocument]:
        """Each document in force for the account, with when it accepted that version."""
        in_force = self._in_force(account.role)
        accepted = await self._terms.accepted_at(account.id, in_force)
        return [TermsDocument(kind, version, accepted.get(kind)) for kind, version in in_force]

    async def required(self, account: UserAccount) -> bool:
        """True while a document in force for the account is not accepted in its version."""
        return any(not document.accepted for document in await self.documents(account))

    async def accept(self, account: UserAccount, kind: TermsKind, version: str) -> TermsDocument:
        """Records the acceptance and commits. Idempotent: the same version again answers the
        same, with the first time. Anything but a document in force is TermsNotCurrentError."""
        if (kind, version) not in self._in_force(account.role):
            raise TermsNotCurrentError
        await self._terms.add_if_new(account.id, kind, version)
        await self._session.commit()
        logger.info(
            "terms_accepted",
            extra={"user_id": str(account.id), "kind": kind.value, "version": version},
        )
        accepted = await self._terms.accepted_at(account.id, [(kind, version)])
        return TermsDocument(kind, version, accepted.get(kind))
