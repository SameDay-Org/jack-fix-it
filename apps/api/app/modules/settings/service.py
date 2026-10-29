"""Typed access to the settings table (D9.1, #48; D9.3, #50; #246).

Each accessor reads the row on every call, with no cache, so an admin's change applies to the
next use. An invalid value logs `setting_invalid` with the key only (never the value). What a
missing or invalid row means depends on the setting:

| Key                          | Integer     | When missing          | When invalid          |
| ---------------------------- | ----------- | --------------------- | --------------------- |
| `dispatch_max_pros`          | 1..50       | the default, 5        | the default, 5        |
| `quote_ttl_hours`            | 1..8760     | None (seeded 48, #50) | None                  |
| `quote_max_amount_cents`     | 1..int4 max | None: no cap          | SettingMalformedError |
| `quote_max_duration_minutes` | 1..int4 max | None: no cap          | SettingMalformedError |
| `platform_take_rate_bps`     | 0..10000    | the default, 1500     | SettingMalformedError |

The quote TTL has no default in code: on None the caller refuses to act (not_configured). An
optional limit is read with `optional_positive_int`: absent means not set (the int4 column
still bounds it), but a present value that is not a positive int4 (a string, a bool, zero, a
float, null...) never reads as "no limit". It raises SettingMalformedError, a 503
not_configured, before anything is written.

The take rate (Cesar, 2026-10-29: 15%, the platform absorbs Stripe's card fee) is not seeded:
an absent row reads as the default without a log, so an admin's row overrides it. A present
value outside 0..10000 (or not an int) is never read as 0 or as the default: it raises
SettingMalformedError, like a malformed cap.
"""

import logging
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings.errors import SettingMalformedError
from app.modules.settings.repository import SettingRepository

logger = logging.getLogger(__name__)

INT4_MAX: Final = 2_147_483_647

DISPATCH_MAX_PROS: Final = "dispatch_max_pros"
DISPATCH_MAX_PROS_DEFAULT: Final = 5
DISPATCH_MAX_PROS_ALLOWED: Final = range(1, 51)

QUOTE_TTL_HOURS: Final = "quote_ttl_hours"
QUOTE_TTL_HOURS_ALLOWED: Final = range(1, 24 * 365 + 1)
QUOTE_MAX_AMOUNT_CENTS: Final = "quote_max_amount_cents"
QUOTE_MAX_DURATION_MINUTES: Final = "quote_max_duration_minutes"
_POSITIVE_INT4: Final = range(1, INT4_MAX + 1)

PLATFORM_TAKE_RATE_BPS: Final = "platform_take_rate_bps"
PLATFORM_TAKE_RATE_BPS_DEFAULT: Final = 1500
PLATFORM_TAKE_RATE_BPS_ALLOWED: Final = range(0, 10_001)


class SettingsService:
    def __init__(self, session: AsyncSession) -> None:
        self._settings = SettingRepository(session)

    async def dispatch_max_pros(self) -> int:
        """How many pros one request is sent to (context doc §5: up to N, default 5)."""
        value = await self._integer(DISPATCH_MAX_PROS, DISPATCH_MAX_PROS_ALLOWED)
        return DISPATCH_MAX_PROS_DEFAULT if value is None else value

    async def quote_ttl_hours(self) -> int | None:
        """How long a quote stays open (context doc §5: 48 hours, seeded by the migration).
        None when missing or invalid: there is no default in code, so callers refuse to quote."""
        return await self._integer(QUOTE_TTL_HOURS, QUOTE_TTL_HOURS_ALLOWED)

    async def quote_max_amount_cents(self) -> int | None:
        """The highest price a pro may quote, if the platform sets one."""
        return await self.optional_positive_int(QUOTE_MAX_AMOUNT_CENTS)

    async def quote_max_duration_minutes(self) -> int | None:
        """The longest estimated duration a quote may state, if the platform sets one."""
        return await self.optional_positive_int(QUOTE_MAX_DURATION_MINUTES)

    async def platform_take_rate_bps(self) -> int:
        """The platform's share of a quote's amount, in basis points (1500 = 15%): the default
        when the row is absent. Any other stored value logs `setting_invalid` (the key only) and
        raises SettingMalformedError: a malformed rate is never read as 0 or as the default."""
        row = await self._settings.get(PLATFORM_TAKE_RATE_BPS)
        if row is None:
            return PLATFORM_TAKE_RATE_BPS_DEFAULT
        # bool is an int in Python; a JSON true is not a number.
        if type(row.value) is int and row.value in PLATFORM_TAKE_RATE_BPS_ALLOWED:
            return row.value
        logger.warning("setting_invalid", extra={"key": PLATFORM_TAKE_RATE_BPS})
        raise SettingMalformedError(PLATFORM_TAKE_RATE_BPS)

    async def optional_positive_int(self, key: str) -> int | None:
        """An optional setting from 1 to the int4 maximum, such as a cap: None when its row is
        absent. Any other stored value logs `setting_invalid` (the key only) and raises
        SettingMalformedError: a malformed limit is never read as no limit."""
        row = await self._settings.get(key)
        if row is None:
            return None
        # bool is an int in Python; a JSON true is not a number.
        if type(row.value) is int and row.value in _POSITIVE_INT4:
            return row.value
        logger.warning("setting_invalid", extra={"key": key})
        raise SettingMalformedError(key)

    async def _integer(self, key: str, allowed: range) -> int | None:
        """A required setting's value, or None when it is missing or invalid; either logs
        `setting_invalid`."""
        row = await self._settings.get(key)
        value = row.value if row is not None else None
        # bool is an int in Python; a JSON true is not a number.
        if type(value) is int and value in allowed:
            return value
        logger.warning("setting_invalid", extra={"key": key})
        return None
