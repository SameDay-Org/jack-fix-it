import asyncio

import httpx
import pytest
from fastapi import FastAPI

from app.main import create_app
from app.modules.health.router import get_dependency_probes
from app.modules.health.service import DependencyProbes
from tests.conftest import make_settings


class FakeProbes:
    def __init__(self, *, database_ok: bool = True, redis_ok: bool = True) -> None:
        self.database_ok = database_ok
        self.redis_ok = redis_ok

    async def database(self) -> None:
        if not self.database_ok:
            raise ConnectionError("database down")

    async def redis(self) -> None:
        if not self.redis_ok:
            raise ConnectionError("redis down")


class HangingDatabaseProbes(FakeProbes):
    async def database(self) -> None:
        await asyncio.Event().wait()


def use_probes(app: FastAPI, probes: DependencyProbes) -> None:
    app.dependency_overrides[get_dependency_probes] = lambda: probes


async def test_liveness_needs_no_dependencies(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_readiness_ok_when_database_and_redis_answer(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    use_probes(app, FakeProbes())

    response = await client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok", "redis": "ok"}}


@pytest.mark.parametrize(
    ("probes", "expected_checks"),
    [
        (FakeProbes(database_ok=False), {"database": "fail", "redis": "ok"}),
        (FakeProbes(redis_ok=False), {"database": "ok", "redis": "fail"}),
        (FakeProbes(database_ok=False, redis_ok=False), {"database": "fail", "redis": "fail"}),
    ],
)
async def test_readiness_503_when_a_dependency_fails(
    app: FastAPI,
    client: httpx.AsyncClient,
    probes: FakeProbes,
    expected_checks: dict[str, str],
) -> None:
    use_probes(app, probes)

    response = await client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "checks": expected_checks}


async def test_readiness_503_when_a_dependency_does_not_answer_in_time() -> None:
    app = create_app(make_settings(health_check_timeout_seconds=0.01))
    use_probes(app, HangingDatabaseProbes())
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {"database": "fail", "redis": "ok"}


async def test_readiness_failure_does_not_leak_driver_messages(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    use_probes(app, FakeProbes(database_ok=False))

    response = await client.get("/health/ready")

    assert "database down" not in response.text


def test_openapi_documents_both_readiness_outcomes(app: FastAPI) -> None:
    responses = app.openapi()["paths"]["/health/ready"]["get"]["responses"]

    assert responses["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ReadinessResponse"
    }
    assert responses["503"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ReadinessResponse"
    }
