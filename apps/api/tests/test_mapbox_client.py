"""The Mapbox client: driving routes and forward geocoding (#351). Never calls Mapbox."""

import asyncio
import logging
import time
import traceback
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from starlette.requests import Request

from app.integrations.mapbox import (
    DIRECTIONS_URL,
    GEOCODE_URL,
    Coordinate,
    DrivingRoute,
    KeptGeocode,
    MapboxRouteProvider,
    MapboxUnavailableError,
    RouteStep,
    StreetAddress,
    UnconfiguredRouteProvider,
    get_route_provider,
    provider_from_settings,
)
from app.observability import (
    MAPBOX_HOST,
    MAPBOX_URL_LABEL,
    before_breadcrumb,
    configure_logging,
)
from tests.conftest import make_app, make_settings
from tests.helpers import log_fields

# Fixture values only: no real token, no real place. The ZIP is no needle: five digits can
# turn up in a log line's own timestamp.
TOKEN = "pk.test-mapbox-token-not-real"
TIMEOUT = 2.5
HOST = "api.mapbox.com"
ORIGIN = Coordinate(lat=26.123457, lng=-80.143219)
DESTINATION = Coordinate(lat=26.234568, lng=-80.254321)
ADDRESS = StreetAddress(
    line1="123 Test Street", city="Testville", state="FL", zip_code="00001-1234"
)
VENDOR_TEXT = "Mapbox says: probe-vendor-message"
PII = (
    TOKEN,
    HOST,
    "26.1234",
    "80.1432",
    "26.2345",
    "80.2543",
    "Test Street",
    "Testville",
    "Probe Road",
    "probe-vendor-message",
)

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def app_logging() -> None:
    """LOG_LEVEL=DEBUG as create_app applies it. httpx names every request URL at INFO, the
    token included; the app keeps that logger at WARNING (app/observability.py)."""
    configure_logging("DEBUG")
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() == logging.WARNING


def provider(handler: Handler) -> MapboxRouteProvider:
    return MapboxRouteProvider(
        access_token=TOKEN, timeout_seconds=TIMEOUT, transport=httpx.MockTransport(handler)
    )


def step(name: str | None = "Probe Road", distance: float = 120.5, duration: float = 30.2) -> Any:
    body: dict[str, Any] = {
        "distance": distance,
        "duration": duration,
        "maneuver": {"instruction": f"Turn left onto {name}", "location": [-80.2, 26.2]},
    }
    if name is not None:
        body["name"] = name
    return body


LINE = [[-80.143219, 26.123457], [-80.2, 26.2, 3.5], [-80.254321, 26.234568]]


def route_body(**fields: Any) -> dict[str, Any]:
    route = {
        "distance": 15234.6,
        "duration": 1260.4,
        "geometry": {"type": "LineString", "coordinates": LINE},
        "legs": [{"steps": [step(), step(""), step(None, 0, 0)]}],
        **fields,
    }
    return {"code": "Ok", "routes": [route], "waypoints": [], "uuid": "probe"}


def directions(body: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body)


def feature(coordinates: Any = (-80.254321, 26.234568)) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": list(coordinates)},
        "properties": {"feature_type": "address", "full_address": "123 Test Street, Testville"},
    }


def geocoded(*features: dict[str, Any]) -> httpx.Response:
    return httpx.Response(
        200, json={"type": "FeatureCollection", "features": list(features), "attribution": "x"}
    )


# The requests


async def test_directions_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return directions(route_body())

    route = await provider(handler).route(ORIGIN, DESTINATION)

    [request] = seen
    # A POST: the positions travel in the body, and the URL holds nothing but the profile
    # and the token (in its query, which Sentry's breadcrumbs lose).
    assert request.method == "POST"
    assert f"{request.url.scheme}://{request.url.host}{request.url.path}" == DIRECTIONS_URL
    assert request.url.path == "/directions/v5/mapbox/driving"
    assert dict(request.url.params) == {"access_token": TOKEN}
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert parse_qs(request.content.decode()) == {
        "coordinates": ["-80.143219,26.123457;-80.254321,26.234568"],  # lng,lat
        "geometries": ["geojson"],
        "overview": ["full"],
        "steps": ["true"],
    }
    assert request.extensions["timeout"] == httpx.Timeout(TIMEOUT).as_dict()
    assert route == DrivingRoute(
        geometry=(
            Coordinate(lat=26.123457, lng=-80.143219),
            Coordinate(lat=26.2, lng=-80.2),  # an altitude is ignored
            Coordinate(lat=26.234568, lng=-80.254321),
        ),
        distance_m=15234.6,
        duration_s=1260.4,
        # Street names only: never the maneuver's instruction text.
        steps=(
            RouteStep("Probe Road", 120.5, 30.2),
            RouteStep("", 120.5, 30.2),
            RouteStep("", 0, 0),
        ),
    )


async def test_geocoding_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return geocoded(feature(), feature((-81.0, 27.0)))

    found = await provider(handler).geocode(ADDRESS)

    [request] = seen
    assert request.method == "GET"
    assert f"{request.url.scheme}://{request.url.host}{request.url.path}" == GEOCODE_URL
    # Structured input, in the query: the path names no address. No `permanent`: a temporary
    # result, which is never kept.
    assert dict(request.url.params) == {
        "address_line1": "123 Test Street",
        "place": "Testville",
        "region": "FL",
        "postcode": "00001",
        "country": "us",
        "types": "address",
        "limit": "1",
        "autocomplete": "false",
        "access_token": TOKEN,
    }
    assert request.extensions["timeout"] == httpx.Timeout(TIMEOUT).as_dict()
    assert found == Coordinate(lat=26.234568, lng=-80.254321)  # the first feature


# Answers that are not failures


@pytest.mark.parametrize(
    "response",
    [
        directions({"code": "NoRoute", "routes": [], "message": VENDOR_TEXT}),
        directions({"code": "NoSegment", "message": VENDOR_TEXT}),
        directions({"code": "Ok", "routes": []}),
    ],
    ids=["no_route", "no_segment", "no_routes"],
)
async def test_no_route_is_none(response: httpx.Response) -> None:
    assert await provider(lambda _: response).route(ORIGIN, DESTINATION) is None


async def test_no_such_address_is_none() -> None:
    assert await provider(lambda _: geocoded()).geocode(ADDRESS) is None


# Failures


def _raise(error_type: type[httpx.TransportError]) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type(f"boom {request.url}", request=request)

    return handler


def _status(status: int) -> Handler:
    return lambda _: httpx.Response(status, json={"message": VENDOR_TEXT, "code": "Probe Road"})


COMMON_FAILURES: dict[str, Handler] = {
    "timeout": _raise(httpx.ReadTimeout),
    "connect_timeout": _raise(httpx.ConnectTimeout),
    "network_error": _raise(httpx.ConnectError),
    "http_401": _status(401),
    "http_403": _status(403),
    "http_404": _status(404),
    "http_422": _status(422),
    "http_429": _status(429),
    "http_500": lambda _: httpx.Response(500, text=VENDOR_TEXT),
    "not_json": lambda _: httpx.Response(200, text=f"<html>{VENDOR_TEXT}"),
    "not_an_object": lambda _: httpx.Response(200, json=[VENDOR_TEXT]),
}
DIRECTIONS_FAILURES: dict[str, Handler] = {
    **COMMON_FAILURES,
    "no_code": lambda _: directions({"routes": [route_body()["routes"][0]]}),
    "unknown_code": lambda _: directions({"code": "Probe Road", "message": VENDOR_TEXT}),
    "code_is_a_list": lambda _: directions({"code": ["NoRoute"], "routes": []}),
    "code_is_an_object": lambda _: directions({"code": {"NoRoute": 1}, "routes": []}),
    "routes_not_a_list": lambda _: directions({"code": "Ok", "routes": {}}),
    "distance_too_large_for_a_float": lambda _: directions(route_body(distance=10**400)),
    "route_not_an_object": lambda _: directions({"code": "Ok", "routes": ["Probe Road"]}),
    "no_distance": lambda _: directions(route_body(distance=None)),
    "negative_distance": lambda _: directions(route_body(distance=-1)),
    "duration_is_text": lambda _: directions(route_body(duration="1260")),
    "duration_is_bool": lambda _: directions(route_body(duration=True)),
    "no_geometry": lambda _: directions(route_body(geometry=None)),
    "encoded_geometry": lambda _: directions(route_body(geometry="probe_polyline")),
    "one_point": lambda _: directions(route_body(geometry={"coordinates": LINE[:1]})),
    "point_out_of_range": lambda _: directions(
        route_body(geometry={"coordinates": [[-80.1, 26.1], [-80.2, 95.0]]})
    ),
    "point_not_numbers": lambda _: directions(
        route_body(geometry={"coordinates": [[-80.1, 26.1], ["-80.2", "26.2"]]})
    ),
    "point_too_short": lambda _: directions(
        route_body(geometry={"coordinates": [[-80.1, 26.1], [-80.2]]})
    ),
    "no_legs": lambda _: directions(route_body(legs=None)),
    "leg_without_steps": lambda _: directions(route_body(legs=[{}])),
    "step_not_an_object": lambda _: directions(route_body(legs=[{"steps": ["Probe Road"]}])),
    "step_name_not_text": lambda _: directions(
        route_body(legs=[{"steps": [{"name": 7, "distance": 1, "duration": 1}]}])
    ),
    "step_without_distance": lambda _: directions(
        route_body(legs=[{"steps": [{"name": "Probe Road", "duration": 1}]}])
    ),
}
GEOCODING_FAILURES: dict[str, Handler] = {
    **COMMON_FAILURES,
    "no_features": lambda _: httpx.Response(200, json={"type": "FeatureCollection"}),
    "features_not_a_list": lambda _: httpx.Response(200, json={"features": {"0": feature()}}),
    "feature_not_an_object": lambda _: geocoded("Test Street"),  # type: ignore[arg-type]
    "no_geometry": lambda _: geocoded({"type": "Feature", "properties": {}}),
    "point_out_of_range": lambda _: geocoded(feature((-80.2, 95.0))),
    "point_not_numbers": lambda _: geocoded(feature(("-80.2", "26.2"))),
    "point_too_short": lambda _: geocoded(feature((-80.2,))),
}


def assert_unavailable_without_leak(
    info: pytest.ExceptionInfo[MapboxUnavailableError], caplog: pytest.LogCaptureFixture
) -> None:
    # The exception, its cause and its context, as a traceback would print them.
    rendered = "".join(traceback.format_exception(info.value))
    assert "MapboxUnavailableError" in rendered
    output = log_fields(caplog.records)
    for secret in PII:
        assert secret not in rendered, secret
        assert [field for field in output if secret in field] == [], secret
    [record] = [r for r in caplog.records if r.name == "app.integrations.mapbox"]
    assert record.levelno == logging.ERROR, "a real failure is an incident"
    assert record.message.startswith("mapbox_")
    extras = set(vars(record)) - set(vars(logging.makeLogRecord({})))
    assert extras <= {"api", "error", "status_code", "reason", "message", "asctime"}, extras


@pytest.mark.parametrize(
    "handler", list(DIRECTIONS_FAILURES.values()), ids=list(DIRECTIONS_FAILURES)
)
async def test_directions_failures_are_unavailable_without_url_token_or_vendor_text(
    handler: Handler, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(MapboxUnavailableError) as info:
        await provider(handler).route(ORIGIN, DESTINATION)

    assert_unavailable_without_leak(info, caplog)


@pytest.mark.parametrize("handler", list(GEOCODING_FAILURES.values()), ids=list(GEOCODING_FAILURES))
async def test_geocoding_failures_are_unavailable_without_url_token_or_vendor_text(
    handler: Handler, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(MapboxUnavailableError) as info:
        await provider(handler).geocode(ADDRESS)

    assert_unavailable_without_leak(info, caplog)


async def test_failure_logs_say_which_call_and_status(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(MapboxUnavailableError):
            await provider(_status(429)).route(ORIGIN, DESTINATION)
        with pytest.raises(MapboxUnavailableError):
            await provider(_raise(httpx.ReadTimeout)).geocode(ADDRESS)

    logged = [
        (r.message, r.__dict__.get("api"), r.__dict__.get("status_code"), r.__dict__.get("error"))
        for r in caplog.records
        if r.name == "app.integrations.mapbox"
    ]
    assert logged == [
        ("mapbox_failed", "directions", 429, None),
        ("mapbox_unreachable", "geocoding", None, "ReadTimeout"),
    ]


async def test_a_call_ends_at_its_deadline_however_mapbox_drips() -> None:
    """MAPBOX_TIMEOUT_SECONDS bounds the whole call: httpx's own timeout is per phase, and a
    response that keeps coming slowly never trips it."""

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return directions(route_body())

    client = MapboxRouteProvider(
        access_token=TOKEN, timeout_seconds=0.05, transport=httpx.MockTransport(slow)
    )
    started_at = time.monotonic()

    with pytest.raises(MapboxUnavailableError):
        await client.route(ORIGIN, DESTINATION)
    with pytest.raises(MapboxUnavailableError):
        await client.geocode(ADDRESS)

    assert time.monotonic() - started_at < 5


# Sentry's breadcrumb of a call


@pytest.mark.parametrize(
    "url",
    [
        DIRECTIONS_URL,
        f"{GEOCODE_URL}?address_line1=123+Test+Street&place=Testville&access_token={TOKEN}",
        # The GET form of a route, should the client ever use it: the positions in the path.
        "https://API.mapbox.com/directions/v5/mapbox/driving/-80.143219,26.123457;-80.2,26.2",
    ],
    ids=["directions", "geocoding", "positions_in_the_path"],
)
def test_sentry_breadcrumb_of_a_mapbox_call_names_no_url(url: str) -> None:
    crumb = before_breadcrumb(
        {
            "type": "http",
            "category": "httplib",
            "data": {
                "url": url,
                "http.method": "GET",
                "http.query": f"access_token={TOKEN}",
                "http.response.status_code": 200,
            },
        },
        {},
    )

    # The vendor, the method and the status: no URL, so no path and no query.
    assert crumb == {
        "type": "http",
        "category": "httplib",
        "data": {"url": MAPBOX_URL_LABEL, "http.method": "GET", "http.response.status_code": 200},
    }


def test_the_client_calls_the_host_the_breadcrumbs_know() -> None:
    assert urlsplit(DIRECTIONS_URL).hostname == MAPBOX_HOST
    assert urlsplit(GEOCODE_URL).hostname == MAPBOX_HOST
    # Another host's breadcrumb keeps its URL, less the query.
    other = before_breadcrumb(
        {"type": "http", "data": {"url": "https://api.mapbox.com.example.org/v1?x=1"}}, {}
    )
    assert other["data"] == {"url": "https://api.mapbox.com.example.org/v1"}


# No token


async def test_unconfigured_provider_is_unavailable(caplog: pytest.LogCaptureFixture) -> None:
    unconfigured = UnconfiguredRouteProvider()
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(MapboxUnavailableError):
            await unconfigured.route(ORIGIN, DESTINATION)
        with pytest.raises(MapboxUnavailableError):
            await unconfigured.geocode(ADDRESS)

    # A known state of a deploy, not an incident: no Sentry event.
    assert [(r.message, r.levelno) for r in caplog.records] == [
        ("mapbox_not_configured", logging.WARNING)
    ] * 2


def _dependency_for(app: FastAPI) -> object:
    return get_route_provider(Request({"type": "http", "app": app}))


def test_dependency_builds_the_mapbox_client_only_with_a_token() -> None:
    without_token = make_app(make_settings())  # the app is built: it boots without the token
    with_token = make_app(make_settings(mapbox_access_token=TOKEN))

    assert isinstance(_dependency_for(without_token), UnconfiguredRouteProvider)
    assert isinstance(_dependency_for(with_token), MapboxRouteProvider)
    # One per app, built on first use.
    assert _dependency_for(with_token) is _dependency_for(with_token)


# Settings


def test_route_settings_defaults() -> None:
    settings = make_settings()

    assert settings.mapbox_access_token is None
    assert settings.mapbox_timeout_seconds == 5.0
    assert settings.route_cache_seconds == 30
    assert settings.route_retry_seconds == 10
    assert settings.route_refresh_distance_m == 100.0
    assert settings.route_max_points == 500
    assert settings.route_max_steps == 30


def test_token_is_a_secret_and_empty_means_unset() -> None:
    settings = make_settings(mapbox_access_token=TOKEN)

    assert make_settings(mapbox_access_token="").mapbox_access_token is None
    assert settings.mapbox_access_token is not None
    assert settings.mapbox_access_token.get_secret_value() == TOKEN
    assert TOKEN not in repr(settings)
    assert TOKEN not in settings.model_dump_json()


@pytest.mark.parametrize(
    "bad",
    [
        {"mapbox_timeout_seconds": 0},
        {"route_cache_seconds": 0},
        {"route_retry_seconds": 0},
        {"route_refresh_distance_m": -1},
        {"route_max_points": 1},
        {"route_max_steps": 0},
    ],
)
def test_route_settings_are_validated(bad: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        make_settings(**bad)


def test_route_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAPBOX_ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("MAPBOX_TIMEOUT_SECONDS", "1.5")
    monkeypatch.setenv("ROUTE_CACHE_SECONDS", "45")
    monkeypatch.setenv("ROUTE_RETRY_SECONDS", "20")
    monkeypatch.setenv("ROUTE_REFRESH_DISTANCE_M", "250")
    monkeypatch.setenv("ROUTE_MAX_POINTS", "50")
    monkeypatch.setenv("ROUTE_MAX_STEPS", "5")

    settings = make_settings()

    assert settings.mapbox_access_token is not None
    assert settings.mapbox_access_token.get_secret_value() == TOKEN
    assert (
        settings.mapbox_timeout_seconds,
        settings.route_cache_seconds,
        settings.route_retry_seconds,
        settings.route_refresh_distance_m,
        settings.route_max_points,
        settings.route_max_steps,
    ) == (1.5, 45, 20, 250.0, 50, 5)


# Permanent geocoding (#384): the only kind whose result may be stored


def kept_feature(region: Any = "FL", postcode: Any = "00001") -> dict[str, Any]:
    made = feature()
    made["properties"]["context"] = {
        "region": {"name": "Florida", "region_code": region, "region_code_full": "US-FL"},
        "postcode": {"name": postcode},
        "place": {"name": "Testville"},
    }
    return made


def _without_context(properties: Any) -> dict[str, Any]:
    return {**feature(), "properties": properties}


async def test_a_geocode_to_keep_says_permanent_and_a_temporary_one_never_does() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return geocoded(kept_feature(), kept_feature("GA", "99999"))

    mapbox = provider(handler)
    kept = await mapbox.geocode_to_keep(ADDRESS)
    temporary = await mapbox.geocode(ADDRESS)

    to_keep, to_drop = (dict(request.url.params) for request in seen)
    # Mapbox's terms: only a result asked for with permanent=true may be stored.
    assert to_keep.pop("permanent") == "true"
    assert "permanent" not in to_drop
    # The same question otherwise: structured, in the query, the ZIP's five digits.
    assert to_keep == to_drop
    assert to_keep["postcode"] == "00001"
    assert [request.method for request in seen] == ["GET", "GET"]
    assert all(
        f"{request.url.scheme}://{request.url.host}{request.url.path}" == GEOCODE_URL
        and request.extensions["timeout"] == httpx.Timeout(TIMEOUT).as_dict()
        for request in seen
    )
    # The first feature: its point, and the state and the ZIP Mapbox places it in.
    assert kept == KeptGeocode(
        coordinate=Coordinate(lat=26.234568, lng=-80.254321), region_code="FL", postcode="00001"
    )
    assert temporary == Coordinate(lat=26.234568, lng=-80.254321)


@pytest.mark.parametrize(
    ("made", "area"),
    [
        (kept_feature(" FL ", " 00001 "), ("FL", "00001")),
        (kept_feature("fl", "00001-1234"), ("fl", "00001-1234")),  # as Mapbox wrote them
        (kept_feature(None, "00001"), (None, "00001")),
        (kept_feature("FL", 1), ("FL", None)),
        (kept_feature("", "  "), (None, None)),
        (feature(), (None, None)),
        (_without_context("Test Street"), (None, None)),
        (_without_context({"context": ["FL", "00001"]}), (None, None)),
        (_without_context({"context": {"region": "FL", "postcode": "00001"}}), (None, None)),
    ],
    ids=[
        "trimmed",
        "unchanged",
        "no_region_code",
        "postcode_not_text",
        "blank",
        "no_context",
        "properties_not_an_object",
        "context_not_an_object",
        "layers_not_objects",
    ],
)
async def test_the_area_of_a_result_to_keep_is_what_mapbox_names(
    made: dict[str, Any], area: tuple[str | None, str | None]
) -> None:
    kept = await provider(lambda _: geocoded(made)).geocode_to_keep(ADDRESS)

    assert kept is not None
    assert (kept.region_code, kept.postcode) == area


async def test_no_such_address_to_keep_is_none() -> None:
    assert await provider(lambda _: geocoded()).geocode_to_keep(ADDRESS) is None


@pytest.mark.parametrize("handler", list(GEOCODING_FAILURES.values()), ids=list(GEOCODING_FAILURES))
async def test_failures_of_a_geocode_to_keep_are_unavailable_without_a_leak(
    handler: Handler, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(MapboxUnavailableError) as info:
        await provider(handler).geocode_to_keep(ADDRESS)

    assert_unavailable_without_leak(info, caplog)


async def test_unconfigured_provider_keeps_nothing(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(MapboxUnavailableError):
        await UnconfiguredRouteProvider().geocode_to_keep(ADDRESS)

    assert [(r.message, r.levelno) for r in caplog.records] == [
        ("mapbox_not_configured", logging.WARNING)
    ]


def test_the_worker_gets_the_mapbox_client_only_with_a_token() -> None:
    assert isinstance(provider_from_settings(make_settings()), UnconfiguredRouteProvider)
    assert isinstance(
        provider_from_settings(make_settings(mapbox_access_token=TOKEN)), MapboxRouteProvider
    )
