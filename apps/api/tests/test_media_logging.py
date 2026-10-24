"""Vendor logs on the media copy path name no key, path or photo metadata, even at DEBUG (#173).

The production adapter and logging config, the real boto3 transfer machinery: storage is
botocore's Stubber or a fake S3 on loopback in this process, so urllib3 runs too.
"""

import io
import logging
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal

import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber
from PIL import Image

from app.integrations.storage import S3Storage, StorageUnavailableError
from app.modules.media.sanitize import SanitizeConfig, sanitize_image
from app.observability import JsonFormatter, configure_logging
from tests.conftest import TEST_STORAGE_SETTINGS, make_settings

KEY = "u/12345678-1234-4123-8123-123456789abc/request_media/12345678123441238123123456789abc.jpg"
BUCKET = str(TEST_STORAGE_SETTINGS["s3_bucket"])
PAYLOAD = b"fixture-image-bytes"
ARTIST = "Jane Customer"

Operation = Literal["download", "upload"]
OPERATIONS: list[Operation] = ["download", "upload"]


def logged_text(record: logging.LogRecord) -> str:
    """All a record can put in a sink: its message, its args, and the JSON line (extras and
    exception text). Escaped backslashes are undone so a Windows path matches either way."""
    text = "\n".join([record.getMessage(), repr(record.args), JsonFormatter().format(record)])
    for _ in range(2):  # repr, then JSON, each double the backslashes
        text = text.replace("\\\\", "\\")
    return text


def leaks(records: list[logging.LogRecord], *secrets: str) -> list[tuple[str, str]]:
    return [
        (record.name, secret)
        for record in records
        for secret in secrets
        if secret in logged_text(record)
    ]


@pytest.fixture
def debug_logs(caplog: pytest.LogCaptureFixture) -> Iterator[pytest.LogCaptureFixture]:
    """LOG_LEVEL=DEBUG as the API and the worker apply it."""
    with caplog.at_level(logging.DEBUG):
        configure_logging("DEBUG")
        yield caplog


def test_vendor_loggers_on_the_media_path_stay_quiet_at_debug() -> None:
    configure_logging("DEBUG")

    for name in ("boto3", "botocore", "s3transfer", "PIL"):
        assert logging.getLogger(name).getEffectiveLevel() == logging.WARNING, name
    assert logging.getLogger("urllib3").getEffectiveLevel() == logging.ERROR


def run_transfer(storage: S3Storage, operation: Operation, local: Path) -> None:
    if operation == "download":
        storage.download_to(KEY, local)
    else:
        local.write_bytes(PAYLOAD)
        storage.upload_from(local, KEY, "image/jpeg")


@pytest.mark.parametrize("fails", [False, True], ids=["ok", "fails"])
@pytest.mark.parametrize("operation", OPERATIONS)
def test_a_stubbed_transfer_logs_no_key_or_path(
    debug_logs: pytest.LogCaptureFixture, tmp_path: Path, operation: Operation, fails: bool
) -> None:
    storage = S3Storage.from_settings(make_settings(**TEST_STORAGE_SETTINGS))
    local = tmp_path / "private-original.jpg"
    with Stubber(storage._client) as stub:
        if operation == "download":
            head = {"Bucket": BUCKET, "Key": KEY}
            stub.add_response("head_object", {"ContentLength": len(PAYLOAD)}, head)
            if fails:
                # The GET fails, not the HEAD: s3transfer has queued the keyed task by then.
                stub.add_client_error("get_object", "AccessDenied", http_status_code=403)
            else:
                body = StreamingBody(io.BytesIO(PAYLOAD), len(PAYLOAD))
                stub.add_response("get_object", {"Body": body, "ContentLength": len(PAYLOAD)})
        elif fails:
            stub.add_client_error("put_object", "AccessDenied", http_status_code=403)
        else:
            stub.add_response("put_object", {})

        if fails:
            with pytest.raises(StorageUnavailableError):
                run_transfer(storage, operation, local)
        else:
            run_transfer(storage, operation, local)
            assert local.read_bytes() == PAYLOAD
        stub.assert_no_pending_responses()

    assert not leaks(debug_logs.records, KEY, BUCKET, str(tmp_path), tmp_path.as_posix())


class FakeS3(BaseHTTPRequestHandler):
    """Path-style S3 on loopback: an object for HEAD and GET, 200 for PUT, or 403 to all."""

    deny = False

    def log_message(self, format: str, *args: object) -> None:
        pass  # http.server writes to stderr, not to logging

    def reply(self, body: bytes = b"") -> None:
        if self.deny:
            body = b"<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>"
        self.send_response(403 if self.deny else 200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", '"0"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:
        self.send_response(403 if self.deny else 200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()

    def do_GET(self) -> None:
        self.reply(PAYLOAD)

    def do_PUT(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.reply()


@pytest.fixture
def fake_s3() -> Iterator[ThreadingHTTPServer]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeS3)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("fails", [False, True], ids=["ok", "fails"])
@pytest.mark.parametrize("operation", OPERATIONS)
def test_a_transfer_over_http_logs_no_key_or_path(
    debug_logs: pytest.LogCaptureFixture,
    fake_s3: ThreadingHTTPServer,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    operation: Operation,
    fails: bool,
) -> None:
    monkeypatch.setattr(FakeS3, "deny", fails)
    endpoint = f"http://127.0.0.1:{fake_s3.server_address[1]}"
    settings = make_settings(**{**TEST_STORAGE_SETTINGS, "s3_endpoint_url": endpoint})
    storage = S3Storage.from_settings(settings)
    local = tmp_path / "private-original.jpg"

    if fails:
        with pytest.raises(StorageUnavailableError):
            run_transfer(storage, operation, local)
    else:
        run_transfer(storage, operation, local)
        assert local.read_bytes() == PAYLOAD

    assert not leaks(debug_logs.records, KEY, BUCKET, str(tmp_path), tmp_path.as_posix())


def test_reading_a_photo_logs_none_of_its_exif(
    debug_logs: pytest.LogCaptureFixture, tmp_path: Path
) -> None:
    exif = Image.Exif()
    exif[0x013B] = ARTIST  # Artist
    exif[0x0112] = 6  # Orientation: the sanitizer reads the EXIF to turn the picture upright
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2] = "N", (25.0, 45.0, 42.0)
    source = tmp_path / "private-original.jpg"
    Image.new("RGB", (40, 20), "red").save(source, "JPEG", exif=exif)
    workdir = tmp_path / "out"
    workdir.mkdir()
    config = SanitizeConfig(
        max_image_pixels=1_000_000, jpeg_quality=85, ffmpeg_path="ffmpeg", timeout_seconds=60
    )

    safe = sanitize_image(source, "image/jpeg", workdir, config)

    assert Image.open(safe.path).size == (20, 40)  # turned upright: the EXIF was read
    assert not leaks(debug_logs.records, ARTIST, "25.0, 45.0, 42.0", str(tmp_path))
