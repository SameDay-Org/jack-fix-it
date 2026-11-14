"""Driving routes and forward geocoding through Mapbox (#351, live map part 2; Cesar 2026-11-10).

Two calls, both with httpx (async, one deadline each from settings); nothing is stored here:

- Directions: the driving route between two positions. Sent as a POST, so the positions travel
  in the body: the URL names the profile and carries the access token in its query string,
  which is where Mapbox wants it.
- Geocoding v6, forward, structured input: where a US street address is. The address travels
  in the query string. It comes in two kinds, and the caller says which by the method:
  `geocode` asks for a temporary result (`permanent` left out), which Mapbox's terms do not
  allow keeping or caching, and nothing here or in its caller does; `geocode_to_keep` asks
  with `permanent=true` (#384), the only kind that may be stored. Mapbox bills that kind
  apart and answers it only for an account with a payment method on file.

A position and an address are PII, and the token is a secret. So nothing here logs a
coordinate, an address part, the token, a URL or a response body, and no exception leaves this
module with any of them in its text (httpx's own exceptions name the URL; they are logged by
type only and never chained). Mapbox's `message` is never read. The `httpx` and `httpcore`
loggers run at WARNING (app/observability.py), and Sentry's HTTP breadcrumbs lose their query
string in `before_breadcrumb`: what is left of either URL is its fixed path.
"""

import asyncio
import logging
import math
from dataclasses import dataclass
from typing import Final, Literal, Protocol

import httpx
from starlette.requests import Request

from app.config import Settings

logger = logging.getLogger(__name__)

DIRECTIONS_URL: Final = "https://api.mapbox.com/directions/v5/mapbox/driving"
GEOCODE_URL: Final = "https://api.mapbox.com/search/geocode/v6/forward"
COUNTRY: Final = "us"
# Only a result that is an address: a street, a ZIP or a city centre is not where the job is.
GEOCODE_TYPES: Final = "address"
# https://docs.mapbox.com/api/navigation/directions/#directions-api-errors: both come with a
# 200 and mean "no route between these two", not a failure.
CODE_OK: Final = "Ok"
NO_ROUTE_CODES: Final = frozenset({"NoRoute", "NoSegment"})
# Six decimals are about 11 cm: all a route needs, and all the address columns keep.
_COORDINATE_FORMAT: Final = "{:.6f},{:.6f}"

Api = Literal["directions", "geocoding"]


class MapboxUnavailableError(Exception):
    """No token is configured, or Mapbox could not be reached or did not behave as expected."""


@dataclass(frozen=True)
class Coordinate:
    lat: float
    lng: float


@dataclass(frozen=True)
class StreetAddress:
    """What is sent to the geocoder: the street line and the place. Never the unit line."""

    line1: str
    city: str
    state: str
    zip_code: str


@dataclass(frozen=True)
class RouteStep:
    """One stretch of the route on one street; `street_name` is empty on an unnamed road."""

    street_name: str
    distance_m: float
    duration_s: float


@dataclass(frozen=True)
class DrivingRoute:
    """`geometry` is the whole line as Mapbox drew it, in order from the origin."""

    geometry: tuple[Coordinate, ...]
    distance_m: float
    duration_s: float
    steps: tuple[RouteStep, ...]


@dataclass(frozen=True)
class KeptGeocode:
    """A result that may be stored (`permanent=true`): the point, and the state and the ZIP
    Mapbox places it in (None where its answer names none), for the caller to hold against
    the address it asked about before it keeps anything."""

    coordinate: Coordinate
    region_code: str | None
    postcode: str | None


class AddressGeocoder(Protocol):
    """Places an address to keep its point (#384). Raises MapboxUnavailableError when the
    provider cannot answer."""

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        """Where the address is, or None when the provider finds no such address."""
        ...


class RouteProvider(Protocol):
    """Both calls raise MapboxUnavailableError when the provider cannot answer."""

    async def geocode(self, address: StreetAddress) -> Coordinate | None:
        """Where the address is, or None when the provider finds no such address."""
        ...

    async def route(self, origin: Coordinate, destination: Coordinate) -> DrivingRoute | None:
        """The driving route between the two, or None when there is none."""
        ...


class UnconfiguredRouteProvider:
    """Stands in while MAPBOX_ACCESS_TOKEN is unset: every call is unavailable."""

    async def geocode(self, address: StreetAddress) -> Coordinate | None:
        raise self._unavailable()

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        raise self._unavailable()

    async def route(self, origin: Coordinate, destination: Coordinate) -> DrivingRoute | None:
        raise self._unavailable()

    @staticmethod
    def _unavailable() -> MapboxUnavailableError:
        # A known state of a deploy, not an incident: WARNING, so Sentry sees no event.
        logger.warning("mapbox_not_configured")
        return MapboxUnavailableError()


class MapboxRouteProvider:
    def __init__(
        self,
        *,
        access_token: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._access_token = access_token
        self._timeout = timeout_seconds
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> "MapboxRouteProvider":
        if settings.mapbox_access_token is None:
            raise RuntimeError("MAPBOX_ACCESS_TOKEN is not set; routes are unavailable")
        return cls(
            access_token=settings.mapbox_access_token.get_secret_value(),
            timeout_seconds=settings.mapbox_timeout_seconds,
        )

    async def geocode(self, address: StreetAddress) -> Coordinate | None:
        """A temporary result: for this one use, never to be stored or cached."""
        feature = await self._first_address(address, permanent=False)
        return None if feature is None else _feature_coordinate(feature)

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        """A permanent result (billed apart): the only kind the caller may store."""
        feature = await self._first_address(address, permanent=True)
        if feature is None:
            return None
        coordinate = _feature_coordinate(feature)
        region_code, postcode = _feature_area(feature)
        return KeptGeocode(coordinate=coordinate, region_code=region_code, postcode=postcode)

    async def _first_address(self, address: StreetAddress, *, permanent: bool) -> object | None:
        """The best address feature Mapbox has for the address, or None when it has none."""
        params = {
            "address_line1": address.line1,
            "place": address.city,
            "region": address.state,
            "postcode": address.zip_code[:5],
            "country": COUNTRY,
            "types": GEOCODE_TYPES,
            "limit": "1",
            "autocomplete": "false",
            "access_token": self._access_token,
        }
        if permanent:
            # https://docs.mapbox.com/api/search/geocoding/: "whether you intend to store the
            # results of the query". Left out, the result is a temporary one.
            params["permanent"] = "true"
        body = await self._send("geocoding", "GET", GEOCODE_URL, params=params)
        features = body.get("features")
        if not isinstance(features, list):
            raise _unexpected("geocoding", "no_features")
        return features[0] if features else None

    async def route(self, origin: Coordinate, destination: Coordinate) -> DrivingRoute | None:
        form = {
            "coordinates": ";".join(
                _COORDINATE_FORMAT.format(point.lng, point.lat) for point in (origin, destination)
            ),
            "geometries": "geojson",
            "overview": "full",
            "steps": "true",
        }
        body = await self._send(
            "directions",
            "POST",
            DIRECTIONS_URL,
            params={"access_token": self._access_token},
            form=form,
        )
        code = body.get("code")
        if isinstance(code, str) and code in NO_ROUTE_CODES:
            return None
        routes = body.get("routes")
        if code != CODE_OK or not isinstance(routes, list):
            raise _unexpected("directions", "bad_code")
        if not routes:
            return None
        route = _driving_route(routes[0])
        if route is None:
            raise _unexpected("directions", "bad_route")
        return route

    async def _send(
        self,
        api: Api,
        method: Literal["GET", "POST"],
        url: str,
        *,
        params: dict[str, str],
        form: dict[str, str] | None = None,
    ) -> dict[str, object]:
        """The JSON object of a 200. Anything else is unavailable, logged without its text."""
        try:
            # httpx's timeout is per phase (connect, write, each read): the whole call gets
            # one deadline, so it takes MAPBOX_TIMEOUT_SECONDS at the most.
            async with (
                asyncio.timeout(self._timeout),
                httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client,
            ):
                response = await client.request(method, url, params=params, data=form)
        except (httpx.HTTPError, TimeoutError) as error:
            # The exception text carries the URL, with the token (and the address): type only.
            logger.error("mapbox_unreachable", extra={"api": api, "error": type(error).__name__})
            raise MapboxUnavailableError from None
        if response.status_code != httpx.codes.OK:
            # 401 and 403 (the token), 422 (a request Mapbox refuses), 429 (the rate limit),
            # 5xx: the status says which; the body's message is Mapbox's own text.
            logger.error("mapbox_failed", extra={"api": api, "status_code": response.status_code})
            raise MapboxUnavailableError from None
        try:
            body = response.json()
        except ValueError:
            raise _unexpected(api, "not_json") from None
        if not isinstance(body, dict):
            raise _unexpected(api, "not_object")
        return body


def _unexpected(api: Api, reason: str) -> MapboxUnavailableError:
    logger.error("mapbox_unexpected_response", extra={"api": api, "reason": reason})
    return MapboxUnavailableError()


def _number(value: object) -> float | None:
    """A finite JSON number (never a bool), as a float."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:  # an integer too large for a float
        return None
    return number if math.isfinite(number) else None


def _coordinate(point: object) -> Coordinate | None:
    """A GeoJSON position, `[lng, lat]` (an altitude may follow), on the globe."""
    if not isinstance(point, list) or len(point) < 2:
        return None
    lng, lat = _number(point[0]), _number(point[1])
    if lng is None or lat is None or not (-180 <= lng <= 180 and -90 <= lat <= 90):
        return None
    return Coordinate(lat=lat, lng=lng)


def _feature_coordinate(feature: object) -> Coordinate:
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    point = geometry.get("coordinates") if isinstance(geometry, dict) else None
    coordinate = _coordinate(point)
    if coordinate is None:
        raise _unexpected("geocoding", "bad_coordinates")
    return coordinate


def _feature_area(feature: object) -> tuple[str | None, str | None]:
    """The state's code (`context.region.region_code`, "FL") and the ZIP
    (`context.postcode.name`) of a geocoding feature; None for one its answer does not name."""
    properties = feature.get("properties") if isinstance(feature, dict) else None
    context = properties.get("context") if isinstance(properties, dict) else None
    if not isinstance(context, dict):
        return None, None
    region_code = _context_text(context, "region", "region_code")
    return region_code, _context_text(context, "postcode", "name")


def _context_text(context: dict[str, object], layer: str, field: str) -> str | None:
    entry = context.get(layer)
    value = entry.get(field) if isinstance(entry, dict) else None
    return value.strip() or None if isinstance(value, str) else None


def _amount(value: object) -> float | None:
    """A distance in meters or a time in seconds: a finite number, zero or more."""
    number = _number(value)
    return number if number is not None and number >= 0 else None


def _driving_route(route: object) -> DrivingRoute | None:
    """None when the route is not shaped as the Directions API documents it."""
    if not isinstance(route, dict):
        return None
    distance, duration = _amount(route.get("distance")), _amount(route.get("duration"))
    geometry = route.get("geometry")
    line = geometry.get("coordinates") if isinstance(geometry, dict) else None
    legs = route.get("legs")
    if distance is None or duration is None:
        return None
    if not isinstance(line, list) or len(line) < 2 or not isinstance(legs, list):
        return None
    points: list[Coordinate] = []
    for point in line:
        coordinate = _coordinate(point)
        if coordinate is None:
            return None
        points.append(coordinate)
    steps: list[RouteStep] = []
    for leg in legs:
        leg_steps = leg.get("steps") if isinstance(leg, dict) else None
        if not isinstance(leg_steps, list):
            return None
        for step in leg_steps:
            parsed = _step(step)
            if parsed is None:
                return None
            steps.append(parsed)
    return DrivingRoute(
        geometry=tuple(points), distance_m=distance, duration_s=duration, steps=tuple(steps)
    )


def _step(step: object) -> RouteStep | None:
    if not isinstance(step, dict):
        return None
    name = step.get("name", "")
    distance, duration = _amount(step.get("distance")), _amount(step.get("duration"))
    if not isinstance(name, str) or distance is None or duration is None:
        return None
    return RouteStep(street_name=name.strip(), distance_m=distance, duration_s=duration)


def provider_from_settings(settings: Settings) -> MapboxRouteProvider | UnconfiguredRouteProvider:
    """Mapbox with MAPBOX_ACCESS_TOKEN; without it the stand-in whose every call is
    unavailable. Either is a RouteProvider and an AddressGeocoder."""
    if settings.mapbox_access_token is None:
        return UnconfiguredRouteProvider()
    return MapboxRouteProvider.from_settings(settings)


def get_route_provider(request: Request) -> RouteProvider:
    """FastAPI dependency: one provider per app, built on first use (tests override this).

    Without MAPBOX_ACCESS_TOKEN the app still starts; its routes answer 503.
    """
    provider: RouteProvider | None = getattr(request.app.state, "route_provider", None)
    if provider is None:
        provider = provider_from_settings(request.app.state.settings)
        request.app.state.route_provider = provider
    return provider
