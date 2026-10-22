"""Devices: the only way other modules reach push tokens (ADR 0003).

A user registers and removes only their own tokens; removing answers the same whether or not
the token existed. Logs carry user and device ids and counts: never a token.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.repository import DeviceRepository
from app.modules.devices.schemas import DeviceRegistration
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PushTarget:
    device_id: uuid.UUID
    expo_push_token: str


class DeviceService:
    def __init__(self, session: AsyncSession, max_devices_per_user: int) -> None:
        self._session = session
        self._devices = DeviceRepository(session)
        self._max_devices = max_devices_per_user

    async def register(self, user: UserAccount, data: DeviceRegistration) -> None:
        """Upserts by token (a phone that changed hands moves to the caller), then keeps only
        the caller's most recently seen devices, and commits.

        Locks, always in this order: the token, then every owner the transaction changes (the
        caller and the token's previous owner) sorted by id. The token lock keeps that owner
        from changing before its lock is taken. Owner locks make two registrations of one
        user take turns, so each prunes after seeing the other's device and the cap holds; the
        sorted order makes two crossing transfers (A takes B's token while B takes A's) queue
        instead of deadlocking. unregister and forget delete one row each and take no other
        lock while waiting on it, so they cannot close a cycle with this order."""
        await self._devices.lock_token(data.expo_push_token)
        owners = {user.id}
        if (previous_owner := await self._devices.owner_of(data.expo_push_token)) is not None:
            owners.add(previous_owner)
        for owner_id in sorted(owners):
            await self._devices.lock_owner(owner_id)
        device_id = await self._devices.upsert(
            user.id, data.expo_push_token, data.platform, datetime.now(UTC)
        )
        dropped = await self._devices.keep_most_recent(user.id, self._max_devices)
        await self._session.commit()
        logger.info(
            "device_registered",
            extra={"user_id": str(user.id), "device_id": str(device_id), "dropped": dropped},
        )

    async def unregister(self, user: UserAccount, token: str) -> None:
        """Removes the token only if it is the caller's; says nothing either way."""
        removed = await self._devices.delete_own(user.id, token)
        await self._session.commit()
        logger.info("device_unregistered", extra={"user_id": str(user.id), "removed": removed})

    async def targets_for(self, user_id: uuid.UUID) -> list[PushTarget]:
        return [
            PushTarget(device_id=device.id, expo_push_token=device.expo_push_token)
            for device in await self._devices.list_for_user(user_id)
        ]

    async def forget(self, device_id: uuid.UUID) -> None:
        """Deletes a device Expo reports as no longer registered, and commits. Idempotent."""
        if await self._devices.delete_by_id(device_id):
            logger.info("device_forgotten", extra={"device_id": str(device_id)})
        await self._session.commit()
