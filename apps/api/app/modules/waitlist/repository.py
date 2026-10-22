from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.waitlist.models import WaitlistEntry


class WaitlistRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def matching_for_update(
        self, zip_code: str, email: str | None, phone: str | None
    ) -> list[WaitlistEntry]:
        """The entries of this ZIP with this email or this phone, locked until commit."""
        contacts = []
        if email is not None:
            contacts.append(WaitlistEntry.email == email)
        if phone is not None:
            contacts.append(WaitlistEntry.phone == phone)
        statement = (
            select(WaitlistEntry)
            .where(WaitlistEntry.zip_code == zip_code, or_(*contacts))
            .order_by(WaitlistEntry.created_at, WaitlistEntry.id)
            .with_for_update()
        )
        return list((await self._session.scalars(statement)).all())

    async def add(self, entry: WaitlistEntry) -> None:
        """Inserts now (flush), so a concurrent duplicate surfaces here as a unique violation."""
        self._session.add(entry)
        await self._session.flush()

    async def pending_for_zip(self, zip_code: str) -> list[WaitlistEntry]:
        statement = (
            select(WaitlistEntry)
            .where(WaitlistEntry.zip_code == zip_code, WaitlistEntry.notified_at.is_(None))
            .order_by(WaitlistEntry.created_at, WaitlistEntry.id)
        )
        return list((await self._session.scalars(statement)).all())
