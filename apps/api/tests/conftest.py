from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI

from app.config import Settings
from app.main import create_app


def make_settings(**overrides: object) -> Settings:
    """Settings for tests: never reads the developer's .env, never needs a real database."""
    values: dict[str, object] = {
        "app_env": "test",
        "database_url": "postgresql://test:test@localhost:5432/test",
        "redis_url": "redis://localhost:6379/0",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[arg-type]


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    # The lifespan does not run here, so nothing connects to Postgres or Redis;
    # tests that need dependencies override them.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
