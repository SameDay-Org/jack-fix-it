"""Typed access to the settings table (D9.1, #48).

Each accessor reads the row on every call, with no cache, so an admin's change applies to the
next use. A missing or invalid row falls back to the documented default below, the same value
the migration seeds, and logs `setting_invalid` with the key only (never the value).

| Key                 | Type           | Default |
| ------------------- | -------------- | ------- |
| `dispatch_max_pros` | integer 1..50  | 5       |
"""

import logging
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings.repository import SettingRepository

logger = logging.getLogger(__name__)

DISPATCH_MAX_PROS: Final = "dispatch_max_pros"
DISPATCH_MAX_PROS_DEFAULT: Final = 5
DISPATCH_MAX_PROS_ALLOWED: Final = range(1, 51)


class SettingsService:
    def __init__(self, session: AsyncSession) -> None:
        self._settings = SettingRepository(session)

    async def dispatch_max_pros(self) -> int:
        """How many pros one request is sent to (context doc §5: up to N, default 5)."""
        return await self._integer(
            DISPATCH_MAX_PROS, DISPATCH_MAX_PROS_ALLOWED, DISPATCH_MAX_PROS_DEFAULT
        )

    async def _integer(self, key: str, allowed: range, default: int) -> int:
        row = await self._settings.get(key)
        value = row.value if row is not None else None
        # bool is an int in Python; a JSON true is not a number.
        if type(value) is int and value in allowed:
            return value
        logger.warning("setting_invalid", extra={"key": key})
        return default
