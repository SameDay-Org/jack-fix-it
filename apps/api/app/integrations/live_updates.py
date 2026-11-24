"""Live updates of an ongoing job to the lock screen (#596, PR 2b; Cesar 2026-11-23).

Two surfaces: the iPhone Live Activity, updated through APNs (`apns-push-type: liveactivity`)
with the activity's own token, and the Android ongoing notification, refreshed by an Expo
data-only message (no alert) that the app turns into the notification.

- What goes out: the live view only (LiveUpdate): the job's id and the request's code, the
  stage, the ETA, the road left, the progress and the time. Never a name, an address, the
  arrival code, an amount or a position.
- APNs is not configured yet: it needs the Apple credentials (#335) and an HTTP/2 client (the
  `h2` package, a new dependency for Cesar to approve). Until then ApnsLiveActivitySender
  sends nothing and logs that, with a count.
- Best effort: an update that does not go out is not tried again; the next one replaces it.
- Logs carry counts and the job's id, never a token or the payload.
"""

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from app.integrations.expo_push import DataMessage, ExpoPushSender, PushUnavailableError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LiveUpdate:
    """The live view of one job, as both lock screens show it."""

    job_id: uuid.UUID
    job_public_code: str
    stage: str
    eta_seconds: int | None
    distance_meters: int | None
    progress: float
    updated_at: datetime

    def as_data(self) -> dict[str, str]:
        """The Expo data message's fields: strings only, an unknown value as an empty one."""
        return {
            "type": "job_live",
            "job_id": str(self.job_id),
            "job_public_code": self.job_public_code,
            "stage": self.stage,
            "eta_seconds": "" if self.eta_seconds is None else str(self.eta_seconds),
            "distance_meters": "" if self.distance_meters is None else str(self.distance_meters),
            "progress": str(self.progress),
            "updated_at": self.updated_at.isoformat(),
        }

    def as_content_state(self) -> dict[str, object]:
        """The Live Activity's content state (ActivityKit's ContentState, as JSON)."""
        return {
            "jobPublicCode": self.job_public_code,
            "stage": self.stage,
            "etaSeconds": self.eta_seconds,
            "distanceMeters": self.distance_meters,
            "progress": self.progress,
            "updatedAt": self.updated_at.isoformat(),
        }


@dataclass(frozen=True)
class LiveTargets:
    """Where one job's update goes: its Live Activities' tokens and the customer's Android
    devices' Expo push tokens."""

    activity_tokens: tuple[str, ...]
    android_tokens: tuple[str, ...]

    @property
    def empty(self) -> bool:
        return not self.activity_tokens and not self.android_tokens


class LiveUpdateSender(Protocol):
    async def send(self, update: LiveUpdate, targets: LiveTargets) -> None:
        """Sends `update` to `targets`, best effort: never raises for a delivery that failed."""
        ...


class ApnsLiveActivitySender:
    """APNs liveactivity updates: not configured until #335 and the h2 dependency are in, so
    nothing is sent."""

    async def send(self, update: LiveUpdate, tokens: Sequence[str]) -> None:
        if tokens:
            logger.info(
                "live_update_apns_not_configured",
                extra={"job_id": str(update.job_id), "activities": len(tokens)},
            )


class ExpoAndroidLiveSender:
    """The Android update: one Expo data-only message per device, no alert."""

    def __init__(self, expo: ExpoPushSender) -> None:
        self._expo = expo

    async def send(self, update: LiveUpdate, tokens: Sequence[str]) -> None:
        if not tokens:
            return
        data = update.as_data()
        try:
            tickets = await self._expo.send_data(
                [DataMessage(to=token, data=data) for token in tokens]
            )
        except PushUnavailableError:
            logger.warning("live_update_android_unavailable", extra={"job_id": str(update.job_id)})
            return
        refused = sum(ticket.error is not None for ticket in tickets)
        logger.info(
            "live_update_android_sent",
            extra={"job_id": str(update.job_id), "devices": len(tokens), "refused": refused},
        )


class PushLiveUpdateSender:
    """Both surfaces: APNs for the activities, Expo for Android."""

    def __init__(self, apns: ApnsLiveActivitySender, android: ExpoAndroidLiveSender) -> None:
        self._apns = apns
        self._android = android

    async def send(self, update: LiveUpdate, targets: LiveTargets) -> None:
        await self._apns.send(update, targets.activity_tokens)
        await self._android.send(update, targets.android_tokens)
