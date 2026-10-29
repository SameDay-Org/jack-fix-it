"""Notification preference groups (D13, #217): what a user may turn off, per channel.

The registry lives in code: each group's channels, its default and whether it is locked. The
table `notification_preferences` keeps only the pairs a user changed, so a new group or a new
default needs no data migration. A locked group (account and security) is always on.

Pushes are checked when the worker sends them (push_tasks.send_push), so a change made after
an event was queued is honored. Every catalog kind except `test` maps to one group (KIND_GROUP);
a test fails when a kind has none. Email and SMS have a preference only: nothing optional is
sent by those channels yet.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final


class PreferenceGroup(StrEnum):
    JOB_UPDATES = "job_updates"
    QUOTES_AND_OPPORTUNITIES = "quotes_and_opportunities"
    REMINDERS = "reminders"
    MARKETING = "marketing"
    ACCOUNT_AND_SECURITY = "account_and_security"


class Channel(StrEnum):
    PUSH = "push"
    EMAIL = "email"
    SMS = "sms"


@dataclass(frozen=True)
class GroupSpec:
    group: PreferenceGroup
    channels: tuple[Channel, ...]
    default: bool
    locked: bool  # always on: the user cannot turn it off


# In the order GET returns them.
PREFERENCE_GROUPS: Final[tuple[GroupSpec, ...]] = (
    GroupSpec(PreferenceGroup.JOB_UPDATES, (Channel.PUSH,), default=True, locked=False),
    GroupSpec(
        PreferenceGroup.QUOTES_AND_OPPORTUNITIES, (Channel.PUSH,), default=True, locked=False
    ),
    GroupSpec(PreferenceGroup.REMINDERS, (Channel.PUSH,), default=True, locked=False),
    GroupSpec(
        PreferenceGroup.MARKETING, (Channel.PUSH, Channel.EMAIL), default=False, locked=False
    ),
    GroupSpec(
        PreferenceGroup.ACCOUNT_AND_SECURITY,
        (Channel.PUSH, Channel.EMAIL, Channel.SMS),
        default=True,
        locked=True,
    ),
)
SPECS: Final[Mapping[PreferenceGroup, GroupSpec]] = MappingProxyType(
    {spec.group: spec for spec in PREFERENCE_GROUPS}
)

# The push kind (catalog key `push.<kind>.title|body`) to the group that can mute it.
TEST_KIND: Final = "test"  # never muted
KIND_GROUP: Final[Mapping[str, PreferenceGroup]] = MappingProxyType(
    {
        "new_request": PreferenceGroup.QUOTES_AND_OPPORTUNITIES,  # to a pro
        "new_quote": PreferenceGroup.QUOTES_AND_OPPORTUNITIES,  # to a customer
        "quote_accepted": PreferenceGroup.JOB_UPDATES,  # to a pro
    }
)


def push_kind(catalog_key: str) -> str:
    """`push.new_quote.title` -> `new_quote`."""
    return catalog_key.split(".")[1]


def group_of_push(title_key: str) -> PreferenceGroup | None:
    """The group whose push preference mutes this message; None for `test`, never muted."""
    kind = push_kind(title_key)
    return None if kind == TEST_KIND else KIND_GROUP[kind]


def has_channel(group: PreferenceGroup, channel: Channel) -> bool:
    return channel in SPECS[group].channels
