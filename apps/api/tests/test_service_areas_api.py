"""GET /v1/service-areas: the served areas, public and grouped (D6.1, #36)."""

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.service_areas.models import ServiceArea
from app.rate_limit import get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings

IP_LIMIT = 3
NOW = 1_000.0


@pytest.fixture
def settings() -> Settings:
    return make_settings(auth_rate_limit_requests=IP_LIMIT)


@pytest.fixture(autouse=True)
def fixed_clock_limiter(app: FastAPI) -> None:
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter


async def add_areas(session: AsyncSession) -> dict[str, ServiceArea]:
    # Fixture areas only: no real region, city or ZIP. Inserted out of order on purpose.
    rows = [
        ServiceArea(region="Region B", city="Beta", state="YY", zip_code="00005"),
        ServiceArea(region="Region A", city="Alpha", state="ZZ", zip_code="00002"),
        ServiceArea(region="Region A", city="Alpha", state="ZZ", zip_code="00001"),
        ServiceArea(region="Region A", city="Aardvark", state="ZZ", zip_code="00003"),
        ServiceArea(region="Region A", city="Alpha", state="ZZ", zip_code="00004", active=False),
    ]
    session.add_all(rows)
    await session.flush()
    return {row.zip_code: row for row in rows}


async def test_lists_active_areas_grouped_without_auth(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    areas = await add_areas(db_session)

    response = await db_client.get("/v1/service-areas")

    def zip_out(zip_code: str) -> dict[str, str]:
        return {"id": str(areas[zip_code].id), "zip_code": zip_code}

    assert response.status_code == 200
    assert response.json() == [
        {
            "region": "Region A",
            "cities": [
                {"city": "Aardvark", "state": "ZZ", "zips": [zip_out("00003")]},
                {"city": "Alpha", "state": "ZZ", "zips": [zip_out("00001"), zip_out("00002")]},
            ],
        },
        {
            "region": "Region B",
            "cities": [{"city": "Beta", "state": "YY", "zips": [zip_out("00005")]}],
        },
    ]


async def test_no_areas_is_an_empty_list(db_client: httpx.AsyncClient) -> None:
    response = await db_client.get("/v1/service-areas")

    assert response.status_code == 200
    assert response.json() == []


async def test_rate_limited_per_ip(db_client: httpx.AsyncClient) -> None:
    for _ in range(IP_LIMIT):
        assert (await db_client.get("/v1/service-areas")).status_code == 200

    limited = await db_client.get("/v1/service-areas")

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert int(limited.headers["Retry-After"]) >= 1
