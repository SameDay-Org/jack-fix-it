import uuid
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ServiceAreaSeed(BaseModel):
    """One served ZIP of seed_data.json."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    region: Annotated[Name, StringConstraints(max_length=64)]
    city: Annotated[Name, StringConstraints(max_length=128)]
    # [A-Z] and [0-9], not \w or \d: Pydantic's regex also matches non-ASCII letters and digits.
    state: str = Field(pattern=r"^[A-Z]{2}$")
    zip_code: str = Field(pattern=r"^[0-9]{5}$")


class ServiceAreaSeedFile(BaseModel):
    """The whole seed file: a note for whoever edits it, then the areas, each ZIP once."""

    model_config = ConfigDict(extra="forbid")

    note: str
    service_areas: list[ServiceAreaSeed]

    @model_validator(mode="after")
    def _unique_zips(self) -> Self:
        zips = [area.zip_code for area in self.service_areas]
        duplicates = sorted({zip_code for zip_code in zips if zips.count(zip_code) > 1})
        if duplicates:
            raise ValueError(f"duplicate ZIP codes: {', '.join(duplicates)}")
        return self


class ServiceAreaOut(BaseModel):
    id: uuid.UUID
    zip_code: str
    city: str
    state: str
    region: str


class ZipOut(BaseModel):
    id: uuid.UUID
    zip_code: str


class CityOut(BaseModel):
    city: str
    state: str
    zips: list[ZipOut]


class RegionOut(BaseModel):
    region: str
    cities: list[CityOut]


# A US ZIP as people type it: 5 digits, or ZIP+4. [0-9], not \d (non-ASCII digits).
ZIP_INPUT_PATTERN = r"^[0-9]{5}(-[0-9]{4})?$"


def zip5(zip_code: str) -> str:
    """The 5-digit ZIP that service areas use: ZIP+4 is served when its ZIP is."""
    return zip_code[:5]


class ServedCheckOut(BaseModel):
    zip_code: str = Field(description="The 5-digit ZIP that was checked.")
    served: bool
