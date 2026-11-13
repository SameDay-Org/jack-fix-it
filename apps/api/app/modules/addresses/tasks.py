"""Worker side of geocode on save (#384): the ARQ task POST /v1/requests queues."""

import uuid
from typing import Any

from app.config import Settings
from app.integrations.mapbox import AddressGeocoder
from app.modules.addresses.geocode import AddressGeocodeService


async def geocode_address(ctx: dict[str, Any], address_id: str) -> str:
    """ARQ task: gives one address its point (addresses/geocode.py) and returns the outcome.
    The switch is read here too: a job queued before GEOCODE_ON_SAVE was turned off asks
    Mapbox nothing. A database error fails the job (ARQ logs it, with the id only); the
    address stays without a point and its route places it by itself."""
    settings: Settings = ctx["settings"]
    geocoder: AddressGeocoder = ctx["address_geocoder"]
    async with ctx["session_factory"]() as session:
        service = AddressGeocodeService(session, geocoder, enabled=settings.geocode_on_save)
        outcome = await service.geocode(uuid.UUID(address_id))
    return outcome.value
