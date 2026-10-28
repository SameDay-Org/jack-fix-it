from pydantic import BaseModel, ConfigDict, Field


class ReversePositionIn(BaseModel):
    """A device position. Strict: numbers only (no strings or booleans), finite, in range,
    and nothing but the two coordinates."""

    model_config = ConfigDict(extra="forbid", strict=True)

    lat: float = Field(ge=-90, le=90, allow_inf_nan=False, description="Latitude, degrees.")
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False, description="Longitude, degrees.")


class ReverseAddressOut(BaseModel):
    """The US street address at the position, and whether its ZIP is a served area."""

    line1: str = Field(description='"<number> <street>", or the street alone without a number.')
    city: str
    state: str = Field(description="The 2-letter state code.")
    zip_code: str = Field(description="5 digits (ZIP+4 is trimmed).")
    served: bool = Field(description="Whether an active service area covers the ZIP.")
