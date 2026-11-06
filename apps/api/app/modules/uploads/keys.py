"""Upload keys (#35): where a file lives and what the key says about it.

`u/<user id>/<purpose>/<32 hex><extension>`: the owner, the purpose and the content type are in
the key, so a feature that records one (request media, a pro's documents, the profile and ID
photos) checks it with `owned_upload` and never parses keys itself. Pure functions and
constants, no HTTP or storage: safe to import from any module.
"""

import re
import uuid
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from app.modules.uploads.schemas import UploadPurpose
from app.modules.users.types import UserRole


class SizeClass(StrEnum):
    IMAGE = "image"
    VIDEO = "video"
    DOCUMENT = "document"


# Content type -> the key's extension. The only source of an extension.
EXTENSIONS: Final[dict[str, str]] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
}
_IMAGE_TYPES: Final = ("image/jpeg", "image/png", "image/webp", "image/heic")
_VIDEO_TYPES: Final = ("video/mp4", "video/quicktime")


@dataclass(frozen=True)
class PurposeRule:
    roles: frozenset[UserRole]
    # Allowed content type -> the size limit that applies to it.
    content_types: dict[str, SizeClass]


# Agents and admins upload nothing yet.
PURPOSES: Final[dict[UploadPurpose, PurposeRule]] = {
    UploadPurpose.REQUEST_MEDIA: PurposeRule(
        roles=frozenset({UserRole.CUSTOMER}),
        content_types={
            **dict.fromkeys(_IMAGE_TYPES, SizeClass.IMAGE),
            **dict.fromkeys(_VIDEO_TYPES, SizeClass.VIDEO),
        },
    ),
    UploadPurpose.JOB_PHOTO: PurposeRule(
        roles=frozenset({UserRole.PRO}),
        content_types=dict.fromkeys(_IMAGE_TYPES, SizeClass.IMAGE),
    ),
    UploadPurpose.PRO_DOCUMENT: PurposeRule(
        roles=frozenset({UserRole.PRO}),
        content_types=dict.fromkeys((*_IMAGE_TYPES, "application/pdf"), SizeClass.DOCUMENT),
    ),
    UploadPurpose.PROFILE_PHOTO: PurposeRule(
        roles=frozenset({UserRole.CUSTOMER, UserRole.PRO}),
        content_types=dict.fromkeys(_IMAGE_TYPES, SizeClass.IMAGE),
    ),
}

# u/<user id>/<purpose>/<32 hex><extension>, nothing else: no "..", no extra segment.
KEY_PATTERN: Final = re.compile(
    r"u/(?P<user_id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    rf"/(?P<purpose>{'|'.join(re.escape(p.value) for p in UploadPurpose)})"
    rf"/[0-9a-f]{{32}}(?:{'|'.join(re.escape(e) for e in sorted(set(EXTENSIONS.values())))})"
)


@dataclass(frozen=True)
class UploadKey:
    """What a well-formed upload key says: whose file it is and what for."""

    owner_id: uuid.UUID
    purpose: UploadPurpose


def parse_upload_key(key: str) -> UploadKey | None:
    """The owner and purpose of a well-formed upload key (KEY_PATTERN); None for any other key.
    For the sweep of uploads no row references (#191)."""
    match = KEY_PATTERN.fullmatch(key)
    if match is None:
        return None
    return UploadKey(owner_id=uuid.UUID(match["user_id"]), purpose=UploadPurpose(match["purpose"]))


@dataclass(frozen=True)
class OwnedUpload:
    """A file a feature may attach: its key and the content type its extension stands for."""

    key: str
    content_type: str


_CONTENT_TYPE_BY_EXTENSION: Final = {extension: kind for kind, extension in EXTENSIONS.items()}


def owned_upload(key: str, owner_id: uuid.UUID, purpose: UploadPurpose) -> OwnedUpload | None:
    """The upload behind `key` if it is a well-formed key of `owner_id` for `purpose`, whose
    type that purpose allows; None otherwise, without saying which check failed.

    For features that record keys (request media, job photos...), so they never parse keys
    themselves. It does not check that the file was actually uploaded.
    """
    match = KEY_PATTERN.fullmatch(key)
    if match is None or match["purpose"] != purpose.value or match["user_id"] != str(owner_id):
        return None
    content_type = _CONTENT_TYPE_BY_EXTENSION[key[key.rindex(".") :]]
    if content_type not in PURPOSES[purpose].content_types:
        return None
    return OwnedUpload(key=key, content_type=content_type)


def upload_content_type(key: str) -> str | None:
    """The content type a well-formed upload key's extension stands for; None for any other
    key. For the worker that copies an upload it already recorded (#173)."""
    if KEY_PATTERN.fullmatch(key) is None:
        return None
    return _CONTENT_TYPE_BY_EXTENSION[key[key.rindex(".") :]]


def make_key(user_id: uuid.UUID, purpose: UploadPurpose, content_type: str) -> str:
    return f"u/{user_id}/{purpose.value}/{uuid.uuid4().hex}{EXTENSIONS[content_type]}"
