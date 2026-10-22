"""Object storage (S3-compatible: Cloudflare R2 or Railway Buckets), only through presigned URLs.

The API never proxies file bytes: clients PUT and GET directly with short-lived URLs signed
here. Signing is local (SigV4); no call reaches the storage at request time.

R2 has no presigned POST, so a size limit cannot be a POST policy. Instead Content-Length and
Content-Type are signed into the PUT: the client must send exactly the declared size and type,
or the storage rejects the upload.

The worker is the exception: it copies files between the storage and local temporary files
(download_to, upload_from) to make privacy-safe copies of request media (#173). These calls
block; the worker runs them in a thread. Errors never carry the key: a key can hold a user id.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import boto3
from boto3.exceptions import Boto3Error
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from starlette.requests import Request

from app.config import Settings


@dataclass(frozen=True)
class PresignedUpload:
    url: str
    # Exactly what the client must send with the PUT; both are part of the signature.
    headers: Mapping[str, str]


class Storage(Protocol):
    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload: ...

    def presign_get(self, key: str, expires_in: int) -> str: ...

    def download_to(self, key: str, path: Path) -> None:
        """Writes the object at `key` to `path`, streamed. StorageObjectMissingError when there is
        no such object, StorageUnavailableError when the storage fails."""
        ...

    def upload_from(self, path: Path, key: str, content_type: str) -> None:
        """Stores the file at `path` under `key`, streamed. StorageUnavailableError when the
        storage fails."""
        ...


class StorageNotConfiguredError(RuntimeError):
    """S3_* settings are missing (development or test without storage)."""


class StorageObjectMissingError(LookupError):
    """No object at the key (never uploaded, or deleted). The message never holds the key."""


class StorageUnavailableError(RuntimeError):
    """The storage failed or could not be reached: worth a retry. Never holds the key."""


# What S3 answers for a missing object: get_object says NoSuchKey, a HEAD (which download_file
# sends first) says 404.
_MISSING_CODES = frozenset({"404", "NoSuchKey", "NotFound"})


class S3Storage:
    def __init__(
        self,
        *,
        endpoint_url: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
        region: str,
    ) -> None:
        self._bucket = bucket
        # Path-style (endpoint/bucket/key): R2 and Railway Buckets serve it without a
        # bucket subdomain. Credentials are explicit, so nothing is read from ~/.aws.
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> "S3Storage":
        if (
            settings.s3_endpoint_url is None
            or settings.s3_bucket is None
            or settings.s3_access_key_id is None
            or settings.s3_secret_access_key is None
        ):
            raise StorageNotConfiguredError("S3_* settings are not set; uploads are unavailable")
        return cls(
            endpoint_url=settings.s3_endpoint_url,
            bucket=settings.s3_bucket,
            access_key_id=settings.s3_access_key_id.get_secret_value(),
            secret_access_key=settings.s3_secret_access_key.get_secret_value(),
            region=settings.s3_region,
        )

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:
        url: str = self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self._bucket,
                "Key": key,
                "ContentType": content_type,
                "ContentLength": content_length,
            },
            ExpiresIn=expires_in,
        )
        return PresignedUpload(
            url=url,
            headers={"Content-Type": content_type, "Content-Length": str(content_length)},
        )

    def presign_get(self, key: str, expires_in: int) -> str:
        url: str = self._client.generate_presigned_url(
            "get_object", Params={"Bucket": self._bucket, "Key": key}, ExpiresIn=expires_in
        )
        return url

    def download_to(self, key: str, path: Path) -> None:
        try:
            self._client.download_file(self._bucket, key, str(path))
        except ClientError as error:
            code = str(error.response.get("Error", {}).get("Code", ""))
            if code in _MISSING_CODES:
                raise StorageObjectMissingError("no object at this key") from None
            raise StorageUnavailableError(f"download failed: {code or 'unknown'}") from None
        except (Boto3Error, BotoCoreError, OSError) as error:
            # Boto3Error: RetriesExceededError when the body stops mid-download; OSError: the
            # local disk. Worth a retry either way.
            raise StorageUnavailableError(f"download failed: {type(error).__name__}") from None

    def upload_from(self, path: Path, key: str, content_type: str) -> None:
        try:
            self._client.upload_file(
                str(path), self._bucket, key, ExtraArgs={"ContentType": content_type}
            )
        except (Boto3Error, ClientError, BotoCoreError, OSError) as error:
            # boto3 wraps most failed uploads in S3UploadFailedError (a Boto3Error); its text,
            # like a ClientError's, names the key, so only the class is kept.
            raise StorageUnavailableError(f"upload failed: {type(error).__name__}") from None


def get_storage(request: Request) -> Storage:
    """FastAPI dependency: one S3Storage per app, built on first use (tests override this).

    Missing settings raise StorageNotConfiguredError: a generic, logged 500, never a crash at
    import or startup.
    """
    storage: Storage | None = getattr(request.app.state, "storage", None)
    if storage is None:
        storage = S3Storage.from_settings(request.app.state.settings)
        request.app.state.storage = storage
    return storage
