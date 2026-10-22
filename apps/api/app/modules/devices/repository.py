import uuid
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.models import Device, DevicePlatform


class DeviceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(
        self, user_id: uuid.UUID, token: str, platform: DevicePlatform, now: datetime
    ) -> uuid.UUID:
        """The token's device, created or moved to `user_id`, with platform and last_seen_at
        refreshed. One statement, so two registrations of one token cannot collide."""
        values = insert(Device).values(
            user_id=user_id, expo_push_token=token, platform=platform, last_seen_at=now
        )
        statement = values.on_conflict_do_update(
            index_elements=[Device.expo_push_token],
            set_={
                "user_id": values.excluded.user_id,
                "platform": values.excluded.platform,
                "last_seen_at": values.excluded.last_seen_at,
                "updated_at": func.now(),
            },
        ).returning(Device.id)
        device_id: uuid.UUID = (await self._session.execute(statement)).scalar_one()
        return device_id

    async def keep_most_recent(self, user_id: uuid.UUID, keep: int) -> int:
        """Deletes the user's devices beyond the `keep` most recently seen; returns how many."""
        newest = (
            select(Device.id)
            .where(Device.user_id == user_id)
            .order_by(Device.last_seen_at.desc(), Device.id.desc())
            .limit(keep)
        )
        result = await self._session.execute(
            delete(Device).where(Device.user_id == user_id, Device.id.not_in(newest))
        )
        return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a DELETE

    async def delete_own(self, user_id: uuid.UUID, token: str) -> bool:
        result = await self._session.execute(
            delete(Device).where(Device.expo_push_token == token, Device.user_id == user_id)
        )
        return bool(result.rowcount)  # type: ignore[attr-defined]  # as above

    async def delete_by_id(self, device_id: uuid.UUID) -> bool:
        result = await self._session.execute(delete(Device).where(Device.id == device_id))
        return bool(result.rowcount)  # type: ignore[attr-defined]  # as above

    async def list_for_user(self, user_id: uuid.UUID) -> list[Device]:
        statement = select(Device).where(Device.user_id == user_id).order_by(Device.id)
        return list((await self._session.scalars(statement)).all())
