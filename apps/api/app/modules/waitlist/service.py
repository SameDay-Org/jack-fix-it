"""Waitlist: people outside the served area who want to hear when it opens (D8.4, #46).

join() answers the same whether the contact was already on the list or not: one entry per
contact per ZIP, refreshed in place. The contact is kept only for the "your area is open"
notice (legal texts pending, #10). Logs carry the ZIP prefix, flags, constraint names and entry
ids, never a contact.
"""

import logging
import uuid
from dataclasses import dataclass
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.modules.categories.service import CategoryService
from app.modules.service_areas.schemas import zip5
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.types import UserAccount
from app.modules.waitlist.errors import (
    InvalidCategoryError,
    InvalidPhoneNumberError,
    WaitlistWriteError,
    ZipServedError,
)
from app.modules.waitlist.models import WaitlistEntry
from app.modules.waitlist.repository import WaitlistRepository
from app.modules.waitlist.schemas import WaitlistJoin

logger = logging.getLogger(__name__)

# Constraint names (app.db naming convention; migration 9072864e3137).
_CONTACT_UNIQUES: Final = frozenset(
    {"uq_waitlist_entries_zip_code_email", "uq_waitlist_entries_zip_code_phone"}
)
_CATEGORY_FK: Final = "fk_waitlist_entries_category_id_categories"
# A unique violation means a writer that skips the ZIP lock got there first: the join reads
# again and applies itself once more. A second one is a server error.
_WRITE_ATTEMPTS: Final = 2


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
        """Adds the contact to the ZIP's waitlist, or refreshes its entry, and commits.

        A category removed meanwhile is a 422 (invalid_category); any other integrity error is
        a server error, never a 202 with nothing saved.
        """
        if data.phone is not None and not data.phone.startswith(self._allowed_country_codes):
            raise InvalidPhoneNumberError
        if data.category_id is not None and not await self._categories.is_active(data.category_id):
            raise InvalidCategoryError
        zip_code = zip5(data.zip_code)
        if await self._service_areas.is_served(zip_code):
            raise ZipServedError

        for attempt in range(1, _WRITE_ATTEMPTS + 1):
            entry_ids: list[uuid.UUID] = []
            try:
                entry_ids = await self._apply(zip_code, data, user)
                await self._session.commit()
            except IntegrityError as error:
                await self._session.rollback()
                constraint = violated_constraint(error)
                # Never the error itself: its message holds the row's email or phone.
                logger.warning(
                    "waitlist_conflict",
                    extra={
                        "constraint": constraint,
                        "zip_prefix": zip_code[:3],
                        "entry_ids": [str(entry_id) for entry_id in entry_ids],
                        "attempt": attempt,
                    },
                )
                if constraint == _CATEGORY_FK:
                    raise InvalidCategoryError from None
                if constraint in _CONTACT_UNIQUES and attempt < _WRITE_ATTEMPTS:
                    continue
                raise WaitlistWriteError(constraint) from None
            logger.info(
                "waitlist_joined",
                extra={
                    "zip_prefix": zip_code[:3],
                    "source": data.source.value,
                    "signed_in": user is not None,
                },
            )
            return

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

    async def _apply(
        self, zip_code: str, data: WaitlistJoin, user: UserAccount | None
    ) -> list[uuid.UUID]:
        """Writes the join under the ZIP's lock, so no other join of this ZIP reads or writes in
        between. The ZIP's entries with the email or the phone decide:

        - none: a new entry with both contacts;
        - one: it is refreshed and learns the contact it lacks. No other entry of the ZIP owns
          that contact, or the read would have found it too;
        - two (the email on one, the phone on the other): both are refreshed, and no contact
          moves between them, so neither unique index is touched.

        Refreshed means locale, source, the category when given and the user when signed in.
        Returns the ids of the updated entries; the caller's commit writes it all.
        """
        await self._entries.lock_zip(zip_code)
        existing = await self._entries.matching_for_update(zip_code, data.email, data.phone)
        if not existing:
            self._entries.add(
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
            return []
        entry_ids = [entry.id for entry in existing]
        for entry in existing:
            entry.locale = data.locale
            entry.source = data.source
            if data.category_id is not None:
                entry.category_id = data.category_id
            if user is not None:
                entry.user_id = user.id
        if len(existing) == 1:
            [entry] = existing
            entry.email = entry.email or data.email
            entry.phone = entry.phone or data.phone
        return entry_ids
