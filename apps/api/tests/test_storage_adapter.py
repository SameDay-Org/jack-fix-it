"""S3Storage signs locally: presigned PUT with Content-Type and Content-Length, and GET (#35)."""

import socket
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import botocore.auth
import pytest
from boto3.exceptions import RetriesExceededError, S3UploadFailedError
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.stub import Stubber

from app.integrations.storage import (
    DELETE_BATCH_MAX,
    DeleteResult,
    ObjectPage,
    S3Storage,
    StorageNotConfiguredError,
    StorageObjectMissingError,
    StorageUnavailableError,
    StoredObject,
)
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


# The worker's copies (#173): errors are typed and never carry the key.


def test_transfers_end_on_their_own_timeouts() -> None:
    # A stalled transfer must end its thread by itself: the job only stops waiting for it.
    settings = make_settings(
        **TEST_STORAGE_SETTINGS, s3_connect_timeout_seconds=3, s3_read_timeout_seconds=7
    )

    config = S3Storage.from_settings(settings)._client.meta.config

    assert (config.connect_timeout, config.read_timeout) == (3, 7)


KEY = "u/00000000-0000-0000-0000-000000000001/request_media/" + "a" * 32 + ".jpg"


def client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": f"about {KEY}"}}, "GetObject")


@pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
def test_a_missing_object_is_typed_and_keyless(
    storage: S3Storage, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, code: str
) -> None:
    def download_file(bucket: str, key: str, filename: str) -> None:
        raise client_error(code)

    monkeypatch.setattr(storage._client, "download_file", download_file)

    with pytest.raises(StorageObjectMissingError) as error:
        storage.download_to(KEY, tmp_path / "original")

    assert KEY not in str(error.value)


@pytest.mark.parametrize(
    "failure",
    [
        client_error("AccessDenied"),
        EndpointConnectionError(endpoint_url=KEY),
        RetriesExceededError(last_exception=OSError(f"body ended for {KEY}")),
        OSError(28, "No space left on device"),
    ],
)
def test_a_failing_download_is_unavailable_and_keyless(
    storage: S3Storage, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failure: Exception
) -> None:
    def download_file(bucket: str, key: str, filename: str) -> None:
        raise failure

    monkeypatch.setattr(storage._client, "download_file", download_file)

    with pytest.raises(StorageUnavailableError) as error:
        storage.download_to(KEY, tmp_path / "original")

    assert KEY not in str(error.value)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__  # raised from None


@pytest.mark.parametrize(
    "failure", [S3UploadFailedError(f"Failed to upload to {KEY}"), client_error("SlowDown")]
)
def test_a_failing_upload_is_unavailable_and_keyless(
    storage: S3Storage, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failure: Exception
) -> None:
    def upload_file(filename: str, bucket: str, key: str, ExtraArgs: dict[str, str]) -> None:  # noqa: N803 - boto3's name
        raise failure

    monkeypatch.setattr(storage._client, "upload_file", upload_file)
    source = tmp_path / "safe.jpg"
    source.write_bytes(b"x")

    with pytest.raises(StorageUnavailableError) as error:
        storage.upload_from(source, "m/" + "b" * 32 + ".jpg", "image/jpeg")

    assert KEY not in str(error.value)


def test_upload_sends_the_content_type(
    storage: S3Storage, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, str, dict[str, str]]] = []

    def upload_file(filename: str, bucket: str, key: str, ExtraArgs: dict[str, str]) -> None:  # noqa: N803 - boto3's name
        calls.append((filename, key, ExtraArgs))

    monkeypatch.setattr(storage._client, "upload_file", upload_file)
    source = tmp_path / "safe.jpg"
    source.write_bytes(b"x")

    storage.upload_from(source, "m/" + "b" * 32 + ".jpg", "image/jpeg")

    assert calls == [(str(source), "m/" + "b" * 32 + ".jpg", {"ContentType": "image/jpeg"})]


# The sweep of unreferenced uploads (#191): listing in pages, and deletes of at most 1,000 keys.

BUCKET = str(TEST_STORAGE_SETTINGS["s3_bucket"])
CUT = datetime(2026, 10, 23, 12, 0, 0, tzinfo=UTC)


def keys_of(count: int, start: int = 0) -> list[str]:
    return [
        f"u/00000000-0000-0000-0000-000000000001/request_media/{i:032x}.jpg"
        for i in range(start, start + count)
    ]


def test_list_older_than_pages_and_cuts_by_age(storage: S3Storage) -> None:
    old, young = CUT - timedelta(seconds=1), CUT
    first = {
        "IsTruncated": True,
        "NextContinuationToken": "next-page",
        "Contents": [
            {"Key": keys_of(1)[0], "LastModified": old},
            {"Key": keys_of(1, 1)[0], "LastModified": young},
        ],
    }
    second = {"IsTruncated": False, "Contents": [{"Key": keys_of(1, 2)[0], "LastModified": old}]}
    with Stubber(storage._client) as stub:
        stub.add_response("list_objects_v2", first, {"Bucket": BUCKET, "Prefix": "u/"})
        stub.add_response(
            "list_objects_v2",
            second,
            {"Bucket": BUCKET, "Prefix": "u/", "ContinuationToken": "next-page"},
        )
        stub.add_response(
            "list_objects_v2", {"IsTruncated": False}, {"Bucket": BUCKET, "Prefix": "m/"}
        )

        pages = list(storage.list_older_than("u/", CUT))
        empty = list(storage.list_older_than("m/", CUT))
        stub.assert_no_pending_responses()

    assert pages == [
        ObjectPage(objects=[StoredObject(keys_of(1)[0], old)], newer=1),
        ObjectPage(objects=[StoredObject(keys_of(1, 2)[0], old)], newer=0),
    ]
    assert empty == [ObjectPage(objects=[], newer=0)]


def test_list_older_than_asks_for_a_page_only_when_it_is_reached(storage: S3Storage) -> None:
    with Stubber(storage._client) as stub:
        stub.add_response(
            "list_objects_v2", {"IsTruncated": False}, {"Bucket": BUCKET, "Prefix": "u/"}
        )
        pages = storage.list_older_than("u/", CUT)
        with pytest.raises(AssertionError):  # nothing was asked yet
            stub.assert_no_pending_responses()
        assert next(pages) == ObjectPage(objects=[], newer=0)
        stub.assert_no_pending_responses()


@pytest.mark.parametrize(
    "failure", [client_error("AccessDenied"), EndpointConnectionError(endpoint_url=KEY)]
)
def test_a_failing_listing_is_unavailable_and_keyless(
    storage: S3Storage, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    class Paginator:
        def paginate(self, **params: object) -> Iterator[dict[str, object]]:
            yield {"Contents": [{"Key": KEY, "LastModified": CUT - timedelta(days=2)}]}
            raise failure

    monkeypatch.setattr(storage._client, "get_paginator", lambda name: Paginator())

    pages = storage.list_older_than("u/", CUT)
    assert len(next(pages).objects) == 1
    with pytest.raises(StorageUnavailableError) as error:
        next(pages)

    assert KEY not in str(error.value)
    assert error.value.__suppress_context__


def test_delete_many_sends_batches_of_at_most_1000_and_counts_errors(storage: S3Storage) -> None:
    keys = keys_of(2 * DELETE_BATCH_MAX + 5)
    batches = [keys[:1000], keys[1000:2000], keys[2000:]]
    with Stubber(storage._client) as stub:
        for number, batch in enumerate(batches):
            errors = (
                [{"Key": batch[0], "Code": "AccessDenied", "Message": "Denied"}]
                if number == 1
                else []
            )
            stub.add_response(
                "delete_objects",
                {"Errors": errors} if errors else {},
                {
                    "Bucket": BUCKET,
                    "Delete": {"Objects": [{"Key": key} for key in batch], "Quiet": True},
                },
            )

        result = storage.delete_many(keys)
        stub.assert_no_pending_responses()

    assert result == DeleteResult(deleted=len(keys) - 1, failed=1)


def test_delete_many_of_nothing_calls_nothing(storage: S3Storage) -> None:
    with Stubber(storage._client) as stub:
        assert storage.delete_many([]) == DeleteResult(deleted=0, failed=0)
        stub.assert_no_pending_responses()


@pytest.mark.parametrize(
    "failure", [client_error("SlowDown"), EndpointConnectionError(endpoint_url=KEY)]
)
def test_a_failing_delete_is_unavailable_and_keyless(
    storage: S3Storage, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    def delete_objects(**params: object) -> dict[str, object]:
        raise failure

    monkeypatch.setattr(storage._client, "delete_objects", delete_objects)

    with pytest.raises(StorageUnavailableError) as error:
        storage.delete_many([KEY])

    assert KEY not in str(error.value)
    assert error.value.__suppress_context__
