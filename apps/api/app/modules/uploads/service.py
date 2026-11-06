"""Presigned upload and download URLs: one safe path for every file a feature stores.

- Upload: the caller asks for a purpose, a content type and an exact size. The API checks
  them against PURPOSES and the size settings, makes a random key namespaced by the owner and
  returns a short-lived PUT URL with Content-Type and Content-Length signed in. File bytes
  never pass through the API, and no client file name, path or extension is ever used.
- Download: here a caller gets a GET URL only for a key under their own `u/<user_id>/`
  (`ensure_owner`); any other key answers 404, so another user's files are never revealed.
  Staff and cross-user reads (e.g. a pro seeing a request's photos) belong to the feature
  services, which call `Storage.presign_get` after their own authorization.

Access: both routes depend on `AppUser` (customer or pro; agents and admins get the generic
403). The purpose arrives in the body, so the per-purpose role check stays here, in PURPOSES,
the one table of which role may upload what: code policy, deliberately. Sizes and URL
lifetimes are settings.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.config import Settings
from app.errors import NotFoundError
from app.integrations.storage import Storage
from app.modules.auth.permissions import ensure_owner
from app.modules.uploads.errors import (
    UploadForbiddenError,
    UploadInvalidError,
    UploadNotFoundError,
)
from app.modules.uploads.keys import (
    KEY_PATTERN,
    PURPOSES,
    SizeClass,
    make_key,
)
from app.modules.uploads.schemas import (
    DownloadUrlResponse,
    UploadRequest,
    UploadResponse,
)
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UploadConfig:
    upload_url_ttl_seconds: int
    download_url_ttl_seconds: int
    max_bytes: dict[SizeClass, int]

    @classmethod
    def from_settings(cls, settings: Settings) -> "UploadConfig":
        return cls(
            upload_url_ttl_seconds=settings.upload_url_ttl_seconds,
            download_url_ttl_seconds=settings.download_url_ttl_seconds,
            max_bytes={
                SizeClass.IMAGE: settings.upload_max_image_bytes,
                SizeClass.VIDEO: settings.upload_max_video_bytes,
                SizeClass.DOCUMENT: settings.upload_max_document_bytes,
            },
        )


class UploadService:
    def __init__(self, storage: Storage, config: UploadConfig) -> None:
        self._storage = storage
        self._config = config

    def create_upload(self, user: UserAccount, data: UploadRequest) -> UploadResponse:
        rule = PURPOSES[data.purpose]
        if user.role not in rule.roles:
            raise UploadForbiddenError
        size_class = rule.content_types.get(data.content_type)
        if size_class is None or not 0 < data.size_bytes <= self._config.max_bytes[size_class]:
            raise UploadInvalidError
        key = make_key(user.id, data.purpose, data.content_type)
        ttl = self._config.upload_url_ttl_seconds
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
        upload = self._storage.presign_put(key, data.content_type, data.size_bytes, ttl)
        logger.info(
            "upload_url_issued",
            extra={
                "user_id": str(user.id),
                "purpose": data.purpose.value,
                "content_type": data.content_type,
                "size_bytes": data.size_bytes,
            },
        )
        return UploadResponse(
            key=key, upload_url=upload.url, headers=dict(upload.headers), expires_at=expires_at
        )

    def create_download_url(self, user: UserAccount, key: str) -> DownloadUrlResponse:
        match = KEY_PATTERN.fullmatch(key)
        if match is None:
            raise UploadInvalidError
        try:
            ensure_owner(uuid.UUID(match["user_id"]), user)
        except NotFoundError:
            # The same body as before: another user's key reads like a missing file.
            raise UploadNotFoundError from None
        ttl = self._config.download_url_ttl_seconds
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
        url = self._storage.presign_get(key, ttl)
        logger.info(
            "download_url_issued",
            extra={"user_id": str(user.id), "purpose": match["purpose"]},
        )
        return DownloadUrlResponse(url=url, expires_at=expires_at)
