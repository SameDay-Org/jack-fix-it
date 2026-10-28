"""Reverse geocoding for the customer's address book (D8.2, #215).

The position comes from the device and is PII, like the address it resolves to: neither is
stored, and the logs carry the user id and the outcome only.
"""

import logging
import uuid

from app.errors import AppError
from app.integrations import geocoding
from app.modules.geo.schemas import ReverseAddressOut, ReversePositionIn
from app.modules.service_areas.service import ServiceAreaService

logger = logging.getLogger(__name__)


class LocationNotResolvedError(AppError):
    status_code = 404
    code = "location_not_resolved"
    message = "No street address was found at this location."


class GeocodingUnavailableError(AppError):
    status_code = 503
    code = "geocoding_unavailable"
    message = "Location lookup is unavailable right now. Try again later."


class GeoService:
    def __init__(
        self, geocoder: geocoding.ReverseGeocoder, service_areas: ServiceAreaService
    ) -> None:
        self._geocoder = geocoder
        self._service_areas = service_areas

    async def reverse(self, user_id: uuid.UUID, position: ReversePositionIn) -> ReverseAddressOut:
        """The address at the position and whether its ZIP is served."""
        extra = {"user_id": str(user_id)}
        try:
            address = await self._geocoder.reverse(position.lat, position.lng)
        except geocoding.GeocodingUnavailableError:
            logger.error("geo_reverse_unavailable", extra=extra)
            raise GeocodingUnavailableError from None
        if address is None:
            logger.info("geo_reverse_unresolved", extra=extra)
            raise LocationNotResolvedError
        served = await self._service_areas.is_served(address.zip_code)
        logger.info("geo_reverse_resolved", extra={**extra, "served": served})
        return ReverseAddressOut(
            line1=address.line1,
            city=address.city,
            state=address.state,
            zip_code=address.zip_code,
            served=served,
        )
