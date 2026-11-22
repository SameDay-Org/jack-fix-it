from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.interest.models import InterestSource, LaunchInterest


class InterestRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add_if_new(
        self, email: str, locale: str, source: InterestSource, consent_version: str
    ) -> bool:
        """Inserts the email's row unless it has one: one statement either way (ON CONFLICT DO
        NOTHING on the email), so a repeat costs what a first join costs and the first consent
        stands. True when this call inserted it."""
        statement = (
            insert(LaunchInterest)
            .values(email=email, locale=locale, source=source, consent_version=consent_version)
            .on_conflict_do_nothing(index_elements=[LaunchInterest.email])
            .returning(LaunchInterest.id)
        )
        return (await self._session.scalar(statement)) is not None
