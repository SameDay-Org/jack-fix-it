"""GET /v1/service-areas/check: is a ZIP served? (D8.3, #46)."""

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.service_areas.models import ServiceArea
from app.rate_limit import get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings

IP_LIMIT = 4
NOW = 1_000.0
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}


@pytest.fixture
def settings() -> Settings:
    return make_settings(auth_rate_limit_requests=IP_LIMIT)


@pytest.fixture(autouse=True)
def fixed_clock_limiter(app: FastAPI) -> None:
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter


@pytest.fixture
async def areas(db_session: AsyncSession) -> None:
    # Fixture areas only: no real ZIP.
    db_session.add_all(
        [
            ServiceArea(region="Test Region", city="Testville", state="ZZ", zip_code="00001"),
            ServiceArea(
                region="Test Region", city="Testville", state="ZZ", zip_code="00002", active=False
            ),
        ]
    )
    await db_session.flush()


async def check(client: httpx.AsyncClient, zip_code: str) -> httpx.Response:
    return await client.get("/v1/service-areas/check", params={"zip": zip_code})


@pytest.mark.parametrize(
    ("zip_code", "expected"),
    [
        ("00001", {"zip_code": "00001", "served": True}),
        ("00002", {"zip_code": "00002", "served": False}),
        ("00003", {"zip_code": "00003", "served": False}),
        ("00001-1234", {"zip_code": "00001", "served": True}),
    ],
    ids=["active", "inactive", "unknown", "zip_plus_4"],
)
async def test_check_without_auth(
    db_client: httpx.AsyncClient, areas: None, zip_code: str, expected: dict[str, object]
) -> None:
    response = await check(db_client, zip_code)

    assert response.status_code == 200
    assert response.json() == expected


@pytest.mark.parametrize(
    "zip_code",
    ["0001", "000011", "00001-12", "abcde", "".join(chr(0xFF10) for _ in range(5)), ""],
    ids=["short", "long", "bad_plus_4", "letters", "fullwidth", "empty"],
)
async def test_bad_zip_422(db_client: httpx.AsyncClient, zip_code: str) -> None:
    response = await check(db_client, zip_code)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


async def test_missing_zip_422(db_client: httpx.AsyncClient) -> None:
    assert (await db_client.get("/v1/service-areas/check")).status_code == 422


async def test_rate_limited_per_ip(db_client: httpx.AsyncClient, areas: None) -> None:
    for _ in range(IP_LIMIT):
        assert (await check(db_client, "00001")).status_code == 200

    limited = await check(db_client, "00001")

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
