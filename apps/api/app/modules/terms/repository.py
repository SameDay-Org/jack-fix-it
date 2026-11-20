import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.terms.models import TermsAcceptance
from app.modules.terms.types import TermsKind


class TermsRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add_if_new(self, user_id: uuid.UUID, kind: TermsKind, version: str) -> None:
        """One statement either way: a version already accepted keeps its first time."""
        await self._session.execute(
            insert(TermsAcceptance)
            .values(user_id=user_id, kind=kind, version=version)
            .on_conflict_do_nothing(
                index_elements=[
                    TermsAcceptance.user_id,
                    TermsAcceptance.kind,
                    TermsAcceptance.version,
                ]
            )
        )

    async def accepted_at(
        self, user_id: uuid.UUID, documents: Collection[tuple[TermsKind, str]]
    ) -> dict[TermsKind, datetime]:
        """When the user accepted each of these (kind, version) pairs; absent when not."""
        if not documents:
            return {}
        statement = select(TermsAcceptance.kind, TermsAcceptance.accepted_at).where(
            TermsAcceptance.user_id == user_id,
            tuple_(TermsAcceptance.kind, TermsAcceptance.version).in_(list(documents)),
        )
        return {kind: at for kind, at in (await self._session.execute(statement)).all()}
