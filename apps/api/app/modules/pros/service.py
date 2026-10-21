"""Pros: the only way other modules reach a pro profile (ADR 0003)."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pros.repository import ProProfileRepository


class ProService:
    def __init__(self, session: AsyncSession) -> None:
        self._profiles = ProProfileRepository(session)

    async def get_profile_id_for_user(self, user_id: uuid.UUID) -> uuid.UUID | None:
        """The pro_profiles.id of a user, or None when the user has no pro profile."""
        return await self._profiles.get_id_by_user_id(user_id)
