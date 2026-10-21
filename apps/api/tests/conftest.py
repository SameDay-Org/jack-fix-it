import asyncio
import time
from collections import Counter
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from sqlalchemy import URL, make_url, pool, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config import Settings
from app.db import get_session
from app.main import create_app
from app.rate_limit import RateLimitResult, get_rate_limiter, window_position

API_DIR = Path(__file__).resolve().parents[1]
# Fixture value only; real secrets live in Railway variables.
TEST_JWT_SECRET = "test-jwt-secret-not-for-real-use-0123456789"
# Fixture values only: a dummy endpoint (.invalid never resolves) and fake credentials. Signing is
# local, so nothing reaches a network.
TEST_STORAGE_SETTINGS: dict[str, object] = {
    "s3_endpoint_url": "https://storage.example.invalid",
    "s3_bucket": "jack-test-bucket",
    "s3_access_key_id": "test-access-key-id",
    "s3_secret_access_key": "test-secret-access-key-not-real",
}


def make_settings(**overrides: object) -> Settings:
    """Settings for tests: never reads the developer's .env, never needs a real database."""
    values: dict[str, object] = {
        "app_env": "test",
        "database_url": "postgresql://test:test@localhost:5432/test",
        "redis_url": "redis://localhost:6379/0",
        "jwt_secret": TEST_JWT_SECRET,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[arg-type]


class InMemoryRateLimiter:
    """Test-only RateLimiter: the same fixed windows as RedisRateLimiter, kept in a Counter."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self.counts: Counter[str] = Counter()

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        index, retry_after = window_position(self.clock(), window_seconds)
        key = f"{scope}:{identifier}:{index}"
        self.counts[key] += 1
        return RateLimitResult(allowed=self.counts[key] <= limit, retry_after_seconds=retry_after)


def make_app(settings: Settings) -> FastAPI:
    """create_app with an in-memory rate limiter: the lifespan, which creates Redis, never runs."""
    app = create_app(settings)
    limiter = InMemoryRateLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return app


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return make_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    # The lifespan does not run here, so nothing connects to Postgres or Redis;
    # tests that need dependencies override them.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


async def _create_database_if_missing(url: URL) -> None:
    # CREATE DATABASE cannot run inside a transaction, hence AUTOCOMMIT.
    engine = create_async_engine(
        url.set(database="postgres"), isolation_level="AUTOCOMMIT", poolclass=pool.NullPool
    )
    try:
        async with engine.connect() as connection:
            exists = await connection.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": url.database}
            )
            if not exists:
                name = connection.dialect.identifier_preparer.quote(str(url.database))
                await connection.execute(text(f"CREATE DATABASE {name}"))
    finally:
        await engine.dispose()


@pytest.fixture(scope="session")
def test_database_url() -> URL:
    """<dbname>_test next to DATABASE_URL's database, created and migrated to head once.

    Sync on purpose: alembic/env.py runs its own event loop. The dev database is never written.
    """
    url = make_url(Settings().database_url)
    url = url.set(database=f"{url.database}_test")
    asyncio.run(_create_database_if_missing(url))

    # No ini file, so alembic/env.py does not reconfigure logging for the test run.
    config = Config()
    config.set_main_option("script_location", str(API_DIR / "alembic"))
    config.attributes["database_url"] = url.render_as_string(hide_password=False)
    command.upgrade(config, "head")
    return url


@pytest.fixture
async def db_client(app: FastAPI, db_session: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    """The HTTP client with get_session replaced by the rolled-back test session."""

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
    app.dependency_overrides.pop(get_session, None)


@pytest.fixture
async def db_session(test_database_url: URL) -> AsyncIterator[AsyncSession]:
    """A session inside an outer transaction that is rolled back after the test.

    Commits inside the test only release a savepoint, so no row outlives the test.
    """
    engine = create_async_engine(test_database_url, poolclass=pool.NullPool)
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            session = AsyncSession(
                bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False
            )
            try:
                yield session
            finally:
                await session.close()
                await transaction.rollback()
    finally:
        await engine.dispose()
