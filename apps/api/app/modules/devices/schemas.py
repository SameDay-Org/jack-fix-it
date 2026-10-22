from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.modules.devices.models import DevicePlatform

# What Expo issues: ExponentPushToken[...] or ExpoPushToken[...]. ASCII classes only.
EXPO_PUSH_TOKEN_PATTERN = r"^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$"  # noqa: S105 - a format

ExpoPushToken = Annotated[
    str, Field(pattern=EXPO_PUSH_TOKEN_PATTERN, description="The Expo push token.")
]


class DeviceRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expo_push_token: ExpoPushToken
    platform: DevicePlatform


class DeviceRemoval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expo_push_token: ExpoPushToken
