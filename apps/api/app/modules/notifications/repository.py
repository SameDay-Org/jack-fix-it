import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import NotificationPreference


class NotificationPreferenceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def for_user(self, user_id: uuid.UUID) -> dict[tuple[str, str], bool]:
        """The user's stored choices, by (group, channel)."""
        statement = select(
            NotificationPreference.group,
            NotificationPreference.channel,
            NotificationPreference.enabled,
        ).where(NotificationPreference.user_id == user_id)
        return {(row[0], row[1]): row[2] for row in (await self._session.execute(statement)).all()}

    async def enabled(self, user_id: uuid.UUID, group: str, channel: str) -> bool | None:
        """The user's choice for one pair; None when they never changed it."""
        statement = select(NotificationPreference.enabled).where(
            NotificationPreference.user_id == user_id,
            NotificationPreference.group == group,
            NotificationPreference.channel == channel,
        )
        return (await self._session.scalars(statement)).one_or_none()

    async def upsert(self, user_id: uuid.UUID, choices: Sequence[tuple[str, str, bool]]) -> None:
        """Stores each (group, channel, enabled), in one statement."""
        if not choices:
            return
        values = insert(NotificationPreference).values(
            [
                {"user_id": user_id, "group": group, "channel": channel, "enabled": enabled}
                for group, channel, enabled in choices
            ]
        )
        statement = values.on_conflict_do_update(
            index_elements=[
                NotificationPreference.user_id,
                NotificationPreference.group,
                NotificationPreference.channel,
            ],
            set_={"enabled": values.excluded.enabled, "updated_at": func.now()},
        )
        await self._session.execute(statement)
