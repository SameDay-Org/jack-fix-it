"""GET /v1/categories: the active catalog, public (D6.1, #36)."""

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.categories.models import Category
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


def category(slug: str, *, active: bool = True, requires_license: bool = False) -> Category:
    # Fixture categories only.
    return Category(
        slug=slug,
        names={"en": f"{slug} en", "es": f"{slug} es"},
        icon=f"icon-{slug}",
        requires_license=requires_license,
        reference_price_cents=1234,
        intake_questions=[{"id": "q1"}],
        active=active,
    )


async def test_lists_active_categories_by_slug_without_auth(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    rows = [
        category("test-zeta"),
        category("test-alpha", requires_license=True),
        category("test-off", active=False),
    ]
    db_session.add_all(rows)
    await db_session.flush()
    by_slug = {row.slug: row for row in rows}

    response = await db_client.get("/v1/categories")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": str(by_slug[slug].id),
            "slug": slug,
            "names": {"en": f"{slug} en", "es": f"{slug} es"},
            "icon": f"icon-{slug}",
            "requires_license": slug == "test-alpha",
        }
        for slug in ("test-alpha", "test-zeta")
    ]


async def test_rate_limited_per_ip(db_client: httpx.AsyncClient) -> None:
    for _ in range(IP_LIMIT):
        assert (await db_client.get("/v1/categories")).status_code == 200

    limited = await db_client.get("/v1/categories")

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"


def test_openapi_documents_the_public_catalog(app: FastAPI) -> None:
    paths = app.openapi()["paths"]

    for path in ("/v1/categories", "/v1/service-areas"):
        operation = paths[path]["get"]
        assert {"200", "429"} <= set(operation["responses"])
        assert "security" not in operation
