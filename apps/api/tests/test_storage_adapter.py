"""S3Storage signs locally: presigned PUT with Content-Type and Content-Length, and GET (#35)."""

import socket
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlparse

import botocore.auth
import pytest

from app.integrations.storage import S3Storage, StorageNotConfiguredError
from tests.conftest import TEST_STORAGE_SETTINGS, make_settings

KEY = "u/00000000-0000-4000-8000-000000000001/job_photo/0123456789abcdef0123456789abcdef.jpg"
FROZEN_NOW = datetime(2026, 10, 21, 12, 0, 0, tzinfo=UTC)


@pytest.fixture
def storage() -> S3Storage:
    return S3Storage.from_settings(make_settings(**TEST_STORAGE_SETTINGS))


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Signing must never open a connection."""

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("network access during signing")

    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    monkeypatch.setattr(socket.socket, "connect", refuse)


@pytest.fixture
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(botocore.auth, "get_current_datetime", lambda: FROZEN_NOW)


def query(url: str) -> dict[str, str]:
    return {name: values[0] for name, values in parse_qs(urlparse(url).query).items()}


def test_presign_put_signs_content_type_and_length(storage: S3Storage) -> None:
    upload = storage.presign_put(KEY, "image/jpeg", 1_234, expires_in=300)

    params = query(upload.url)
    assert params["X-Amz-SignedHeaders"].split(";") == ["content-length", "content-type", "host"]
    assert params["X-Amz-Expires"] == "300"
    assert params["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    assert dict(upload.headers) == {"Content-Type": "image/jpeg", "Content-Length": "1234"}


def test_signature_binds_the_declared_size_and_type(storage: S3Storage, frozen_clock: None) -> None:
    def signature(content_type: str, length: int) -> str:
        return query(storage.presign_put(KEY, content_type, length, 300).url)["X-Amz-Signature"]

    declared = signature("image/jpeg", 1_234)

    assert signature("image/jpeg", 1_234) == declared
    # A client sending another size or type no longer matches the signature.
    assert signature("image/jpeg", 1_235) != declared
    assert signature("image/png", 1_234) != declared


def test_presign_get_has_expiry(storage: S3Storage) -> None:
    url = storage.presign_get(KEY, expires_in=120)

    params = query(url)
    assert params["X-Amz-Expires"] == "120"
    assert params["X-Amz-SignedHeaders"] == "host"
    assert "X-Amz-Signature" in params


def test_uses_path_style_and_configured_endpoint(storage: S3Storage) -> None:
    for url in (storage.presign_put(KEY, "image/jpeg", 1, 300).url, storage.presign_get(KEY, 300)):
        parsed = urlparse(url)
        assert f"{parsed.scheme}://{parsed.netloc}" == TEST_STORAGE_SETTINGS["s3_endpoint_url"]
        assert parsed.path == f"/{TEST_STORAGE_SETTINGS['s3_bucket']}/{KEY}"
        # The region of the configured settings is in the credential scope.
        assert "/auto/s3/aws4_request" in query(url)["X-Amz-Credential"]


@pytest.mark.parametrize(
    "missing", ["s3_endpoint_url", "s3_bucket", "s3_access_key_id", "s3_secret_access_key"]
)
def test_missing_settings_raise_not_configured(missing: str) -> None:
    settings = make_settings(**{**TEST_STORAGE_SETTINGS, missing: None})

    with pytest.raises(StorageNotConfiguredError):
        S3Storage.from_settings(settings)
