"""Reverse geocoding through the Google Geocoding API (D8.2, #215).

The customer's device position becomes the parts of a US street address, for the "use my
location" button of the address book. Calls go to the Geocoding web service with httpx (async,
timeout from settings); nothing is stored or cached.

A position and an address are PII, and the request URL carries both the position and the API
key in its query string. So nothing here logs a coordinate, an address part, the key, the URL
or a response body, and no exception leaves this module with any of them in its text (httpx's
own exceptions name the URL; they are logged by type only and never chained). The `httpx`
logger, which names every request URL at INFO, and `httpcore`, which names the host at DEBUG,
run at WARNING (app/observability.py), and Sentry's HTTP breadcrumbs lose their query string
in `before_breadcrumb`.
"""

import logging
import re
from dataclasses import dataclass
from typing import Final, Protocol

import httpx
from starlette.requests import Request

from app.config import Settings

logger = logging.getLogger(__name__)

GEOCODE_URL: Final = "https://maps.googleapis.com/maps/api/geocode/json"
LANGUAGE: Final = "en"
# Only results that name a street: a bare locality or postal-code polygon is of no use here.
RESULT_TYPES: Final = "street_address|premise|route"
COUNTRY: Final = "US"
STATUS_OK: Final = "OK"
STATUS_ZERO_RESULTS: Final = "ZERO_RESULTS"
# https://developers.google.com/maps/documentation/geocoding/requests-geocoding#StatusCodes
# Every status but OK and ZERO_RESULTS means the provider refused or failed, not "no address".
UNAVAILABLE_STATUSES: Final = frozenset(
    {"REQUEST_DENIED", "OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT", "INVALID_REQUEST", "UNKNOWN_ERROR"}
)
ZIP5: Final = re.compile(r"^[0-9]{5}")


class GeocodingUnavailableError(Exception):
    """No key is configured, or Google could not be reached or did not behave as expected."""


@dataclass(frozen=True)
class ResolvedAddress:
    """The parts of a US street address: `line1` is "number route" or the route alone."""

    line1: str
    city: str
    state: str
    zip_code: str


class ReverseGeocoder(Protocol):
    async def reverse(self, lat: float, lng: float) -> ResolvedAddress | None:
        """The US street address at the position, or None when there is no usable result."""
        ...


class UnconfiguredReverseGeocoder:
    """Stands in while GOOGLE_MAPS_API_KEY is unset (#14): every lookup is unavailable."""

    async def reverse(self, lat: float, lng: float) -> ResolvedAddress | None:
        # A known state until #14, not an incident: WARNING, so Sentry sees no event.
        logger.warning("geocoding_not_configured")
        raise GeocodingUnavailableError


class GoogleReverseGeocoder:
    def __init__(
        self,
        *,
        api_key: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout_seconds
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> "GoogleReverseGeocoder":
        if settings.google_maps_api_key is None:
            raise RuntimeError("GOOGLE_MAPS_API_KEY is not set; reverse geocoding is unavailable")
        return cls(
            api_key=settings.google_maps_api_key.get_secret_value(),
            timeout_seconds=settings.geocoding_timeout_seconds,
        )

    async def reverse(self, lat: float, lng: float) -> ResolvedAddress | None:
        params = {
            "latlng": f"{lat},{lng}",
            "key": self._api_key,
            "language": LANGUAGE,
            "result_type": RESULT_TYPES,
        }
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport
            ) as client:
                response = await client.get(GEOCODE_URL, params=params)
        except httpx.HTTPError as error:
            # The exception text carries the URL, with the key and the position: type only.
            logger.error("geocoding_unreachable", extra={"error": type(error).__name__})
            raise GeocodingUnavailableError from None
        if response.status_code != httpx.codes.OK:
            logger.error("geocoding_failed", extra={"status_code": response.status_code})
            raise GeocodingUnavailableError from None
        try:
            body = response.json()
        except ValueError:
            logger.error("geocoding_unexpected_response", extra={"reason": "not_json"})
            raise GeocodingUnavailableError from None
        if not isinstance(body, dict):
            logger.error("geocoding_unexpected_response", extra={"reason": "not_object"})
            raise GeocodingUnavailableError from None
        raw_status = body.get("status")
        status = raw_status if isinstance(raw_status, str) else ""
        if status == STATUS_ZERO_RESULTS:
            return None
        results = body.get("results")
        if status != STATUS_OK or not isinstance(results, list):
            # A known status is safe to log; anything else is only "unexpected" (never the
            # body's error_message, whose content Google does not bound).
            logger.error(
                "geocoding_failed",
                extra={"google_status": status if status in UNAVAILABLE_STATUSES else "unexpected"},
            )
            raise GeocodingUnavailableError from None
        return first_us_address(results)


def first_us_address(results: list[object]) -> ResolvedAddress | None:
    """The address parts of the first result in the US, or None when that result is unusable
    (no postal code, no route, no city or no state) or no result is in the US."""
    for result in results:
        if not isinstance(result, dict):
            continue
        components = result.get("address_components")
        if not isinstance(components, list):
            continue
        parts = _components_by_type(components)
        if parts.get("country", ("", ""))[1] != COUNTRY:
            continue
        return _address_from(parts)
    return None


def _components_by_type(components: list[object]) -> dict[str, tuple[str, str]]:
    """{type: (long_name, short_name)}; the first component of each type wins."""
    parts: dict[str, tuple[str, str]] = {}
    for component in components:
        if not isinstance(component, dict):
            continue
        long_name = component.get("long_name")
        short_name = component.get("short_name")
        types = component.get("types")
        if not (isinstance(long_name, str) and isinstance(short_name, str)):
            continue
        if not isinstance(types, list):
            continue
        for kind in types:
            if isinstance(kind, str):
                parts.setdefault(kind, (long_name, short_name))
    return parts


def _address_from(parts: dict[str, tuple[str, str]]) -> ResolvedAddress | None:
    route = _long(parts, "route")
    city = _long(parts, "locality") or _long(parts, "sublocality") or _long(parts, "postal_town")
    state = _short(parts, "administrative_area_level_1")
    zip_match = ZIP5.match(_long(parts, "postal_code"))
    if not (route and city and len(state) == 2 and zip_match):
        return None
    number = _long(parts, "street_number")
    return ResolvedAddress(
        line1=f"{number} {route}" if number else route,
        city=city,
        state=state,
        zip_code=zip_match.group(0),
    )


def _long(parts: dict[str, tuple[str, str]], kind: str) -> str:
    return parts.get(kind, ("", ""))[0].strip()


def _short(parts: dict[str, tuple[str, str]], kind: str) -> str:
    return parts.get(kind, ("", ""))[1].strip()


def get_reverse_geocoder(request: Request) -> ReverseGeocoder:
    """FastAPI dependency: one geocoder per app, built on first use (tests override this).

    Without GOOGLE_MAPS_API_KEY the app still starts; its lookups answer 503 (#14).
    """
    geocoder: ReverseGeocoder | None = getattr(request.app.state, "reverse_geocoder", None)
    if geocoder is None:
        settings: Settings = request.app.state.settings
        if settings.google_maps_api_key is None:
            geocoder = UnconfiguredReverseGeocoder()
        else:
            geocoder = GoogleReverseGeocoder.from_settings(settings)
        request.app.state.reverse_geocoder = geocoder
    return geocoder
