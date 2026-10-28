import unicodedata
import uuid
from typing import Annotated, Final, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.redaction import INVISIBLE_FILLERS, redact_contacts

# Postgres text cannot store U+0000: refuse it here (422), not in the database (500).
NO_NUL = r"^[^\x00]*$"
Line = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255, pattern=NO_NUL)
]
Line2 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=255, pattern=NO_NUL)]
City = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128, pattern=NO_NUL)
]
# [A-Z] and [0-9], not \w or \d: Pydantic's regex also matches non-ASCII letters and digits.
State = Annotated[str, Field(pattern=r"^[A-Z]{2}$", description="Two uppercase letters, e.g. FL.")]
ZipCode = Annotated[str, Field(pattern=r"^[0-9]{5}(-[0-9]{4})?$", description="5 digits or ZIP+4.")]


class AddressIn(BaseModel):
    """A US service address as the customer types it. Geocoding (lat/lng) comes later."""

    model_config = ConfigDict(extra="forbid")

    line1: Line
    line2: Line2 | None = None
    city: City
    state: State
    zip_code: ZipCode


class AddressArea(BaseModel):
    """Where an address is, coarsely: what someone who must not see the street may see. Never
    text the customer typed: the 5-digit ZIP, and the city of its service area (GeoNames names,
    #9), or None when the ZIP has no active area any more."""

    zip_code: str
    city: str | None


class AddressOut(BaseModel):
    line1: str
    line2: str | None
    city: str
    state: str
    zip_code: str


# Saved addresses (D8.2, #214): the customer's address book.

LABEL_MAX_LENGTH: Final = 30
_LINE_BREAKS: Final = frozenset("\N{LINE SEPARATOR}\N{PARAGRAPH SEPARATOR}")
# The column is Numeric(9, 6): a coordinate is kept to six decimals (about 11 cm).
COORDINATE_PLACES: Final = 6


def _canonical(value: object) -> object:
    """The label as stored: composed (NFC, so "Café" typed with a combining accent equals
    "Café"), without invisible fillers (app.redaction.INVISIBLE_FILLERS: letters and marks
    the control check misses, #224 review), trimmed, each run of spaces one. So "Home" and
    "Home\u034f" are the same label, and "\u3164" or combining marks alone are blank. Control,
    format and line-break characters (NUL, tab, newline, zero-width space...) are refused, not
    collapsed: the rule of a person's name (users.names), since the BDC panel will show labels
    too."""
    if not isinstance(value, str):
        return value
    value = unicodedata.normalize("NFC", value)
    value = "".join(char for char in value if char not in INVISIBLE_FILLERS)
    if all(unicodedata.category(char).startswith("M") or char.isspace() for char in value):
        return ""  # nothing visible to attach to: blank
    if any(unicodedata.category(char)[0] == "C" or char in _LINE_BREAKS for char in value):
        raise ValueError("a label has no control, format or line-break characters")
    return " ".join(value.split())


def _no_contacts(value: str) -> str:
    """Refuses a label in which app.redaction masks a way to reach someone (an email, a phone,
    a URL, a handle, or one spelled out): a label is the owner's own text, but staff will read
    it. A street or a unit in the label ("Apt 4B") is fine: it names the address stored next
    to it."""
    if redact_contacts(value, addresses=False).redacted:
        raise ValueError("a label has no contact details")
    return value


AddressLabel = Annotated[
    str,
    BeforeValidator(_canonical),
    StringConstraints(min_length=1, max_length=LABEL_MAX_LENGTH),
    AfterValidator(_no_contacts),
    Field(description='The customer\'s own name for it, e.g. "Home" or "Casa 2".'),
]
Latitude = Annotated[
    float, Field(ge=-90, le=90, description="Decimal degrees, kept to six decimals.")
]
Longitude = Annotated[
    float, Field(ge=-180, le=180, description="Decimal degrees, kept to six decimals.")
]
# Fields a saved address always has: a PATCH may leave them out but never set them to null.
_REQUIRED_FIELDS: Final = ("label", "line1", "city", "state", "zip_code")


def _coordinates_together(lat: float | None, lng: float | None) -> None:
    if (lat is None) != (lng is None):
        raise ValueError("lat and lng come together, both set or both empty")


class SavedAddressIn(AddressIn):
    """A saved address: the address fields, its label, optional coordinates (both or neither)
    and whether it becomes the default. The customer's first address is the default anyway."""

    label: AddressLabel
    lat: Latitude | None = None
    lng: Longitude | None = None
    is_default: bool = False

    @model_validator(mode="after")
    def _check_coordinates(self) -> Self:
        _coordinates_together(self.lat, self.lng)
        return self


class SavedAddressPatch(BaseModel):
    """Any subset of the fields. A field left out stays as it is. `line2` sent as null is
    cleared; so are `lat` and `lng`, sent as null together. `is_default` can only be true here:
    the default moves by making another address the default, never by unsetting one."""

    model_config = ConfigDict(extra="forbid")

    label: AddressLabel | None = None
    line1: Line | None = None
    line2: Line2 | None = None
    city: City | None = None
    state: State | None = None
    zip_code: ZipCode | None = None
    lat: Latitude | None = None
    lng: Longitude | None = None
    is_default: Literal[True] | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        sent = self.model_fields_set
        if any(name in sent and getattr(self, name) is None for name in _REQUIRED_FIELDS):
            raise ValueError("label, line1, city, state and zip_code cannot be null")
        if ("lat" in sent) != ("lng" in sent):
            raise ValueError("lat and lng come together, both sent or neither")
        _coordinates_together(self.lat, self.lng)
        return self


class SavedAddressOut(BaseModel):
    id: uuid.UUID
    label: str
    line1: str
    line2: str | None
    city: str
    state: str
    zip_code: str
    lat: float | None
    lng: float | None
    is_default: bool
    served: bool = Field(
        description="True when the ZIP has an active service area; otherwise the app offers "
        "the waitlist."
    )


class SavedAddressList(BaseModel):
    """The caller's saved addresses: the default first, then the oldest first."""

    items: list[SavedAddressOut]
