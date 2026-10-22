from typing import Final

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.waitlist.models import WaitlistEntry

# A transaction-scoped advisory lock per ZIP, keyed by a hash of "waitlist:<zip>" (a ZIP is not
# a contact). Released at commit or rollback.
_LOCK_ZIP: Final = text("SELECT pg_advisory_xact_lock(hashtextextended('waitlist:' || :zip, 0))")


class WaitlistRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def lock_zip(self, zip_code: str) -> None:
        """Waits until no other transaction holds this ZIP's lock, then holds it until commit:
        the joins of one ZIP read and write one at a time."""
        await self._session.execute(_LOCK_ZIP, {"zip": zip_code})

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

    def add(self, entry: WaitlistEntry) -> None:
        """Inserted at the caller's commit."""
        self._session.add(entry)

    async def pending_for_zip(self, zip_code: str) -> list[WaitlistEntry]:
        statement = (
            select(WaitlistEntry)
            .where(WaitlistEntry.zip_code == zip_code, WaitlistEntry.notified_at.is_(None))
            .order_by(WaitlistEntry.created_at, WaitlistEntry.id)
        )
        return list((await self._session.scalars(statement)).all())
