"""The API and its worker, run inside the seed's own process.

The seed drives the real application: every request below goes through the routers, the
services, the state machines and the database guard, exactly as the apps' calls do. Only the
edges are swapped, at the seams the API's tests use:

- the worker: what a route queues is kept (`InlineQueue`) and `World.drain` runs the same task
  functions `app/worker.py` registers, in order. Pushes and geocoding are dropped (no device
  hears about a seeded job; Mapbox is billed per call);
- the rate limits: none (the seed registers dozens of accounts from one address);
- the pros' live positions: kept in memory (the seed pings none: a job it leaves on the
  way has no position yet);
- Stripe: the stand-ins (stripe_standins.py) or the TEST gateway (stripe_test.py), switched
  with `World.use`. The payment call answers 503 without a publishable key, and the seed
  never shows a Payment Sheet: on a machine with no Stripe keys this app (never the running
  API) gets a stand-in one, so the history can still be paid through the stand-ins.

Nothing here connects to Redis, so the seed never touches the running stack's queue.
"""

import uuid
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
from arq.worker import Retry
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.config import Settings
from app.db import create_engine, create_session_factory
from app.integrations.storage import Storage
from app.integrations.stripe_payments import StripePayments
from app.integrations.stripe_refunds import StripeRefunds
from app.integrations.stripe_transfers import StripeTransfers
from app.main import create_app
from app.modules.auth import security
from app.modules.jobs.location import Position, get_job_location_store
from app.modules.users.types import UserRole
from app.rate_limit import RateLimitResult, get_rate_limiter
from app.worker import WorkerSettings
from demo_seed import guard

# Queued by the API and not run by the seed: no device should hear about a seeded job, a
# geocode is a billed Mapbox call, and Stripe's events are applied by the seed itself.
DROPPED_TASKS: Final = frozenset({"send_push", "geocode_address", "ping"})
# A safe-copy task asks for another try while a file's copy is still running elsewhere; inline
# there is no elsewhere, so a second ask is a failure.
MAX_TASK_TRIES: Final = 3
# Not a key: the shape the payment call checks, for this app when the settings have none.
STAND_IN_PUBLISHABLE_KEY: Final = "pk_test_demoStandInNotAKey"
# The seed's own access tokens: long enough for the slowest run.
TOKEN_TTL_SECONDS: Final = 4 * 3600

TaskFunction = Callable[..., Awaitable[object]]


class SeedError(RuntimeError):
    """The seed could not go on; the message says which step and what the API answered."""


@dataclass(frozen=True)
class Actor:
    """An account the seed acts as: its id, role and bearer headers."""

    user_id: uuid.UUID
    role: UserRole
    email: str
    headers: dict[str, str]


@dataclass(frozen=True)
class Gateways:
    """The three Stripe ports a paid job crosses."""

    payments: StripePayments
    transfers: StripeTransfers
    refunds: StripeRefunds


class InlineQueue:
    """Stands in for the ARQ pool (app.queue.JobQueue): keeps what the API queues."""

    def __init__(self) -> None:
        self.pending: deque[tuple[str, tuple[Any, ...]]] = deque()

    async def enqueue_job(
        self, function: str, *args: Any, _job_id: str | None = None, **_: Any
    ) -> object:
        self.pending.append((function, args))
        return function


class NoRateLimit:
    """app.rate_limit.RateLimiter: every hit allowed."""

    async def hit(
        self, scope: str, identifier: str, *, limit: int, window_seconds: int
    ) -> RateLimitResult:
        return RateLimitResult(allowed=True, retry_after_seconds=0)


class MemoryLocations:
    """app.modules.jobs.location.JobLocationStore, in memory: the state machine needs a store
    to leave on_the_way, and the seed pings no position."""

    def __init__(self) -> None:
        self._positions: dict[uuid.UUID, Position] = {}

    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        self._positions[job_id] = position
        return True

    async def get(self, job_id: uuid.UUID) -> Position | None:
        return self._positions.get(job_id)

    async def delete(self, job_id: uuid.UUID) -> None:
        self._positions.pop(job_id, None)


class MemoryCopyClaims:
    """app.modules.media.copy_store.MediaCopyStore, in memory: one run at a time here, so a
    claim is always free."""

    async def claim(self, key: str) -> str | None:
        return uuid.uuid4().hex

    async def release(self, key: str, token: str) -> None:
        return None

    async def held(self, keys: Sequence[str]) -> set[str]:
        return set()

    async def last_queued(self, kind: str, keys: Sequence[str]) -> dict[str, float]:
        return {}

    async def record_queued(
        self, kind: str, keys: Sequence[str], at: float, keep_seconds: int
    ) -> None:
        return None


class World:
    """The app, an HTTP client on it, its queue and the worker's context."""

    def __init__(
        self,
        settings: Settings,
        engine: AsyncEngine,
        app: FastAPI,
        http: httpx.AsyncClient,
        storage: Storage,
        gateways: Gateways,
    ) -> None:
        self.settings = settings
        self.engine = engine
        self.sessions: async_sessionmaker[AsyncSession] = app.state.session_factory
        self.app = app
        self.http = http
        self.storage = storage
        self.queue: InlineQueue = app.state.redis
        self._tasks: dict[str, TaskFunction] = {
            function.name: function.coroutine for function in WorkerSettings.functions
        }
        self._context: dict[str, Any] = {
            "settings": settings,
            "engine": engine,
            "session_factory": self.sessions,
            "redis": self.queue,
            "storage": storage,
            "media_copy_store": MemoryCopyClaims(),
            "push_sender": None,
            "job_try": 1,
        }
        self.use(gateways)

    def use(self, gateways: Gateways) -> None:
        """The Stripe ports the API and the worker's tasks call from now on."""
        self.gateways = gateways
        self.app.state.stripe_payments = gateways.payments
        self.app.state.stripe_refunds = gateways.refunds
        self._context["stripe_payments"] = gateways.payments
        self._context["stripe_transfers"] = gateways.transfers

    def actor(self, user_id: uuid.UUID, role: UserRole, email: str) -> Actor:
        """An account as the seed calls the API for it: its own access token, signed with the
        local JWT secret, so a long run never meets an expired one. It names no session (no
        `sid`, #161): a rerun reads the accounts back without logging in. Such a token is
        accepted until `sid` is required (#161's contract step), which gives the seed sessions."""
        secret = self.settings.jwt_secret
        if secret is None:
            raise SeedError("JWT_SECRET is not set: the API could not sign a session either")
        token = security.create_access_token(
            user_id=user_id,
            role=role,
            session_id=None,
            secret=secret.get_secret_value(),
            ttl_seconds=TOKEN_TTL_SECONDS,
            now=datetime.now(UTC),
        )
        return Actor(user_id, role, email, {"Authorization": f"Bearer {token}"})

    async def call(
        self,
        actor: Actor | None,
        method: str,
        path: str,
        *,
        json: object | None = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        expect: int | tuple[int, ...] = (200, 201, 202, 204),
        what: str,
    ) -> Any:
        """One API call; the parsed body. Any status outside `expect` stops the seed, naming
        the step and the API's error code (never a token)."""
        sent = {**(actor.headers if actor else {}), **(headers or {})}
        response = await self.http.request(method, path, json=json, params=params, headers=sent)
        allowed = (expect,) if isinstance(expect, int) else expect
        if response.status_code not in allowed:
            raise SeedError(f"{what}: {method} {path} -> {response.status_code} {_error(response)}")
        return response.json() if response.content else None

    async def drain(self) -> None:
        """Runs everything the API queued, as the worker would, until the queue is empty."""
        while self.queue.pending:
            name, args = self.queue.pending.popleft()
            if name in DROPPED_TASKS:
                continue
            task = self._tasks.get(name)
            if task is None:
                raise SeedError(f"the API queued a task the seed does not know: {name}")
            for attempt in range(1, MAX_TASK_TRIES + 1):
                try:
                    await task({**self._context, "job_try": attempt}, *args)
                    break
                except Retry:
                    if attempt == MAX_TASK_TRIES:
                        raise SeedError(f"task {name} kept asking for a retry") from None

    async def run(self, cron: Callable[[dict[str, Any]], Awaitable[object]]) -> None:
        """One run of a worker cron (the quote expiry sweep, the 48 h auto-confirm), now."""
        await cron(dict(self._context))

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.sessions() as session:
            yield session


def _error(response: httpx.Response) -> str:
    """The API's error code and message (`{"error": {"code", "message"}}`), else the status."""
    try:
        error = response.json().get("error", {})
    except ValueError:
        return ""
    return f"{error.get('code', '')}: {error.get('message', '')}".strip(": ")


@asynccontextmanager
async def open_world(
    settings: Settings, storage: Storage, gateways: Gateways
) -> AsyncIterator[World]:
    """The app on `settings`' database, with the seed's edges in place. The lifespan never
    runs: it would connect to Redis. Every run comes through here, so the guard is checked
    here too, whatever the caller did."""
    guard.check_settings(settings)
    if settings.stripe_publishable_key is None:
        settings = settings.model_copy(update={"stripe_publishable_key": STAND_IN_PUBLISHABLE_KEY})
    app = create_app(settings)
    engine = create_engine(settings)
    app.state.engine = engine
    app.state.session_factory = create_session_factory(engine)
    app.state.redis = InlineQueue()
    app.state.storage = storage
    app.state.location_backend = None
    limiter = NoRateLimit()
    locations = MemoryLocations()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    app.dependency_overrides[get_job_location_store] = lambda: locations
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=True)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://demo.seed") as http:
            yield World(settings, engine, app, http, storage, gateways)
    finally:
        await engine.dispose()
