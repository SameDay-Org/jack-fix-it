"""Privacy-safe copies of request photos and videos (#173): the file transforms only.

A phone's photo or video can carry where and when it was taken (EXIF GPS, XMP, QuickTime
location and creation tags). The copy keeps the picture and drops the rest:

- Images (Pillow, pillow-heif): decoded as their declared type only, with a pixel cap (a larger
  image is a decompression bomb and fails), turned upright (EXIF orientation), then re-encoded
  from the pixels alone: no EXIF, XMP, IPTC or text chunks; an ICC profile is kept. JPEG and
  HEIC become JPEG (a pro's phone may not show HEIC), PNG stays PNG, WebP stays WebP. Any
  decoder failure fails the file.
- Videos (ffprobe, then ffmpeg): read only as MP4/QuickTime, from the local file only (no
  playlist, manifest or network input). ffprobe first: the first real video track (not cover
  art) and the first audio track must use an allowed codec (settings), since a remux copies
  each stream as it is and an image codec (MJPEG, PNG) keeps its EXIF. Then a remux, never a
  re-encode, of those two tracks only (no cover art, data or subtitle streams), with every tag
  and chapter dropped, and every SEI unit dropped from the video bitstream: a drone or a dashcam
  can write its GPS there, in each frame (#182). Then ffprobe again: the copy must hold those
  tracks only, no location, date, GPS or device tag, and an HEVC decoder configuration (which
  the remux copies as it is) with no SEI but the HDR and colour ones. Both run without a shell,
  with a timeout, and are killed when the job stops; their output names paths and is never
  logged. Only the exit code is reported.

Nothing here touches the storage or the database (app/modules/requests/media_copies.py does),
and nothing logs: the caller logs the media id and the reason code.
"""

import asyncio
import json
import re
import subprocess
import warnings
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from functools import partial
from pathlib import Path
from typing import Final

import pillow_heif
from PIL import Image, ImageOps

from app.config import Settings

pillow_heif.register_heif_opener()


class SanitizeFailure(StrEnum):
    """Why a file has no safe copy: the reason code that is logged."""

    UNSUPPORTED = "unsupported_type"  # the key's type is not a photo or video type
    UNREADABLE = "unreadable"  # it does not decode as its declared type
    TOO_MANY_PIXELS = "too_many_pixels"  # a decompression bomb
    UNSUPPORTED_CODEC = "unsupported_codec"  # a video or audio codec outside the allowlists
    METADATA_REMAINS = "metadata_remains"  # the copy still holds a location or date tag
    HIDDEN_FRAMES = "hidden_frames"  # an edit list hides trimmed frames that a copy would keep
    FFMPEG_FAILED = "ffmpeg_failed"  # ffmpeg exited non-zero
    TIMEOUT = "timeout"  # ffmpeg or ffprobe ran past the timeout (retried)
    FFMPEG_UNAVAILABLE = "ffmpeg_unavailable"  # a binary could not be started (retried)
    MISSING = "missing_object"  # no original in the storage (retried)
    STORAGE = "storage_unavailable"  # the storage failed (retried)
    INTERNAL = "internal"  # an unexpected error (retried, then failed)


class SanitizeError(Exception):
    """The file cannot be made safe, and trying again will not change that."""

    def __init__(self, reason: SanitizeFailure, exit_code: int | None = None) -> None:
        super().__init__(reason.value)
        self.reason = reason
        self.exit_code = exit_code


class SanitizeRetryableError(Exception):
    """The copy failed for a reason that may pass (a timeout, ffmpeg missing for now)."""

    def __init__(self, reason: SanitizeFailure) -> None:
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class SanitizeConfig:
    max_image_pixels: int
    jpeg_quality: int
    ffmpeg_path: str
    timeout_seconds: float
    ffprobe_path: str = "ffprobe"
    video_codecs: frozenset[str] = frozenset({"h264", "hevc"})
    audio_codecs: frozenset[str] = frozenset({"aac", "mp3", "opus"})

    @classmethod
    def from_settings(cls, settings: Settings) -> "SanitizeConfig":
        return cls(
            max_image_pixels=settings.media_max_image_pixels,
            jpeg_quality=settings.media_jpeg_quality,
            ffmpeg_path=settings.ffmpeg_path,
            timeout_seconds=settings.media_sanitize_timeout_seconds,
            ffprobe_path=settings.ffprobe_path,
            video_codecs=frozenset(settings.media_video_codecs),
            audio_codecs=frozenset(settings.media_audio_codecs),
        )


@dataclass(frozen=True)
class SafeFile:
    path: Path
    content_type: str
    extension: str


# Runs an image transform in a thread; by default asyncio.to_thread. The worker passes its own,
# which bounds it in time (app/modules/requests/media_copies.py).
InThread = Callable[[Callable[[], SafeFile]], Awaitable[SafeFile]]


@dataclass(frozen=True)
class _ImageOutput:
    pillow_format: str  # the only format the original may decode as
    content_type: str
    extension: str
    save_format: str


IMAGE_OUTPUTS: Final[dict[str, _ImageOutput]] = {
    "image/jpeg": _ImageOutput("JPEG", "image/jpeg", ".jpg", "JPEG"),
    "image/heic": _ImageOutput("HEIF", "image/jpeg", ".jpg", "JPEG"),
    "image/png": _ImageOutput("PNG", "image/png", ".png", "PNG"),
    "image/webp": _ImageOutput("WEBP", "image/webp", ".webp", "WEBP"),
}
# Content type -> the extension and ffmpeg's muxer for the copy. Both are read with the mov
# demuxer, which reads MP4 too.
VIDEO_OUTPUTS: Final[dict[str, tuple[str, str]]] = {
    "video/mp4": (".mp4", "mp4"),
    "video/quicktime": (".mov", "mov"),
}
VIDEO_EXTENSIONS: Final[dict[str, str]] = {kind: out[0] for kind, out in VIDEO_OUTPUTS.items()}
# The modes each output keeps as they are; any other is converted.
_KEPT_MODES: Final[dict[str, tuple[str, ...]]] = {
    "JPEG": ("RGB", "L"),
    "PNG": ("RGBA", "RGB", "LA", "L", "I;16"),
    "WEBP": ("RGBA", "RGB"),
}
# Read the input as MP4/QuickTime, from a local file only: never a playlist, a manifest or a
# network URL that a crafted file could point to.
_INPUT_OPTIONS: Final = ("-protocol_whitelist", "file", "-f", "mov")
# Discarded audio packets an encoder's priming accounts for (AAC: about 2,112 samples).
_AUDIO_PRIMING_PACKETS: Final = 3
# Audio the mov muxer cannot hold: such a file is written as MP4 (which can).
_NOT_IN_MOV: Final = frozenset({"opus"})
# A tag the copy may not hold, by any part of its name.
_DENIED_TAGS: Final = ("location", "xyz", "gps", "creation", "date", "make", "model")
# The bitstream filter that drops every SEI unit from each packet of the copy, by video codec
# (#182): a drone or a dashcam can write its GPS in a user data SEI of every frame, which a
# remux would copy. filter_units drops whole units, so the other SEI messages go too: HEVC loses
# its HDR mastering and light level SEI (players fall back to their default tone mapping), as
# #182 accepts; H.264 loses its timing and recovery point SEI, and every frame still plays. A
# video codec without a filter here is not copied (UNSUPPORTED_CODEC), whatever
# MEDIA_VIDEO_CODECS allows.
_SEI_FILTERS: Final[dict[str, str]] = {
    "h264": "filter_units=remove_types=6",
    "hevc": "filter_units=remove_types=39|40",
}
# The only SEI messages an HEVC decoder configuration of a copy may keep (#182), by payload
# type: the HDR and colour ones (mastering display 137, content light level 144, alternative
# transfer 147, ambient viewing 148, content colour volume 149). Any other fails the copy: user
# data (registered 4, unregistered 5), a scalable nesting (133) that can carry it, a reserved one.
_CONFIGURATION_SEI: Final = frozenset({137, 144, 147, 148, 149})
_HEVC_SEI_NAL_TYPES: Final = frozenset({39, 40})  # prefix and suffix SEI
# The largest HEVC decoder configuration of a copy that is read. A phone's is parameter sets, a
# few hundred bytes (x265's, with its settings, 2.4 KB); a larger one fails the copy unread, so a
# crafted file cannot make the worker hold a dump of it (four times its size, from ffprobe).
_HEVC_CONFIGURATION_MAX_BYTES: Final = 65_536
# One line of ffprobe's hex dump: an offset, then up to 16 bytes in groups of two.
_HEX_DUMP_LINE: Final = re.compile(r"[0-9a-f]{8}: ((?:[0-9a-f]{2,4} ?){1,8})(?: |$)")


async def sanitize(
    source: Path,
    content_type: str,
    workdir: Path,
    config: SanitizeConfig,
    *,
    in_thread: InThread | None = None,
) -> SafeFile:
    """The safe copy of `source`, written into `workdir`. SanitizeError when the file can never
    be made safe, SanitizeRetryableError when a later try may succeed."""
    if content_type in IMAGE_OUTPUTS:
        work = partial(sanitize_image, source, content_type, workdir, config)
        return await (asyncio.to_thread(work) if in_thread is None else in_thread(work))
    if content_type in VIDEO_OUTPUTS:
        return await sanitize_video(source, content_type, workdir, config)
    raise SanitizeError(SanitizeFailure.UNSUPPORTED)


def sanitize_image(
    source: Path, content_type: str, workdir: Path, config: SanitizeConfig
) -> SafeFile:
    output = IMAGE_OUTPUTS[content_type]
    # Pillow's own bomb check reads this module setting; the explicit checks also catch the
    # range between the limit and twice it, where Pillow only warns.
    Image.MAX_IMAGE_PIXELS = config.max_image_pixels
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source, formats=[output.pillow_format]) as image:
                _check_pixels(image, config)
                image.load()
                _check_pixels(image, config)  # a HEIF's size can change while it decodes
                icc_profile = image.info.get("icc_profile")
                upright = ImageOps.exif_transpose(image)
    except SanitizeError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise SanitizeError(SanitizeFailure.TOO_MANY_PIXELS) from None
    except RuntimeError as error:  # libheif refuses a huge image with a "security limit"
        too_large = "security limit" in str(error).lower()
        reason = SanitizeFailure.TOO_MANY_PIXELS if too_large else SanitizeFailure.UNREADABLE
        raise SanitizeError(reason) from None
    except Exception:  # noqa: BLE001 - any decoder failure (EOFError, struct.error...) means unreadable
        raise SanitizeError(SanitizeFailure.UNREADABLE) from None
    clean = _pixels_only(upright, output.save_format)
    target = workdir / f"safe{output.extension}"
    options: dict[str, object] = {}
    if isinstance(icc_profile, bytes) and icc_profile:
        options["icc_profile"] = icc_profile
    if output.save_format in ("JPEG", "WEBP"):
        options["quality"] = config.jpeg_quality
    clean.save(target, output.save_format, **options)
    return SafeFile(target, output.content_type, output.extension)


def _check_pixels(image: Image.Image, config: SanitizeConfig) -> None:
    if image.width * image.height > config.max_image_pixels:
        raise SanitizeError(SanitizeFailure.TOO_MANY_PIXELS)


def _pixels_only(image: Image.Image, save_format: str) -> Image.Image:
    """A new image holding `image`'s pixels and nothing else: an empty `info`, so no EXIF, XMP
    or text chunk can be carried into the saved file."""
    if image.mode not in _KEPT_MODES[save_format]:
        # JPEG has no alpha; PNG and WebP keep it when the original has any (a palette's
        # transparency too).
        alpha = "A" in image.getbands() or "transparency" in image.info
        image = image.convert("RGBA" if alpha and save_format != "JPEG" else "RGB")
    clean = Image.new(image.mode, image.size)
    clean.paste(image)
    return clean


@dataclass(frozen=True)
class _Stream:
    kind: str  # video, audio, data, subtitle...
    codec: str
    attached_picture: bool
    tags: tuple[str, ...]  # tag names only
    configuration_bytes: int = 0  # the size of the decoder configuration (hvcC, avcC)


async def sanitize_video(
    source: Path, content_type: str, workdir: Path, config: SanitizeConfig
) -> SafeFile:
    streams, _ = await _probe(source, config)
    video = next((s for s in streams if s.kind == "video" and not s.attached_picture), None)
    audio = next((s for s in streams if s.kind == "audio"), None)
    if video is None:
        raise SanitizeError(SanitizeFailure.UNREADABLE)
    sei_filter = _SEI_FILTERS.get(video.codec)
    if (
        video.codec not in config.video_codecs
        or sei_filter is None
        or (audio is not None and audio.codec not in config.audio_codecs)
    ):
        raise SanitizeError(SanitizeFailure.UNSUPPORTED_CODEC)
    if content_type == "video/quicktime" and audio is not None and audio.codec in _NOT_IN_MOV:
        content_type = "video/mp4"  # Opus fits MP4 only
    extension, muxer = VIDEO_OUTPUTS[content_type]
    target = workdir / f"safe{extension}"
    arguments = [
        "-nostdin", "-y", *_INPUT_OPTIONS, "-i", str(source),
        # The first real video track (capital V: never cover art) and the first audio track.
        "-map", "0:V:0", "-map", "0:a:0?", "-dn", "-sn",
        "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1",
        "-c", "copy", "-bsf:v", sei_filter, "-movflags", "+faststart", "-f", muxer,
        str(target),
    ]  # fmt: skip
    exit_code, _ = await _run(config.ffmpeg_path, arguments, config.timeout_seconds)
    if exit_code != 0:
        raise SanitizeError(SanitizeFailure.FFMPEG_FAILED, exit_code=exit_code)
    copied, format_tags = await _probe(target, config)
    _check_copy(copied, format_tags, config)
    if await _configuration_is_unsafe(target, copied, config):
        raise SanitizeError(SanitizeFailure.METADATA_REMAINS)
    if await _has_hidden_frames(target, copied, config):
        raise SanitizeError(SanitizeFailure.HIDDEN_FRAMES)
    return SafeFile(target, content_type, extension)


async def _has_hidden_frames(path: Path, streams: list[_Stream], config: SanitizeConfig) -> bool:
    """True when an edit list hides content the copy still holds: packets flagged D (discard),
    what a customer trimmed off in their phone's editor. Any hidden video packet counts; a few
    hidden audio packets are an encoder's priming (AAC starts with one or two), more are not."""
    arguments = [
        "-v", "quiet", *_INPUT_OPTIONS,
        "-show_entries", "packet=stream_index,flags", "-of", "csv=p=0",
        str(path),
    ]  # fmt: skip
    exit_code, output = await _run(
        config.ffprobe_path, arguments, config.timeout_seconds, capture=True
    )
    if exit_code != 0:
        raise SanitizeError(SanitizeFailure.UNREADABLE, exit_code=exit_code)
    hidden = {"video": 0, "audio": 0}
    for line in output.decode("ascii", "replace").splitlines():
        index, _, flags = line.partition(",")
        if "D" not in flags or not index.isdigit() or int(index) >= len(streams):
            continue
        kind = streams[int(index)].kind
        hidden[kind] = hidden.get(kind, 0) + 1
    return hidden["video"] > 0 or hidden["audio"] > _AUDIO_PRIMING_PACKETS


def _check_copy(
    streams: list[_Stream], format_tags: tuple[str, ...], config: SanitizeConfig
) -> None:
    """The copy holds one allowed video track, at most one allowed audio track, nothing else,
    and no location, date, GPS or device tag."""
    kinds = sorted(stream.kind for stream in streams)
    if kinds not in (["video"], ["audio", "video"]):
        raise SanitizeError(SanitizeFailure.METADATA_REMAINS)
    for stream in streams:
        allowed = config.video_codecs if stream.kind == "video" else config.audio_codecs
        if stream.attached_picture or stream.codec not in allowed:
            raise SanitizeError(SanitizeFailure.METADATA_REMAINS)
    tags = (*format_tags, *(tag for stream in streams for tag in stream.tags))
    if any(denied in tag.lower() for tag in tags for denied in _DENIED_TAGS):
        raise SanitizeError(SanitizeFailure.METADATA_REMAINS)


async def _probe(path: Path, config: SanitizeConfig) -> tuple[list[_Stream], tuple[str, ...]]:
    """The file's streams and its container tag names, read by ffprobe as MP4/QuickTime only.
    SanitizeError when it does not read as one."""
    arguments = [
        "-v", "quiet", *_INPUT_OPTIONS,
        "-show_entries", "stream=codec_type,codec_name,extradata_size"
        ":stream_disposition=attached_pic:stream_tags:format_tags",
        "-of", "json", str(path),
    ]  # fmt: skip
    exit_code, output = await _run(
        config.ffprobe_path, arguments, config.timeout_seconds, capture=True
    )
    if exit_code != 0:
        raise SanitizeError(SanitizeFailure.UNREADABLE, exit_code=exit_code)
    try:
        probed = json.loads(output)
        streams = [
            _Stream(
                kind=str(stream.get("codec_type", "")),
                codec=str(stream.get("codec_name", "")),
                attached_picture=bool(stream.get("disposition", {}).get("attached_pic")),
                tags=tuple(str(tag) for tag in stream.get("tags", {})),
                configuration_bytes=int(stream.get("extradata_size", 0)),
            )
            for stream in probed.get("streams", [])
        ]
        format_tags = tuple(str(tag) for tag in probed.get("format", {}).get("tags", {}))
    except (ValueError, AttributeError, TypeError):
        raise SanitizeError(SanitizeFailure.UNREADABLE) from None
    return streams, format_tags


async def _configuration_is_unsafe(
    path: Path, streams: list[_Stream], config: SanitizeConfig
) -> bool:
    """True when the copy's HEVC decoder configuration (hvcC) holds an SEI message that is not
    an HDR or colour one, is larger than _HEVC_CONFIGURATION_MAX_BYTES, or cannot be read (#182).

    The SEI filter reaches each packet but not the decoder configuration, which the remux copies
    as it is, and an encoder can put SEI there too (x265 writes its settings in one): the copy is
    refused then, never served with it. Only the copy's one video stream is read, never the
    original's streams. H.264's configuration (avcC) holds parameter sets only."""
    video = next(stream for stream in streams if stream.kind == "video")
    if video.codec != "hevc":
        return False
    # A size of 0 is also what an ffprobe that does not print it gives: read the record then
    # too, and an empty one is refused (hevc_configuration_is_unsafe).
    if video.configuration_bytes > _HEVC_CONFIGURATION_MAX_BYTES:
        return True
    arguments = [
        "-v", "quiet", *_INPUT_OPTIONS, "-select_streams", "v:0",
        "-show_data", "-show_entries", "stream=extradata",  # the record, as a hex dump
        "-of", "json", str(path),
    ]  # fmt: skip
    exit_code, output = await _run(
        config.ffprobe_path, arguments, config.timeout_seconds, capture=True
    )
    if exit_code != 0:
        raise SanitizeError(SanitizeFailure.UNREADABLE, exit_code=exit_code)
    try:
        [stream] = json.loads(output)["streams"]
        record = _hex_dump_bytes(str(stream["extradata"]))
    except (ValueError, KeyError, TypeError):
        raise SanitizeError(SanitizeFailure.UNREADABLE) from None
    if len(record) > _HEVC_CONFIGURATION_MAX_BYTES:
        return True
    return hevc_configuration_is_unsafe(record)


def _hex_dump_bytes(dump: str) -> bytes:
    """The bytes of ffprobe's hex dump (offset, hex groups, then the printable characters).
    ValueError on a line of another shape: the copy then reads as unreadable, never as clean."""
    data = bytearray()
    for line in dump.splitlines():
        if not line.strip():
            continue
        match = _HEX_DUMP_LINE.match(line)
        if match is None:
            raise ValueError("not an ffprobe hex dump line")
        data += bytes.fromhex(match.group(1).replace(" ", ""))
    return bytes(data)


def hevc_configuration_is_unsafe(record: bytes) -> bool:
    """True when an HEVC decoder configuration record (ISO/IEC 14496-15 hvcC) holds an SEI
    message outside _CONFIGURATION_SEI (#182), or cannot be read as one, empty included (closed:
    refused, never passed)."""
    if not record:
        return True
    try:
        if record[0] != 1:  # configurationVersion
            return True
        arrays, position = record[22], 23
        for _ in range(arrays):
            count = int.from_bytes(record[position + 1 : position + 3])
            position += 3
            for _ in range(count):
                length = int.from_bytes(record[position : position + 2])
                unit = record[position + 2 : position + 2 + length]
                if len(unit) != length or length < 2:
                    return True
                position += 2 + length
                # Each unit's own header says what it is, whatever array it sits in.
                if (unit[0] >> 1) & 0x3F in _HEVC_SEI_NAL_TYPES and _sei_is_unsafe(unit):
                    return True
        return position != len(record)
    except IndexError:
        return True


def _sei_is_unsafe(unit: bytes) -> bool:
    """True when the HEVC SEI unit (2-byte header, then the escaped payload) has a message
    outside _CONFIGURATION_SEI. IndexError when its messages run past the end."""
    rbsp = unit[2:].replace(b"\x00\x00\x03", b"\x00\x00")  # emulation prevention bytes
    position = 0
    while position < len(rbsp) and rbsp[position:] != b"\x80":  # the trailing bits end it
        payload_type, position = _sei_number(rbsp, position)
        size, position = _sei_number(rbsp, position)
        if payload_type not in _CONFIGURATION_SEI:
            return True
        position += size
        if position > len(rbsp):
            raise IndexError("SEI message past the end of the unit")
    return False


def _sei_number(rbsp: bytes, position: int) -> tuple[int, int]:
    """An SEI payload type or size: 255 per 0xFF byte, plus the first other byte."""
    value = 0
    while rbsp[position] == 0xFF:
        value += 255
        position += 1
    return value + rbsp[position], position + 1


async def _run(
    program: str, arguments: list[str], timeout_seconds: float, *, capture: bool = False
) -> tuple[int, bytes]:
    """Runs `program` without a shell; its exit code and, when `capture`, its standard output.
    Its standard error is discarded (it names paths). The process is killed on a timeout and
    when the job is cancelled."""
    try:
        process = await asyncio.create_subprocess_exec(
            program,
            *arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        raise SanitizeRetryableError(SanitizeFailure.FFMPEG_UNAVAILABLE) from None
    try:
        async with asyncio.timeout(timeout_seconds):
            output, _ = await process.communicate()
    except TimeoutError:
        raise SanitizeRetryableError(SanitizeFailure.TIMEOUT) from None
    finally:
        if process.returncode is None:  # a timeout, or the job was cancelled
            process.kill()
            await process.wait()
    exit_code = process.returncode
    return (-1 if exit_code is None else exit_code), output or b""
