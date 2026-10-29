"""The user's notification preferences (D13, #217): read, change, and the send-time check.

The registry (notifications.preferences) gives each pair's default and lock; the repository
holds the pairs a user changed. A change list is applied all or nothing.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.errors import PreferenceLockedError
from app.modules.notifications.preferences import (
    PREFERENCE_GROUPS,
    SPECS,
    Channel,
    PreferenceGroup,
)
from app.modules.notifications.repository import NotificationPreferenceRepository
from app.modules.notifications.schemas import (
    ChannelPreference,
    GroupPreferences,
    NotificationPreferences,
    NotificationPreferencesPatch,
)


class NotificationPreferenceService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._preferences = NotificationPreferenceRepository(session)

    async def get(self, user_id: uuid.UUID) -> NotificationPreferences:
        stored = await self._preferences.for_user(user_id)
        return NotificationPreferences(
            groups=[
                GroupPreferences(
                    group=spec.group,
                    channels=[
                        ChannelPreference(
                            channel=channel,
                            # A locked pair is on whatever a row says.
                            enabled=spec.locked or stored.get((spec.group, channel), spec.default),
                            locked=spec.locked,
                        )
                        for channel in spec.channels
                    ],
                )
                for spec in PREFERENCE_GROUPS
            ]
        )

    async def update(
        self, user_id: uuid.UUID, patch: NotificationPreferencesPatch
    ) -> NotificationPreferences:
        """Stores every change, or none: a locked pair turned off refuses the whole list
        (preference_locked). A locked pair turned on is already on, so it is skipped."""
        choices: list[tuple[str, str, bool]] = []
        for change in patch.changes:
            if SPECS[change.group].locked:
                if not change.enabled:
                    raise PreferenceLockedError
                continue
            choices.append((change.group, change.channel, change.enabled))
        await self._preferences.upsert(user_id, choices)
        await self._session.commit()
        return await self.get(user_id)

    async def enabled(self, user_id: uuid.UUID, group: PreferenceGroup, channel: Channel) -> bool:
        """Whether the user gets this group by this channel: their choice, else the default."""
        spec = SPECS[group]
        if spec.locked:
            return True
        stored = await self._preferences.enabled(user_id, group, channel)
        return spec.default if stored is None else stored
