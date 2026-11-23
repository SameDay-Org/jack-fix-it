"""The pros' part of an account deletion (#97).

The profile row stays (jobs, quotes and transfers point at it; its Connect account id is where
a transfer went and how Stripe's events find it), but loses its bio and photo, its categories
and service areas (so dispatch never offers it a request), and its documents: the ID, license
and insurance scans. Their rows go at once, so nothing serves them; the caller deletes the
files from storage (accounts.cleanup). Staff's review of the profile (status, reason) stays.
"""

import uuid

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pros.models import ProCategory, ProDocument, ProProfile, ProServiceArea


class ProErasure:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def erase(self, user_id: uuid.UUID) -> list[str]:
        """Erases the user's pro profile, if any; the storage keys of its photo and documents.
        The profile row is locked first, as every change to it is."""
        profile = await self._session.scalar(
            select(ProProfile)
            .where(ProProfile.user_id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if profile is None:
            return []
        keys = [profile.photo_key] if profile.photo_key else []
        keys.extend(
            await self._session.scalars(
                select(ProDocument.file_key).where(ProDocument.pro_id == profile.id)
            )
        )
        for model in (ProDocument, ProCategory, ProServiceArea):
            await self._session.execute(
                delete(model)
                .where(model.pro_id == profile.id)
                .execution_options(synchronize_session=False)
            )
        await self._session.execute(
            update(ProProfile)
            .where(ProProfile.id == profile.id)
            .values(bio=None, photo_key=None)
            .execution_options(synchronize_session=False)
        )
        return keys
