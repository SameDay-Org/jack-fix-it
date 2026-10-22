"""Waitlist: people outside the served area who want to hear when it opens (D8.3, #46).

join() answers the same whether the contact was already on the list or not: one entry per
contact per ZIP, refreshed in place. The contact is kept only for the "your area is open"
notice (legal texts pending, #10). Logs carry the ZIP prefix and flags, never a contact.
"""

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.service import CategoryService
from app.modules.service_areas.schemas import zip5
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.types import UserAccount
from app.modules.waitlist.errors import (
    InvalidCategoryError,
    InvalidPhoneNumberError,
    ZipServedError,
)
from app.modules.waitlist.models import WaitlistEntry
from app.modules.waitlist.repository import WaitlistRepository
from app.modules.waitlist.schemas import WaitlistJoin

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WaitlistContact:
    """What the future "area opened" notice needs (#55/#65 era)."""

    entry_id: uuid.UUID
    email: str | None
    phone: str | None
    locale: str
    category_id: uuid.UUID | None


class WaitlistService:
    def __init__(
        self,
        session: AsyncSession,
        service_areas: ServiceAreaService,
        categories: CategoryService,
        allowed_country_codes: list[str],
    ) -> None:
        self._session = session
        self._entries = WaitlistRepository(session)
        self._service_areas = service_areas
        self._categories = categories
        self._allowed_country_codes = tuple(allowed_country_codes)

    async def join(self, data: WaitlistJoin, user: UserAccount | None) -> None:
        """Adds the contact to the ZIP's waitlist, or refreshes its entry, and commits."""
        if data.phone is not None and not data.phone.startswith(self._allowed_country_codes):
            raise InvalidPhoneNumberError
        if data.category_id is not None and not await self._categories.is_active(data.category_id):
            raise InvalidCategoryError
        zip_code = zip5(data.zip_code)
        if await self._service_areas.is_served(zip_code):
            raise ZipServedError

        existing = await self._entries.matching_for_update(zip_code, data.email, data.phone)
        for entry in existing:
            entry.locale = data.locale
            entry.source = data.source
            if data.category_id is not None:
                entry.category_id = data.category_id
            if user is not None:
                entry.user_id = user.id
        if len(existing) == 1:
            # One entry knows one of the contacts: it learns the other one too. Two entries (one
            # per contact) stay as they are, so neither unique index is touched.
            [entry] = existing
            entry.email = entry.email or data.email
            entry.phone = entry.phone or data.phone
        if not existing:
            await self._insert(zip_code, data, user)
        await self._session.commit()
        logger.info(
            "waitlist_joined",
            extra={
                "zip_prefix": zip_code[:3],
                "source": data.source.value,
                "signed_in": user is not None,
            },
        )

    async def entries_for_zip(self, zip_code: str) -> list[WaitlistContact]:
        """The contacts of a ZIP not notified yet, oldest first: for the "area opened" notice.
        No endpoint and no sending yet."""
        return [
            WaitlistContact(
                entry_id=entry.id,
                email=entry.email,
                phone=entry.phone,
                locale=entry.locale,
                category_id=entry.category_id,
            )
            for entry in await self._entries.pending_for_zip(zip5(zip_code))
        ]

    async def _insert(self, zip_code: str, data: WaitlistJoin, user: UserAccount | None) -> None:
        savepoint = await self._session.begin_nested()
        try:
            await self._entries.add(
                WaitlistEntry(
                    zip_code=zip_code,
                    email=data.email,
                    phone=data.phone,
                    category_id=data.category_id,
                    locale=data.locale,
                    source=data.source,
                    user_id=user.id if user is not None else None,
                )
            )
        except IntegrityError:
            # The same contact joined the same ZIP at the same moment: it is on the list.
            await savepoint.rollback()
            return
        await savepoint.commit()
