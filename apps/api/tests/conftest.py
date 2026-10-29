import asyncio
import time
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Request
from sqlalchemy import URL, delete, make_url, pool, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.db import Base, get_session
from app.main import create_app
from app.modules.auth.models import RefreshToken
from app.modules.users.models import User
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
# Fixture values only, never real Twilio credentials; tests never call Twilio.
TEST_TWILIO_SETTINGS: dict[str, object] = {
    "twilio_account_sid": "ACtest00000000000000000000000000",
    "twilio_auth_token": "test-twilio-auth-token-not-real",
    "twilio_verify_service_sid": "VAtest00000000000000000000000000",
}
# Fixture value only. make_settings leaves it unset, so tests use the development key unless
# a test sets it; deployed settings must have one.
TEST_RATE_LIMIT_SETTINGS: dict[str, object] = {
    "rate_limit_key_secret": "test-rate-limit-key-secret-not-real-0123",
}
# Fixture value only. make_settings leaves it unset, so tests use the development rotation key
# unless a test sets it; deployed settings must have one (#152).
TEST_REFRESH_SETTINGS: dict[str, object] = {
    "refresh_rotation_secret": "test-refresh-rotation-secret-not-real-01",
}
# Fixture values only: a fake key, and a sender on a domain that never resolves. Tests never
# call Resend.
TEST_EMAIL_SETTINGS: dict[str, object] = {
    "resend_api_key": "re_test_key_not_real",
    "email_from": "Jack Fix It <no-reply@example.invalid>",
}
# Fixture values only: a test-mode-shaped key that is not a key (tests never call Stripe), and
# a public URL that never resolves.
TEST_STRIPE_SETTINGS: dict[str, object] = {
    "stripe_secret_key": "sk_test_fixture-not-a-real-key",
    "public_api_url": "https://api.example.invalid",
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
            name = connection.dialect.identifier_preparer.quote(str(url.database))
            if not exists:
                await connection.execute(text(f"CREATE DATABASE {name}"))
            # The test database alone accepts the fixtures' wildcard status token (#163,
            # tests/helpers.py::as_status_writer); connections opened from now on see it.
            await connection.execute(
                text(f"ALTER DATABASE {name} SET app.status_writer_fixtures = 'on'")
            )
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


async def _rolled_back_session(request: Request) -> AsyncIterator[AsyncSession]:
    """db_client's get_session: the test's session, which the fixture puts on the app's state.
    One function for every test on purpose: FastAPI caches each dependency callable it calls
    (4096 entries), so a closure per test kept each test's session, connection, engine and
    dialect alive long after the test (#196)."""
    session: AsyncSession = request.app.state.rolled_back_session
    yield session


@pytest.fixture
async def db_client(app: FastAPI, db_session: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    """The HTTP client with get_session replaced by the rolled-back test session."""
    app.state.rolled_back_session = db_session
    app.dependency_overrides[get_session] = _rolled_back_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
    app.dependency_overrides.pop(get_session, None)
    del app.state.rolled_back_session


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
        # Each flush's compiled INSERT and UPDATE is cached on the mapper, keyed by the
        # engine's dialect. A new engine per test means a new dialect, so the entries can never
        # be hit again, yet each mapper kept ~150 of them with the dialects they hold (#196).
        for mapper in Base.registry.mappers:
            mapper._compiled_cache.clear()


# Real commits on separate connections: the rolled-back db_session cannot show either.


@dataclass(frozen=True)
class Committed:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    email: str


@pytest.fixture
async def committed(app: FastAPI, test_database_url: URL) -> AsyncIterator[Committed]:
    """The app with one real session per request on the test database; rows are committed.

    Uses its own user and deletes it, with its tokens, afterwards.
    """
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app.state.session_factory = sessions
    email = f"refresh-{uuid.uuid4().hex}@example.com"
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield Committed(client=client, sessions=sessions, email=email)
    finally:
        async with sessions() as session:
            user_ids = select(User.id).where(User.email == email).scalar_subquery()
            await session.execute(delete(RefreshToken).where(RefreshToken.user_id.in_(user_ids)))
            await session.execute(delete(User).where(User.email == email))
            await session.commit()
        await engine.dispose()


LOCK_WAIT_DEADLINE_SECONDS = 5


async def backend_pid(session: AsyncSession) -> int:
    """The Postgres backend of the session's connection, which runs the request's transaction."""
    pid = await session.scalar(text("SELECT pg_backend_pid()"))
    assert isinstance(pid, int)
    return pid


async def wait_until_blocked(
    sessions: async_sessionmaker[AsyncSession], *, waiter: int, holder: int
) -> None:
    """Returns once Postgres reports backend `waiter` waiting on a lock `holder` holds.

    Each poll is the query itself, on its own connection; fails after the deadline.
    """
    query = text("SELECT CAST(:holder AS integer) = ANY(pg_blocking_pids(:waiter))")
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not await monitor.scalar(query, {"holder": holder, "waiter": waiter}):
                    pass
        except TimeoutError:
            pytest.fail(
                f"backend {waiter} never waited on a lock of backend {holder} "
                f"within {LOCK_WAIT_DEADLINE_SECONDS} s"
            )


@pytest.fixture
async def silent_redis_url() -> AsyncIterator[str]:
    """A TCP server that accepts connections and never answers: a hung Redis."""
    connections: list[asyncio.StreamWriter] = []

    async def accept(_: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connections.append(writer)

    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"redis://127.0.0.1:{port}/0"
    finally:
        for writer in connections:
            writer.close()
        server.close()
        await server.wait_closed()
