"""POST /v1/geo/reverse: the address at the device position (D8.2, #215). Never calls Google."""

import json
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.geocoding import (
    GeocodingUnavailableError,
    GoogleReverseGeocoder,
    ResolvedAddress,
    UnconfiguredReverseGeocoder,
    get_reverse_geocoder,
)
from app.modules.auth import security
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.conftest import TEST_JWT_SECRET, InMemoryRateLimiter, make_settings
from tests.test_geocoding_client import (
    CANADA,
    CITY,
    NUMBER,
    ROUTE,
    STATE,
    STREET,
    US,
    ZIP,
    ZIP_PLUS_4,
    google,
    result,
    without,
)

LAT = 26.1224
LNG = -80.1373
POSITION = {"lat": LAT, "lng": LNG}
LIMIT = 3
WINDOW = 600
NOW = 1_000.0
# Fixture values only: no real key, no real ZIP, no real street.
KEY = "test-google-key-not-real"
ACTIVE_ZIP = "00001"
INACTIVE_ZIP = "00002"
ADDRESS = ResolvedAddress(
    line1="123 Test Street", city="Testville", state="FL", zip_code=ACTIVE_ZIP
)
PII = (KEY, "maps.googleapis.com", "26.12", "80.13", "Test Street", "Testville", ACTIVE_ZIP)

VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
INVALID_TOKEN = {
    "error": {
        "code": "invalid_token",
        "message": "The access token is missing, invalid or expired.",
    }
}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_RESOLVED = {
    "error": {
        "code": "location_not_resolved",
        "message": "No street address was found at this location.",
    }
}
UNAVAILABLE = {
    "error": {
        "code": "geocoding_unavailable",
        "message": "Location lookup is unavailable right now. Try again later.",
    }
}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}


@dataclass
class FakeGeocoder:
    address: ResolvedAddress | None = ADDRESS
    error: Exception | None = None
    calls: list[tuple[float, float]] = field(default_factory=list)

    async def reverse(self, lat: float, lng: float) -> ResolvedAddress | None:
        self.calls.append((lat, lng))
        if self.error:
            raise self.error
        return self.address


@dataclass(frozen=True)
class Caller:
    id: uuid.UUID
    headers: dict[str, str]


@pytest.fixture
def settings() -> Settings:
    # The key is passed as None so a GOOGLE_MAPS_API_KEY in the shell never reaches the app.
    return make_settings(
        google_maps_api_key=None, geo_reverse_limit=LIMIT, geo_reverse_window_seconds=WINDOW
    )


@pytest.fixture
def geocoder(app: FastAPI) -> FakeGeocoder:
    fake = FakeGeocoder()
    app.dependency_overrides[get_reverse_geocoder] = lambda: fake
    return fake


@pytest.fixture(autouse=True)
def limiter(app: FastAPI) -> InMemoryRateLimiter:
    # A fixed clock, so no test straddles two rate-limit windows.
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return limiter


@pytest.fixture
async def areas(db_session: AsyncSession) -> None:
    db_session.add_all(
        [
            ServiceArea(region="Test Region", city="Testville", state="FL", zip_code=ACTIVE_ZIP),
            ServiceArea(
                region="Test Region",
                city="Testville",
                state="FL",
                zip_code=INACTIVE_ZIP,
                active=False,
            ),
        ]
    )
    await db_session.flush()


async def make_caller(session: AsyncSession, role: UserRole = UserRole.CUSTOMER) -> Caller:
    user = User(email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role)
    session.add(user)
    await session.flush()
    token = security.create_access_token(
        user_id=user.id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return Caller(id=user.id, headers={"Authorization": f"Bearer {token}"})


async def reverse(
    client: httpx.AsyncClient, caller: Caller, body: dict[str, Any] | str | None = None
) -> httpx.Response:
    """`body` as a string is sent verbatim: JSON text httpx's encoder refuses (NaN, Infinity)."""
    if isinstance(body, str):
        return await client.post(
            "/v1/geo/reverse",
            content=body.encode(),
            headers={**caller.headers, "Content-Type": "application/json"},
        )
    return await client.post(
        "/v1/geo/reverse", json=POSITION if body is None else body, headers=caller.headers
    )


def google_client(handler: Callable[[httpx.Request], httpx.Response]) -> GoogleReverseGeocoder:
    """The real client over a transport that never reaches the network."""
    return GoogleReverseGeocoder(
        api_key=KEY, timeout_seconds=1.0, transport=httpx.MockTransport(handler)
    )


def _raise(error_type: type[httpx.TransportError]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error_type(f"boom {request.url}", request=request)

    return handler


def _status(status: str) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _: httpx.Response(200, json={"status": status, "results": []})


FAILURES: dict[str, Callable[[httpx.Request], httpx.Response]] = {
    "timeout": _raise(httpx.ReadTimeout),
    "network_error": _raise(httpx.ConnectError),
    "http_500": lambda _: httpx.Response(500, text="boom"),
    "request_denied": _status("REQUEST_DENIED"),
    "over_query_limit": _status("OVER_QUERY_LIMIT"),
}


async def test_reverse_returns_parts_and_served(
    db_client: httpx.AsyncClient, db_session: AsyncSession, geocoder: FakeGeocoder, areas: None
) -> None:
    ana = await make_caller(db_session)

    served = await reverse(db_client, ana)
    geocoder.address = ResolvedAddress(
        line1="45 Test Avenue", city="Testville", state="FL", zip_code=INACTIVE_ZIP
    )
    not_served = await reverse(db_client, ana)

    assert served.status_code == 200
    assert served.json() == {
        "line1": "123 Test Street",
        "city": "Testville",
        "state": "FL",
        "zip_code": ACTIVE_ZIP,
        "served": True,
    }
    assert not_served.status_code == 200
    assert not_served.json() == {
        "line1": "45 Test Avenue",
        "city": "Testville",
        "state": "FL",
        "zip_code": INACTIVE_ZIP,
        "served": False,
    }
    assert geocoder.calls == [(LAT, LNG), (LAT, LNG)]


async def test_reverse_trims_zip_plus_four_and_uses_route_without_number(
    db_client: httpx.AsyncClient, db_session: AsyncSession, areas: None
) -> None:
    """Through the real client and its parser: Google's postal_code may carry the +4, and a
    route result has no street number."""
    ana = await make_caller(db_session)
    app = db_client._transport.app  # type: ignore[attr-defined]  # the ASGITransport's app
    client = google_client(lambda _: google("OK", result(ROUTE, CITY, STATE, ZIP_PLUS_4, US)))
    app.dependency_overrides[get_reverse_geocoder] = lambda: client

    response = await reverse(db_client, ana)

    assert response.status_code == 200
    assert response.json() == {
        "line1": "Test Street",
        "city": "Testville",
        "state": "FL",
        "zip_code": ACTIVE_ZIP,
        "served": True,
    }


@pytest.mark.parametrize(
    "response",
    [
        google("ZERO_RESULTS"),
        google("OK", result(NUMBER, ROUTE, CITY, STATE, ZIP, CANADA)),
        google("OK", result(*without(STREET, "postal_code"))),
    ],
    ids=["zero_results", "non_us", "no_postal_code"],
)
async def test_reverse_404_when_unresolved(
    db_client: httpx.AsyncClient, db_session: AsyncSession, response: httpx.Response
) -> None:
    ana = await make_caller(db_session)
    app = db_client._transport.app  # type: ignore[attr-defined]  # the ASGITransport's app
    client = google_client(lambda _: response)
    app.dependency_overrides[get_reverse_geocoder] = lambda: client

    response = await reverse(db_client, ana)

    assert response.status_code == 404
    assert response.json() == NOT_RESOLVED


async def test_reverse_503_without_key(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    # No get_reverse_geocoder override and no GOOGLE_MAPS_API_KEY, as in development and in
    # staging until #14: the app starts, and the lookup answers 503, not 500.
    ana = await make_caller(db_session)

    assert (await db_client.get("/health")).status_code == 200
    response = await reverse(db_client, ana)

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE


@pytest.mark.parametrize("handler", list(FAILURES.values()), ids=list(FAILURES))
async def test_reverse_503_on_provider_failure(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    ana = await make_caller(db_session)
    app = db_client._transport.app  # type: ignore[attr-defined]  # the ASGITransport's app
    client = google_client(handler)
    app.dependency_overrides[get_reverse_geocoder] = lambda: client

    response = await reverse(db_client, ana)

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE


@pytest.mark.parametrize(
    "body",
    [
        {"lat": 90.0001, "lng": LNG},
        {"lat": -90.0001, "lng": LNG},
        {"lat": LAT, "lng": 180.0001},
        {"lat": LAT, "lng": -180.0001},
        f'{{"lat": NaN, "lng": {LNG}}}',
        f'{{"lat": {LAT}, "lng": Infinity}}',
        f'{{"lat": {LAT}, "lng": -Infinity}}',
        {"lat": str(LAT), "lng": LNG},
        {"lat": LAT, "lng": str(LNG)},
        {"lat": True, "lng": LNG},
        {"lat": LAT, "lng": False},
        {"lat": None, "lng": LNG},
        {"lat": LAT, "lng": LNG, "accuracy": 5},
        {"lat": LAT},
        {"lng": LNG},
        {},
    ],
    ids=[
        "lat_over",
        "lat_under",
        "lng_over",
        "lng_under",
        "nan",
        "inf",
        "neg_inf",
        "lat_string",
        "lng_string",
        "lat_bool",
        "lng_bool",
        "lat_null",
        "extra_field",
        "missing_lng",
        "missing_lat",
        "empty",
    ],
)
async def test_reverse_validation(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    geocoder: FakeGeocoder,
    body: dict[str, Any] | str,
) -> None:
    ana = await make_caller(db_session)

    response = await reverse(db_client, ana, body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert geocoder.calls == []


async def test_reverse_accepts_integer_coordinates(
    db_client: httpx.AsyncClient, db_session: AsyncSession, geocoder: FakeGeocoder, areas: None
) -> None:
    ana = await make_caller(db_session)

    response = await reverse(db_client, ana, {"lat": 26, "lng": -80})

    assert response.status_code == 200
    assert geocoder.calls == [(26.0, -80.0)]


async def test_reverse_auth(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    geocoder: FakeGeocoder,
    limiter: InMemoryRateLimiter,
) -> None:
    anonymous = await db_client.post("/v1/geo/reverse", json=POSITION)
    assert anonymous.status_code == 401
    assert anonymous.json() == INVALID_TOKEN

    for role in (UserRole.PRO, UserRole.AGENT, UserRole.ADMIN):
        caller = await make_caller(db_session, role)
        response = await reverse(db_client, caller)
        assert response.status_code == 403, role
        assert response.json() == FORBIDDEN
    assert geocoder.calls == []
    assert not limiter.counts, "a refused caller is never counted"


async def test_reverse_rate_limited(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    geocoder: FakeGeocoder,
    limiter: InMemoryRateLimiter,
    areas: None,
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)

    responses = [await reverse(db_client, ana) for _ in range(LIMIT + 1)]
    other = await reverse(db_client, bruno)

    assert [r.status_code for r in responses] == [200] * LIMIT + [429]
    assert responses[-1].json() == RATE_LIMITED
    # The window is [600, 1200) at NOW=1000: 200 seconds left.
    assert responses[-1].headers["Retry-After"] == "200"
    assert other.status_code == 200, "one customer's limit is not another's"
    assert len(geocoder.calls) == LIMIT + 1
    # The limiter key holds the scope, the user id and the window: never the position.
    assert set(limiter.counts) == {
        f"geo_reverse:{ana.id}:{int(NOW // WINDOW)}",
        f"geo_reverse:{bruno.id}:{int(NOW // WINDOW)}",
    }
    for key in limiter.counts:
        for secret in PII:
            assert secret not in key


async def test_reverse_logs_no_pii(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    geocoder: FakeGeocoder,
    limiter: InMemoryRateLimiter,
    areas: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await make_caller(db_session)
    app = db_client._transport.app  # type: ignore[attr-defined]  # the ASGITransport's app
    caplog.clear()

    async def call(body: dict[str, Any] | None = None) -> int:
        limiter.counts.clear()  # every path below gets its own turn within the limit
        return (await reverse(db_client, ana, body)).status_code

    with caplog.at_level(logging.DEBUG):
        assert await call() == 200
        geocoder.address = None
        assert await call() == 404
        geocoder.error = GeocodingUnavailableError()
        assert await call() == 503
        assert await call({"lat": "x", "lng": LNG}) == 422
        app.dependency_overrides[get_reverse_geocoder] = UnconfiguredReverseGeocoder
        assert await call() == 503
        for handler in FAILURES.values():
            client = google_client(handler)
            app.dependency_overrides[get_reverse_geocoder] = lambda client=client: client
            assert await call() == 503
        # Past the limit: the position is in the request, never in the limiter or its log.
        statuses = [(await reverse(db_client, ana)).status_code for _ in range(LIMIT + 1)]
        assert statuses[-1] == 429

    messages = {record.message for record in caplog.records}
    assert {
        "geo_reverse_resolved",
        "geo_reverse_unresolved",
        "geo_reverse_unavailable",
        "geocoding_not_configured",
        "geocoding_unreachable",
        "geocoding_failed",
    } <= messages
    formatter = JsonFormatter()
    payloads = [json.loads(formatter.format(record)) for record in caplog.records]
    for payload in payloads:
        # The request id and the timestamp are random digits that could spell a fixture ZIP.
        payload.pop("request_id", None)
        payload.pop("timestamp", None)
    output = "\n".join(json.dumps(payload) for payload in payloads)
    for secret in (*PII, str(LAT), str(LNG), "googleapis"):
        assert secret not in output
    for record, payload in zip(caplog.records, payloads, strict=True):
        if record.message.startswith("geo_reverse_"):
            assert set(payload) - {"level", "logger", "message"} <= {"user_id", "served"}
            assert payload["user_id"] == str(ana.id)
