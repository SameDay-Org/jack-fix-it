"""The Google reverse-geocoding client (D8.2, #215). Never calls Google."""

import logging
import traceback
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from starlette.requests import Request

from app.integrations.geocoding import (
    GEOCODE_URL,
    GeocodingUnavailableError,
    GoogleReverseGeocoder,
    ResolvedAddress,
    UnconfiguredReverseGeocoder,
    first_us_address,
    get_reverse_geocoder,
)
from app.observability import JsonFormatter, configure_logging
from tests.conftest import make_app, make_settings

# Fixture values only: no real key, no real place.
KEY = "test-google-key-not-real"
LAT = 26.1224
LNG = -80.1373
TIMEOUT = 2.5
HOST = "maps.googleapis.com"
PII = (KEY, HOST, "26.12", "80.13", "Test Street", "Testville", "00001")

Handler = Callable[[httpx.Request], httpx.Response]


def component(long_name: str, types: list[str], short_name: str | None = None) -> dict[str, Any]:
    return {"long_name": long_name, "short_name": short_name or long_name, "types": types}


NUMBER = component("123", ["street_number"])
ROUTE = component("Test Street", ["route"], "Test St")
CITY = component("Testville", ["locality", "political"])
SUBLOCALITY = component("Testborough", ["sublocality_level_1", "sublocality", "political"])
POSTAL_TOWN = component("Testham", ["postal_town"])
STATE = component("Florida", ["administrative_area_level_1", "political"], "FL")
ZIP = component("00001", ["postal_code"])
ZIP_PLUS_4 = component("00001-1234", ["postal_code"])
US = component("United States", ["country", "political"], "US")
CANADA = component("Canada", ["country", "political"], "CA")
STREET = [NUMBER, ROUTE, CITY, STATE, ZIP, US]
EXPECTED = ResolvedAddress(line1="123 Test Street", city="Testville", state="FL", zip_code="00001")


@pytest.fixture(autouse=True)
def app_logging() -> None:
    """LOG_LEVEL=DEBUG as create_app applies it. httpx names every request URL at INFO, key
    and position included; the app keeps that logger at WARNING (app/observability.py)."""
    configure_logging("DEBUG")
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("httpcore").getEffectiveLevel() == logging.WARNING


def result(*components: dict[str, Any]) -> dict[str, Any]:
    return {"address_components": list(components), "types": ["street_address"]}


def google(status: str, *results: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json={"status": status, "results": list(results)})


def geocoder(handler: Handler) -> GoogleReverseGeocoder:
    return GoogleReverseGeocoder(
        api_key=KEY, timeout_seconds=TIMEOUT, transport=httpx.MockTransport(handler)
    )


def without(components: list[dict[str, Any]], *kinds: str) -> list[dict[str, Any]]:
    return [c for c in components if not set(c["types"]) & set(kinds)]


async def test_google_client_request_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return google("OK", result(*STREET))

    address = await geocoder(handler).reverse(LAT, LNG)

    [request] = seen
    assert request.method == "GET"
    assert f"{request.url.scheme}://{request.url.host}{request.url.path}" == GEOCODE_URL
    assert dict(request.url.params) == {
        "latlng": f"{LAT},{LNG}",
        "key": KEY,
        "language": "en",
        "result_type": "street_address|premise|route",
    }
    assert request.extensions["timeout"] == httpx.Timeout(TIMEOUT).as_dict()
    assert address == EXPECTED


@pytest.mark.parametrize(
    ("results", "expected"),
    [
        ([result(*STREET)], EXPECTED),
        # The first US result is the one read, whatever comes before it.
        ([result(NUMBER, ROUTE, CITY, STATE, ZIP, CANADA), result(*STREET)], EXPECTED),
        # The route alone when there is no street number.
        (
            [result(*without(STREET, "street_number"))],
            ResolvedAddress(line1="Test Street", city="Testville", state="FL", zip_code="00001"),
        ),
        # ZIP+4 is trimmed to its 5 digits.
        ([result(NUMBER, ROUTE, CITY, STATE, ZIP_PLUS_4, US)], EXPECTED),
        # The locality wins; sublocality, then postal_town, stand in when it is missing.
        ([result(NUMBER, ROUTE, SUBLOCALITY, CITY, STATE, ZIP, US)], EXPECTED),
        (
            [result(NUMBER, ROUTE, SUBLOCALITY, POSTAL_TOWN, STATE, ZIP, US)],
            ResolvedAddress(
                line1="123 Test Street", city="Testborough", state="FL", zip_code="00001"
            ),
        ),
        (
            [result(NUMBER, ROUTE, POSTAL_TOWN, STATE, ZIP, US)],
            ResolvedAddress(line1="123 Test Street", city="Testham", state="FL", zip_code="00001"),
        ),
    ],
    ids=[
        "street",
        "first_us_result",
        "route_without_number",
        "zip_plus_4",
        "locality_over_sublocality",
        "sublocality_fallback",
        "postal_town_fallback",
    ],
)
async def test_google_client_parsing(
    results: list[dict[str, Any]], expected: ResolvedAddress
) -> None:
    address = await geocoder(lambda _: google("OK", *results)).reverse(LAT, LNG)

    assert address == expected
    assert first_us_address(list(results)) == expected


@pytest.mark.parametrize(
    "response",
    [
        google("ZERO_RESULTS"),
        google("OK", result(NUMBER, ROUTE, CITY, STATE, ZIP, CANADA)),
        google("OK", result(*without(STREET, "postal_code"))),
        google("OK", result(*without(STREET, "route"))),
        google("OK", result(*without(STREET, "locality"))),
        google("OK", result(*without(STREET, "administrative_area_level_1"))),
        google("OK", result(*without(STREET, "country"))),
        google("OK", {"address_components": "not a list"}),
    ],
    ids=[
        "zero_results",
        "non_us",
        "no_postal_code",
        "no_route",
        "no_city",
        "no_state",
        "no_country",
        "malformed_result",
    ],
)
async def test_google_client_no_usable_result_is_none(response: httpx.Response) -> None:
    assert await geocoder(lambda _: response).reverse(LAT, LNG) is None


def _raise(error_type: type[httpx.TransportError]) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type(f"boom {request.url}", request=request)

    return handler


FAILURES: dict[str, Handler] = {
    "timeout": _raise(httpx.ReadTimeout),
    "connect_timeout": _raise(httpx.ConnectTimeout),
    "network_error": _raise(httpx.ConnectError),
    "http_500": lambda _: httpx.Response(500, text="boom"),
    "http_403": lambda _: httpx.Response(403, json={"status": "REQUEST_DENIED"}),
    "request_denied": lambda _: google("REQUEST_DENIED"),
    "over_query_limit": lambda _: google("OVER_QUERY_LIMIT"),
    "invalid_request": lambda _: google("INVALID_REQUEST"),
    "unknown_error": lambda _: google("UNKNOWN_ERROR"),
    "unexpected_status": lambda _: google("SOMETHING_NEW"),
    "status_not_a_string": lambda _: httpx.Response(200, json={"status": ["OK"], "results": []}),
    "not_json": lambda _: httpx.Response(200, text="<html>"),
    "not_an_object": lambda _: httpx.Response(200, json=["OK"]),
    "results_not_a_list": lambda _: httpx.Response(200, json={"status": "OK", "results": {}}),
}


@pytest.mark.parametrize("handler", list(FAILURES.values()), ids=list(FAILURES))
async def test_google_client_failures_are_unavailable_without_url_or_key(
    handler: Handler, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(GeocodingUnavailableError) as info:
        await geocoder(handler).reverse(LAT, LNG)

    # The exception, its cause and its context, as a traceback would print them.
    rendered = "".join(traceback.format_exception(info.value))
    assert "GeocodingUnavailableError" in rendered
    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for secret in PII:
        assert secret not in rendered
        assert secret not in output
    [record] = [r for r in caplog.records if r.name == "app.integrations.geocoding"]
    assert record.levelno == logging.ERROR, "a real failure is an incident"
    assert record.message.startswith("geocoding_")


async def test_unconfigured_geocoder_is_unavailable(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG), pytest.raises(GeocodingUnavailableError):
        await UnconfiguredReverseGeocoder().reverse(LAT, LNG)

    [record] = caplog.records
    assert record.message == "geocoding_not_configured"
    assert record.levelno == logging.WARNING


def _dependency_for(app: FastAPI) -> object:
    return get_reverse_geocoder(Request({"type": "http", "app": app}))


def test_dependency_builds_google_client_only_with_a_key() -> None:
    without_key = make_app(make_settings())
    with_key = make_app(make_settings(google_maps_api_key=KEY))

    assert isinstance(_dependency_for(without_key), UnconfiguredReverseGeocoder)
    assert isinstance(_dependency_for(with_key), GoogleReverseGeocoder)
    # One per app, built on first use.
    assert _dependency_for(with_key) is _dependency_for(with_key)


def test_empty_key_means_unset() -> None:
    assert make_settings(google_maps_api_key="").google_maps_api_key is None
    assert make_settings().geocoding_timeout_seconds == 5.0
    assert make_settings().geo_reverse_limit == 30
    assert make_settings().geo_reverse_window_seconds == 600
