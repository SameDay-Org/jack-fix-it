"""The devices' part of an account deletion (#97): every push token of the account goes, so
nothing is ever sent to its phones again."""

import uuid

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.models import Device
from app.modules.devices.repository import DeviceRepository


async def forget_devices(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Deletes the user's devices under the owner's lock (DeviceService's order: a register
    of a token of theirs waits, then finds no row to keep); how many. No commit."""
    await DeviceRepository(session).lock_owner(user_id)
    result = await session.execute(
        delete(Device).where(Device.user_id == user_id).execution_options(synchronize_session=False)
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult of a write
