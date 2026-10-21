"""Object storage (S3-compatible: Cloudflare R2 or Railway Buckets), only through presigned URLs.

The API never proxies file bytes: clients PUT and GET directly with short-lived URLs signed
here. Signing is local (SigV4); no call reaches the storage at request time.

R2 has no presigned POST, so a size limit cannot be a POST policy. Instead Content-Length and
Content-Type are signed into the PUT: the client must send exactly the declared size and type,
or the storage rejects the upload.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

import boto3
from botocore.config import Config
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


class StorageNotConfiguredError(RuntimeError):
    """S3_* settings are missing (development or test without storage)."""


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
