"""Privacy-safe copies of photos and videos (#173): the file transforms, on real files.

Fixtures are built here: images with Pillow and pillow-heif (EXIF with a GPS IFD, an artist and
a copyright, XMP, PNG text chunks), videos with ffmpeg (a location and a creation time). The
video tests need ffmpeg and ffprobe: in CI they fail without them, locally they skip.
"""

import asyncio
import dataclasses
import io
import json
import os
import shutil
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest
from PIL import Image, PngImagePlugin

from app.modules.media import sanitize as sanitize_module
from app.modules.media.sanitize import (
    SafeFile,
    SanitizeConfig,
    SanitizeError,
    SanitizeFailure,
    SanitizeRetryableError,
    _check_copy,
    _Stream,
    sanitize,
)

CONFIG = SanitizeConfig(
    max_image_pixels=1_000_000, jpeg_quality=85, ffmpeg_path="ffmpeg", timeout_seconds=60
)
GPS_IFD = 0x8825
ORIENTATION, ARTIST, COPYRIGHT = 0x0112, 0x013B, 0x8298
XMP = (
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF>'
    b"<exif:GPSLatitude>25,45.6N</exif:GPSLatitude></rdf:RDF></x:xmpmeta>"
)
LOCATION = "+25.7617-080.1918/"


def phone_exif() -> Image.Exif:
    """What a phone writes: where (GPS), who (artist, copyright) and which way up (rotated)."""
    exif = Image.Exif()
    exif[ARTIST] = "Jane Customer"
    exif[COPYRIGHT] = "Jane Customer 2026"
    exif[ORIENTATION] = 6  # the picture must turn 90 degrees to be upright
    gps = exif.get_ifd(GPS_IFD)
    gps[1], gps[2] = "N", (25.0, 45.0, 42.0)
    gps[3], gps[4] = "W", (80.0, 11.0, 30.0)
    return exif


def assert_no_metadata(path: Path) -> Image.Image:
    image = Image.open(path)
    assert dict(image.getexif()) == {}
    assert image.getexif().get_ifd(GPS_IFD) == {}
    assert "exif" not in image.info
    assert "xmp" not in image.info
    assert not any(
        isinstance(key, str) and key.startswith(("XML:", "Raw profile")) for key in image.info
    )
    raw = path.read_bytes()
    for leak in (b"Jane Customer", b"GPSLatitude", b"Exif\x00\x00"):
        assert leak not in raw, leak
    return image


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    out = tmp_path / "out"
    out.mkdir()
    return out


async def test_jpeg_gps_exif_is_removed(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    Image.new("RGB", (40, 20), "red").save(source, "JPEG", exif=phone_exif(), xmp=XMP)
    assert Image.open(source).getexif().get_ifd(GPS_IFD)  # the fixture does carry GPS

    safe = await sanitize(source, "image/jpeg", workdir, CONFIG)

    assert (safe.content_type, safe.extension) == ("image/jpeg", ".jpg")
    image = assert_no_metadata(safe.path)
    assert image.format == "JPEG"
    assert image.size == (20, 40)  # turned upright, then the orientation tag is gone


async def test_heic_becomes_jpeg_without_metadata(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    Image.new("RGB", (32, 16), "blue").save(source, format="HEIF", exif=phone_exif().tobytes())
    assert Image.open(source).getexif().get_ifd(GPS_IFD)

    safe = await sanitize(source, "image/heic", workdir, CONFIG)

    assert (safe.content_type, safe.extension) == ("image/jpeg", ".jpg")
    assert assert_no_metadata(safe.path).format == "JPEG"


async def test_png_text_chunks_removed(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    text = PngImagePlugin.PngInfo()
    text.add_text("Comment", "Jane Customer, 25.7617 -80.1918")
    text.add_itxt("XML:com.adobe.xmp", XMP.decode())
    Image.new("RGBA", (10, 10), (0, 255, 0, 128)).save(
        source, "PNG", pnginfo=text, exif=phone_exif()
    )
    original = Image.open(source)
    assert isinstance(original, PngImagePlugin.PngImageFile)
    assert original.text  # the fixture does carry text chunks

    safe = await sanitize(source, "image/png", workdir, CONFIG)

    image = assert_no_metadata(safe.path)
    assert isinstance(image, PngImagePlugin.PngImageFile)
    assert (image.format, image.mode, safe.extension) == ("PNG", "RGBA", ".png")
    assert image.text == {}


async def test_webp_exif_removed(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    Image.new("RGB", (12, 12), "white").save(source, "WEBP", exif=phone_exif(), xmp=XMP)
    assert "exif" in Image.open(source).info

    safe = await sanitize(source, "image/webp", workdir, CONFIG)

    assert (safe.content_type, safe.extension) == ("image/webp", ".webp")
    assert assert_no_metadata(safe.path).format == "WEBP"


async def test_icc_profile_is_kept(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    icc = b"\x00\x00\x02\x0cfake-icc-profile-bytes" + b"\x00" * 64
    Image.new("RGB", (8, 8)).save(source, "JPEG", icc_profile=icc, exif=phone_exif())

    safe = await sanitize(source, "image/jpeg", workdir, CONFIG)

    assert Image.open(safe.path).info.get("icc_profile") == icc


async def test_decompression_bomb_fails(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    Image.new("L", (2_000, 1_000)).save(source, "PNG")  # 2 000 000 pixels, over the limit

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "image/png", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.TOO_MANY_PIXELS
    assert await asyncio.to_thread(lambda: list(workdir.iterdir())) == []


@pytest.mark.parametrize(
    ("content", "content_type"),
    [
        (b"just some text, not a picture", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\n-truncated", "image/png"),
        (b"RIFF\x00\x00\x00\x00WEBPjunk", "image/webp"),
        (b"not a heic file at all", "image/heic"),
    ],
)
async def test_wrong_type_bytes_fail(
    tmp_path: Path, workdir: Path, content: bytes, content_type: str
) -> None:
    source = tmp_path / "original"
    source.write_bytes(content)

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, content_type, workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNREADABLE


async def test_an_image_decodes_only_as_its_declared_type(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    Image.new("RGB", (8, 8)).save(source, "PNG")  # a PNG sent as a JPEG

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "image/jpeg", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNREADABLE


async def test_an_unknown_type_fails(tmp_path: Path, workdir: Path) -> None:
    with pytest.raises(SanitizeError) as error:
        await sanitize(tmp_path / "original", "application/pdf", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNSUPPORTED


# Videos


@dataclass(frozen=True)
class Tools:
    ffmpeg: str
    ffprobe: str


@pytest.fixture
def tools() -> Tools:
    """ffmpeg and ffprobe on PATH. In CI their absence is a failure, not a skip."""
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if ffmpeg and ffprobe:
        return Tools(ffmpeg, ffprobe)
    if os.environ.get("CI") == "true":
        pytest.fail("ffmpeg and ffprobe are required in CI (#173)")
    pytest.skip("ffmpeg or ffprobe is not on PATH")


def make_video(tools: Tools, path: Path, container: str) -> None:
    subprocess.run(  # noqa: S603 - fixed arguments, test fixture
        [
            *(tools.ffmpeg, "-v", "error", "-y"),
            *("-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10"),
            *("-f", "lavfi", "-i", "sine=duration=1"),
            *("-c:v", "libx264", "-c:a", "aac", "-shortest"),
            *("-metadata", f"location={LOCATION}"),
            *("-metadata", "creation_time=2026-01-02T03:04:05Z"),
            *("-f", container, str(path)),
        ],
        check=True,
    )


def probe(tools: Tools, path: Path) -> dict[str, object]:
    command = [tools.ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json"]
    result = subprocess.run(  # noqa: S603 - fixed arguments, test fixture
        [*command, str(path)], check=True, capture_output=True, text=True
    )
    parsed: dict[str, object] = json.loads(result.stdout)
    return parsed


def all_tags(probed: dict[str, object]) -> dict[str, str]:
    tags: dict[str, str] = {}
    fmt = probed.get("format")
    if isinstance(fmt, dict):
        tags.update(fmt.get("tags", {}))
    streams = probed.get("streams")
    for stream in streams if isinstance(streams, list) else []:
        tags.update(stream.get("tags", {}))
    return tags


def codecs(probed: dict[str, object]) -> list[str]:
    streams = probed.get("streams")
    return [s["codec_name"] for s in streams] if isinstance(streams, list) else []


@pytest.mark.parametrize(
    ("content_type", "container", "extension"),
    [("video/mp4", "mp4", ".mp4"), ("video/quicktime", "mov", ".mov")],
)
async def test_video_location_metadata_removed(
    tmp_path: Path, workdir: Path, tools: Tools, content_type: str, container: str, extension: str
) -> None:
    source = tmp_path / "original"
    make_video(tools, source, container)
    before = probe(tools, source)
    assert any("location" in key for key in all_tags(before))  # the fixture does carry it

    safe = await sanitize(source, content_type, workdir, CONFIG)

    assert (safe.content_type, safe.extension) == (content_type, extension)
    after = probe(tools, safe.path)
    tags = all_tags(after)
    assert not any("location" in key or "creation_time" in key for key in tags), tags
    assert LOCATION.encode() not in safe.path.read_bytes()
    assert codecs(after) == codecs(before) == ["h264", "aac"]  # copied, not re-encoded


@pytest.mark.usefixtures("tools")
async def test_a_file_that_does_not_read_as_mp4_fails(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    source.write_bytes(b"not a video")

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "video/mp4", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNREADABLE
    assert error.value.exit_code not in (None, 0)


@pytest.mark.parametrize("missing", ["ffmpeg", "ffprobe"])
async def test_a_missing_binary_is_retried(
    tmp_path: Path, workdir: Path, tools: Tools, missing: str
) -> None:
    source = tmp_path / "original"
    make_video(tools, source, "mp4")
    absent = str(tmp_path / f"no-such-{missing}")
    config = (
        dataclasses.replace(CONFIG, ffmpeg_path=absent)
        if missing == "ffmpeg"
        else dataclasses.replace(CONFIG, ffprobe_path=absent)
    )

    with pytest.raises(SanitizeRetryableError) as error:
        await sanitize(source, "video/mp4", workdir, config)

    assert error.value.reason == SanitizeFailure.FFMPEG_UNAVAILABLE


async def test_a_slow_ffmpeg_is_killed_and_retried(
    tmp_path: Path, workdir: Path, tools: Tools
) -> None:
    source = tmp_path / "original"
    make_video(tools, source, "mp4")
    config = SanitizeConfig(1_000_000, 85, "ffmpeg", timeout_seconds=0.001)

    with pytest.raises(SanitizeRetryableError) as error:
        await sanitize(source, "video/mp4", workdir, config)

    assert error.value.reason == SanitizeFailure.TIMEOUT


# Review findings (#173): embedded images, wrong containers, crafted inputs, crashes, cancels.


def gps_jpeg_file(path: Path) -> None:
    exif = phone_exif()
    exif[0x0110] = "iPhone 15 Pro"
    Image.new("RGB", (64, 48), "red").save(path, "JPEG", exif=exif)


def run_ffmpeg(tools: Tools, *arguments: str) -> None:
    subprocess.run(  # noqa: S603 - fixed arguments, test fixture
        [tools.ffmpeg, "-v", "error", "-y", *arguments], check=True
    )


def video_kinds(tools: Tools, path: Path) -> list[tuple[str, str]]:
    streams = probe(tools, path).get("streams")
    return (
        [(s["codec_type"], s["codec_name"]) for s in streams] if isinstance(streams, list) else []
    )


def made_a_copy(workdir: Path) -> bool:
    return any(path.name.startswith("safe") for path in workdir.iterdir())


async def test_video_cover_art_exif_removed(tmp_path: Path, workdir: Path, tools: Tools) -> None:
    base, cover, source = tmp_path / "base.mp4", tmp_path / "gps.jpg", tmp_path / "original"
    make_video(tools, base, "mp4")
    gps_jpeg_file(cover)
    run_ffmpeg(
        tools, "-i", str(base), "-i", str(cover), "-map", "0", "-map", "1", "-c", "copy",
        "-disposition:v:1", "attached_pic", "-f", "mp4", str(source),
    )  # fmt: skip
    assert b"Jane Customer" in source.read_bytes()

    safe = await sanitize(source, "video/mp4", workdir, CONFIG)

    assert video_kinds(tools, safe.path) == [("video", "h264"), ("audio", "aac")]
    assert b"Jane Customer" not in safe.path.read_bytes()
    assert b"Exif\x00\x00" not in safe.path.read_bytes()


async def test_video_mjpeg_track_exif_not_copied(
    tmp_path: Path, workdir: Path, tools: Tools
) -> None:
    base, image, source = tmp_path / "base.mp4", tmp_path / "gps.jpg", tmp_path / "original"
    make_video(tools, base, "mp4")
    gps_jpeg_file(image)
    run_ffmpeg(
        tools, "-i", str(base), "-i", str(image), "-map", "0:v", "-map", "1:v", "-map", "0:a",
        "-c", "copy", "-f", "mov", str(source),
    )  # fmt: skip

    safe = await sanitize(source, "video/quicktime", workdir, CONFIG)

    assert video_kinds(tools, safe.path) == [("video", "h264"), ("audio", "aac")]
    assert b"Jane Customer" not in safe.path.read_bytes()


async def test_an_mjpeg_video_fails_as_an_unsupported_codec(
    tmp_path: Path, workdir: Path, tools: Tools
) -> None:
    image, source = tmp_path / "gps.jpg", tmp_path / "original"
    gps_jpeg_file(image)
    run_ffmpeg(tools, "-i", str(image), "-c", "copy", "-f", "mov", str(source))

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "video/quicktime", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNSUPPORTED_CODEC


@pytest.mark.parametrize("content_type", ["video/mp4", "video/quicktime"])
@pytest.mark.usefixtures("tools")
async def test_a_jpeg_declared_as_video_fails(
    tmp_path: Path, workdir: Path, content_type: str
) -> None:
    source = tmp_path / "original"
    gps_jpeg_file(source)

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, content_type, workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNREADABLE
    assert not made_a_copy(workdir)


@pytest.mark.parametrize("manifest", ["dash", "concat", "hls"])
async def test_a_manifest_declared_as_video_never_reads_another_file(
    tmp_path: Path, workdir: Path, tools: Tools, manifest: str
) -> None:
    secret = tmp_path / "secret" / "private.mp4"
    secret.parent.mkdir()
    make_video(tools, secret, "mp4")
    target = secret.as_posix()
    source = tmp_path / "original"
    source.write_text(
        {
            "dash": (
                '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" '
                'type="static" mediaPresentationDuration="PT1S"><Period><AdaptationSet>'
                f'<Representation id="1" bandwidth="1"><BaseURL>file:{target}</BaseURL>'
                "</Representation></AdaptationSet></Period></MPD>"
            ),
            "concat": f"ffconcat version 1.0\nfile '{target}'\n",
            "hls": f"#EXTM3U\n#EXTINF:1,\nfile:{target}\n#EXT-X-ENDLIST\n",
        }[manifest],
        encoding="utf-8",
    )

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "video/mp4", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNREADABLE
    assert not made_a_copy(workdir)


def heic_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), "blue").save(buffer, format="HEIF", exif=phone_exif().tobytes())
    return buffer.getvalue()


async def test_a_heic_claiming_huge_dimensions_fails_without_a_crash(
    tmp_path: Path, workdir: Path
) -> None:
    content = bytearray(heic_bytes())
    box = content.index(b"ispe")
    content[box + 12 : box + 16] = (20_000_000).to_bytes(4, "big")  # the height
    source = tmp_path / "original"
    source.write_bytes(bytes(content))

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "image/heic", workdir, CONFIG)

    assert error.value.reason in (SanitizeFailure.TOO_MANY_PIXELS, SanitizeFailure.UNREADABLE)


async def test_a_truncated_heic_fails_without_a_crash(tmp_path: Path, workdir: Path) -> None:
    content = heic_bytes()
    source = tmp_path / "original"
    source.write_bytes(content[: len(content) * 2 // 3])

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "image/heic", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.UNREADABLE


async def test_a_jpeg_with_malformed_exif_never_crashes(tmp_path: Path, workdir: Path) -> None:
    source = tmp_path / "original"
    broken = b"Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\xff\x01\x12\x00\x03"
    Image.new("RGB", (8, 8)).save(source, "JPEG", exif=broken)

    outcome: SafeFile | SanitizeError
    try:
        outcome = await sanitize(source, "image/jpeg", workdir, CONFIG)
    except SanitizeError as error:
        outcome = error

    if isinstance(outcome, SanitizeError):
        assert outcome.reason == SanitizeFailure.UNREADABLE
    else:
        assert dict(Image.open(outcome.path).getexif()) == {}


class HangingProcess:
    """A child process that never ends until killed."""

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.killed = False

    async def communicate(self) -> tuple[bytes, bytes]:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        assert self.returncode is not None
        return self.returncode


async def test_a_cancelled_job_kills_ffmpeg(
    tmp_path: Path, workdir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    process = HangingProcess()

    async def start(*args: object, **kwargs: object) -> HangingProcess:
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", start)
    task = asyncio.create_task(sanitize(tmp_path / "original", "video/mp4", workdir, CONFIG))
    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.killed


@pytest.mark.parametrize(
    ("kinds", "tags"),
    [
        ([("video", "h264", ())], ("location",)),
        ([("video", "h264", ("com.apple.quicktime.location.ISO6709",))], ()),
        ([("video", "h264", ()), ("video", "mjpeg", ())], ()),
        ([("video", "h264", ()), ("data", "bin_data", ())], ()),
    ],
    ids=["format-location", "stream-location", "second-video", "data-stream"],
)
def test_a_copy_with_anything_left_fails(
    kinds: list[tuple[str, str, tuple[str, ...]]], tags: tuple[str, ...]
) -> None:
    streams = [_Stream(kind, codec, attached_picture=False, tags=t) for kind, codec, t in kinds]

    with pytest.raises(SanitizeError) as error:
        _check_copy(streams, tags, CONFIG)

    assert error.value.reason == SanitizeFailure.METADATA_REMAINS


async def test_the_copy_is_checked_after_the_remux(
    tmp_path: Path, workdir: Path, tools: Tools, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Every copy keeps a handler_name tag: denying it proves the check reads the copy itself.
    source = tmp_path / "original"
    make_video(tools, source, "mp4")
    monkeypatch.setattr(sanitize_module, "_DENIED_TAGS", ("handler",))

    with pytest.raises(SanitizeError) as error:
        await sanitize(source, "video/mp4", workdir, CONFIG)

    assert error.value.reason == SanitizeFailure.METADATA_REMAINS


@pytest.mark.parametrize(
    ("raised", "reason"),
    [
        (EOFError("decoder plugin generated an error"), SanitizeFailure.UNREADABLE),
        (struct.error("unpack requires a buffer"), SanitizeFailure.UNREADABLE),
        (KeyError("tag"), SanitizeFailure.UNREADABLE),
        (RuntimeError("plugin failed"), SanitizeFailure.UNREADABLE),
        (
            RuntimeError("Memory allocation error: Security limit exceeded"),
            SanitizeFailure.TOO_MANY_PIXELS,
        ),
    ],
    ids=["eof", "struct", "key", "runtime", "security-limit"],
)
async def test_any_decoder_error_fails_the_image(
    tmp_path: Path,
    workdir: Path,
    monkeypatch: pytest.MonkeyPatch,
    raised: Exception,
    reason: SanitizeFailure,
) -> None:
    def failing_open(*args: object, **kwargs: object) -> Image.Image:
        raise raised

    monkeypatch.setattr(Image, "open", failing_open)

    with pytest.raises(SanitizeError) as error:
        await sanitize(tmp_path / "original", "image/heic", workdir, CONFIG)

    assert error.value.reason == reason
