from typing import Final, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.notifications.preferences import Channel, PreferenceGroup, has_channel

MAX_CHANGES: Final = 20


class ChannelPreference(BaseModel):
    channel: Channel
    enabled: bool
    locked: bool = Field(description="Always on: the user cannot turn it off.")


class GroupPreferences(BaseModel):
    group: PreferenceGroup
    channels: list[ChannelPreference]


class NotificationPreferences(BaseModel):
    """Every group, in a fixed order, with each of its channels: the user's choice, or the
    default when they never changed it."""

    groups: list[GroupPreferences]


class PreferenceChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    group: PreferenceGroup
    channel: Channel
    enabled: bool


class NotificationPreferencesPatch(BaseModel):
    """1 to MAX_CHANGES changes, each pair once and only a channel its group has."""

    model_config = ConfigDict(extra="forbid")

    changes: list[PreferenceChange] = Field(min_length=1, max_length=MAX_CHANGES)

    @model_validator(mode="after")
    def _check_pairs(self) -> Self:
        pairs = [(change.group, change.channel) for change in self.changes]
        if len(set(pairs)) != len(pairs):
            raise ValueError("each group and channel appears once")
        if not all(has_channel(group, channel) for group, channel in pairs):
            raise ValueError("a channel the group does not have")
        return self
