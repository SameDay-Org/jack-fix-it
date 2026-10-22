"""GET /v1/categories: the active catalog, public (D6.1, #36)."""

import logging
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.categories.intake import INTAKE_QUESTIONS
from app.modules.categories.models import Category
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.conftest import InMemoryRateLimiter, make_settings
from tests.test_intake_questions import FIXTURE_QUESTIONS

IP_LIMIT = 3
NOW = 1_000.0


@pytest.fixture
def settings() -> Settings:
    return make_settings(auth_rate_limit_requests=IP_LIMIT)


@pytest.fixture(autouse=True)
def fixed_clock_limiter(app: FastAPI) -> None:
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter


ROOMS = {
    "key": "rooms",
    "type": "integer",
    "required": True,
    "labels": {"en": "Rooms", "es": "Habitaciones"},
    "min": 1,
    "max": 6,
}


def category(
    slug: str,
    *,
    active: bool = True,
    requires_license: bool = False,
    intake_questions: list[dict[str, Any]] | None = None,
) -> Category:
    # Fixture categories only.
    return Category(
        slug=slug,
        names={"en": f"{slug} en", "es": f"{slug} es"},
        icon=f"icon-{slug}",
        requires_license=requires_license,
        reference_price_cents=1234,
        intake_questions=[ROOMS] if intake_questions is None else intake_questions,
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
            "intake_questions": [{**ROOMS, "help": None}],
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


async def test_returns_typed_intake_questions(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    db_session.add(category("test-typed", intake_questions=FIXTURE_QUESTIONS))
    db_session.add(category("test-empty", intake_questions=[]))
    await db_session.flush()

    listed = {c["slug"]: c for c in (await db_client.get("/v1/categories")).json()}

    typed = listed["test-typed"]["intake_questions"]
    assert [(q["key"], q["type"]) for q in typed] == [
        ("rooms", "integer"),
        ("size", "single_choice"),
        ("extras", "multi_choice"),
        ("pets", "boolean"),
        ("notes", "text"),
    ]
    expected = INTAKE_QUESTIONS.validate_python(FIXTURE_QUESTIONS)
    assert typed == INTAKE_QUESTIONS.dump_python(expected, mode="json")
    assert listed["test-empty"]["intake_questions"] == []


async def test_broken_stored_questions_listed_empty_and_logged_by_id(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    # As an admin edit could leave it: an unknown type, carrying text that must not be logged.
    broken = category(
        "test-broken",
        intake_questions=[{"key": "rooms", "type": "number", "labels": {"en": "probe-raw-json"}}],
    )
    db_session.add(broken)
    await db_session.flush()

    with caplog.at_level(logging.INFO):
        response = await db_client.get("/v1/categories")

    assert response.status_code == 200
    [listed] = [c for c in response.json() if c["slug"] == "test-broken"]
    assert listed["intake_questions"] == []
    [record] = [r for r in caplog.records if r.message == "category_intake_invalid"]
    assert record.__dict__["category_id"] == str(broken.id)
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert "probe-raw-json" not in output
    assert "number" not in output


def test_openapi_documents_the_typed_questions(app: FastAPI) -> None:
    schemas = app.openapi()["components"]["schemas"]

    questions = schemas["CategoryOut"]["properties"]["intake_questions"]["items"]
    assert questions["discriminator"]["propertyName"] == "type"
    for name in (
        "IntegerQuestion",
        "SingleChoiceQuestion",
        "MultiChoiceQuestion",
        "BooleanQuestion",
        "TextQuestion",
    ):
        assert schemas[name]["additionalProperties"] is False


async def test_categories_api_returns_option_description_and_icon(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    jobs = {
        "key": "jobs",
        "type": "multi_choice",
        "required": True,
        "labels": {"en": "Jobs", "es": "Trabajos"},
        "options": [
            {
                "value": "walls",
                "labels": {"en": "Walls", "es": "Paredes"},
                "description": {"en": "One or more rooms", "es": "Una o varias habitaciones"},
                "icon": "paint-walls",
            },
            {"value": "other", "labels": {"en": "Other", "es": "Otro"}},
        ],
        "min_selected": 1,
    }
    db_session.add(category("test-illustrated", intake_questions=[jobs]))
    await db_session.flush()

    listed = {c["slug"]: c for c in (await db_client.get("/v1/categories")).json()}

    [question] = listed["test-illustrated"]["intake_questions"]
    walls, other = question["options"]
    assert walls["description"] == {"en": "One or more rooms", "es": "Una o varias habitaciones"}
    assert walls["icon"] == "paint-walls"
    assert (other["description"], other["icon"]) == (None, None)
