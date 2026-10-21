import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pros.models import ProProfile


class ProProfileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_id_by_user_id(self, user_id: uuid.UUID) -> uuid.UUID | None:
        return await self._session.scalar(
            select(ProProfile.id).where(ProProfile.user_id == user_id)
        )
