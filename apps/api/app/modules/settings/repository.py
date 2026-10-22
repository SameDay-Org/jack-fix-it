from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings.models import Setting


class SettingRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, key: str) -> Setting | None:
        return await self._session.get(Setting, key, populate_existing=True)
