"""The demo's images, drawn here: nothing is downloaded and no real document or photo is used.

Documents are images on purpose (JPEG): the panel opens a pro's document in a new tab, and the
headless browser that records the web tour downloads a PDF instead of showing it
(handoffs/web-tour-notes.md). Every picture says it is a demo.
"""

import io
from typing import Final

from PIL import Image, ImageDraw, ImageFont

JPEG: Final = "image/jpeg"
_INK: Final = (17, 31, 48)
_PAPER: Final = (247, 248, 250)
_ACCENT: Final = (98, 183, 47)
_MUTED: Final = (120, 130, 145)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def _jpeg(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, "JPEG", quality=88)
    return out.getvalue()


def document(title: str, holder: str, number: str, valid_until: str) -> bytes:
    """A card that reads as a scanned document: its kind, the holder's first name, a made-up
    number and a validity date, under a DEMO banner."""
    image = Image.new("RGB", (1200, 760), _PAPER)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1200, 120), fill=_INK)
    draw.text((48, 34), title.upper(), font=_font(52), fill=_PAPER)
    draw.rectangle((48, 180, 348, 560), outline=_MUTED, width=4)
    draw.ellipse((128, 230, 268, 370), fill=_MUTED)
    draw.rectangle((98, 390, 298, 540), fill=_MUTED)
    rows = (("Name", holder), ("Number", number), ("Valid until", valid_until))
    for index, (label, value) in enumerate(rows):
        top = 190 + index * 124
        draw.text((410, top), label.upper(), font=_font(26), fill=_MUTED)
        draw.text((410, top + 36), value, font=_font(54), fill=_INK)
    draw.rectangle((0, 640, 1200, 760), fill=_ACCENT)
    draw.text(
        (48, 672),
        "DEMO DOCUMENT - not a real document - Jack Fix It demo data",
        font=_font(34),
        fill=_INK,
    )
    return _jpeg(image)


def photo(caption: str, tone: tuple[int, int, int]) -> bytes:
    """A flat scene (a wall, a floor, a shape in `tone`) with its caption: stands for a
    request, job or problem photo."""
    image = Image.new("RGB", (1280, 960), (226, 222, 214))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 640, 1280, 960), fill=(172, 150, 128))
    draw.rectangle((330, 210, 950, 640), fill=tone)
    draw.rectangle((330, 210, 950, 640), outline=_INK, width=6)
    draw.line((640, 210, 640, 640), fill=_INK, width=4)
    draw.ellipse((590, 410, 620, 440), fill=_INK)
    draw.ellipse((660, 410, 690, 440), fill=_INK)
    draw.rectangle((0, 0, 1280, 96), fill=_INK)
    draw.text((40, 26), caption, font=_font(40), fill=_PAPER)
    draw.text((40, 900), "Demo photo - Jack Fix It demo data", font=_font(28), fill=_INK)
    return _jpeg(image)


def avatar(initials: str, tone: tuple[int, int, int]) -> bytes:
    """A profile picture: initials on a colour."""
    image = Image.new("RGB", (640, 640), tone)
    draw = ImageDraw.Draw(image)
    font = _font(260)
    left, top, right, bottom = draw.textbbox((0, 0), initials, font=font)
    position = ((640 - (right - left)) / 2 - left, (640 - (bottom - top)) / 2 - top)
    draw.text(position, initials, font=font, fill=_PAPER)
    return _jpeg(image)
