from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# Postgres text cannot store U+0000: refuse it here (422), not in the database (500).
NO_NUL = r"^[^\x00]*$"
Line = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255, pattern=NO_NUL)
]


class AddressIn(BaseModel):
    """A US service address as the customer types it. Geocoding (lat/lng) comes later."""

    model_config = ConfigDict(extra="forbid")

    line1: Line
    line2: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=255, pattern=NO_NUL)]
        | None
    ) = None
    city: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=128, pattern=NO_NUL),
    ]
    # [A-Z] and [0-9], not \w or \d: Pydantic's regex also matches non-ASCII letters and digits.
    state: str = Field(pattern=r"^[A-Z]{2}$", description="Two uppercase letters, e.g. FL.")
    zip_code: str = Field(pattern=r"^[0-9]{5}(-[0-9]{4})?$", description="5 digits or ZIP+4.")


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
