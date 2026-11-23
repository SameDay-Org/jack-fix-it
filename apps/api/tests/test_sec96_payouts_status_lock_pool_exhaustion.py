"""#96 skeptic repro (payouts-status-lock-pool-exhaustion): one self-registered pro floods
GET /v1/pros/me/payouts. Each call takes the pro's profile row FOR UPDATE and keeps it, and its
pooled connection, across Stripe's retrieve_account; the route has no rate limit. Overlapping
calls for that pro therefore run one Stripe read at a time while every other one holds a pooled
connection idle on the row lock, so the production pool (create_engine: 5 + 10 overflow, 30 s
timeout) serves the whole API at one request per Stripe round trip.

The secure property: an unrelated anonymous request (GET /v1/categories) still answers within
the mobile client's default timeout (DEFAULT_TIMEOUT_MS, 15 s) while one pro has many status
calls in flight. The control test drops only the row lock (monkeypatched to lock=False): the
same flood then leaves the unrelated request fast, which pins the cause on the lock held across
the Stripe call plus the missing limit, not on generic load.

Rows are committed on the test database and deleted afterwards. Stripe is a fake with a
realistic round trip (STRIPE_LATENCY_SECONDS) after a start gate that lines the flood up.

Moved into the suite with #524. The line-up no longer waits for the queue develop built (one
Stripe read, 14 connections on the lock): it waits, up to its deadline, for every call past the
per-pro limit to be refused and every admitted one to be inside its Stripe read, then checks the
same property, plus that no pooled connection and no lock waiter is left over the Stripe reads.
The control test (only the lock removed) proved the cause on develop; its run is in
handoffs/96-repros/payouts-status-lock-pool-exhaustion.out.txt, and with the lock gone it has
nothing left to compare."""

import asyncio
import time
import uuid
from collections import Counter
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import URL, delete, pool, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.db import create_engine, create_session_factory
from app.integrations.stripe_connect import AccountState, StripeConnect, get_stripe_connect
from app.modules.auth import security
from app.modules.pros.models import ProProfile
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.conftest import TEST_JWT_SECRET, make_settings

STATUS = "/v1/pros/me/payouts"
CATEGORIES = "/v1/categories"
# Stripe's accounts.retrieve round trip is typically a few hundred ms; 0.2 s is conservative.
STRIPE_LATENCY_SECONDS = 0.2
ATTACKER_REQUESTS = 120
# apps/mobile/src/api/config.ts DEFAULT_TIMEOUT_MS: the app gives up after this.
VICTIM_BUDGET_SECONDS = 15.0
SETUP_DEADLINE_SECONDS = 10.0
LINE_UP_POLL_SECONDS = 0.02
DUE = AccountState(details_submitted=True, payouts_enabled=False, requirements_due=True)


class SlowStripe:
    """retrieve_account waits for `gate`, then answers after one realistic round trip."""

    def __init__(self) -> None:
        self.gate = asyncio.Event()
        self.calls = 0
        self.in_flight = 0
        self.peak_in_flight = 0

    async def retrieve_account(self, account_id: str) -> AccountState:
        self.calls += 1
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        try:
            await self.gate.wait()
            await asyncio.sleep(STRIPE_LATENCY_SECONDS)
            return DUE
        finally:
            self.in_flight -= 1


def _slow_stripe(request: Request) -> StripeConnect:
    fake: StripeConnect = request.app.state.sec96_stripe
    return fake


@dataclass(frozen=True)
class World:
    app: FastAPI
    engine: AsyncEngine
    monitor: AsyncEngine
    headers: dict[str, str]
    stripe: SlowStripe


@pytest.fixture
async def world(app: FastAPI, test_database_url: URL) -> AsyncIterator[World]:
    # The production engine factory (app/db.py) on the test database: the default pool.
    engine = create_engine(
        make_settings(database_url=test_database_url.render_as_string(hide_password=False))
    )
    monitor = create_async_engine(test_database_url, poolclass=pool.NullPool)
    sessions = create_session_factory(engine)
    app.state.session_factory = sessions
    stripe = SlowStripe()
    app.state.sec96_stripe = stripe
    app.dependency_overrides[get_stripe_connect] = _slow_stripe
    async with sessions() as session:
        user = User(
            email=f"pro-sec96-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO
        )
        session.add(user)
        await session.flush()
        session.add(ProProfile(user_id=user.id, stripe_account_id=f"acct_sec96{uuid.uuid4().hex}"))
        await session.commit()
        user_id = user.id
    token = security.create_access_token(
        user_id=user_id,
        role=UserRole.PRO,
        session_id=None,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    try:
        yield World(app, engine, monitor, {"Authorization": f"Bearer {token}"}, stripe)
    finally:
        app.dependency_overrides.pop(get_stripe_connect, None)
        async with monitor.connect() as connection:
            await connection.execute(delete(ProProfile).where(ProProfile.user_id == user_id))
            await connection.execute(delete(User).where(User.id == user_id))
            await connection.commit()
        await engine.dispose()
        await monitor.dispose()


@dataclass(frozen=True)
class Outcome:
    pool_capacity: int
    checked_out_before_release: int
    stripe_in_flight_before_release: int
    lock_waiters_before_release: int
    victim_status: int
    victim_seconds: float
    attacker_statuses: Counter[int]

    def describe(self) -> str:
        return (
            f"pool {self.checked_out_before_release}/{self.pool_capacity} connections held by one "
            f"pro's status calls while {self.stripe_in_flight_before_release} Stripe read(s) ran "
            f"and {self.lock_waiters_before_release} connection(s) idled on the row lock; "
            f"unrelated GET {CATEGORIES} answered {self.victim_status} after "
            f"{self.victim_seconds:.1f} s; attacker statuses {dict(self.attacker_statuses)}"
        )


async def _lock_waiters(monitor: AsyncEngine) -> int:
    async with monitor.connect() as connection:
        count = await connection.scalar(
            text(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                "AND wait_event_type = 'Lock' AND query ILIKE '%pro_profiles%FOR UPDATE%'"
            )
        )
    assert isinstance(count, int)
    return count


async def _flood(world: World) -> Outcome:
    capacity = world.engine.pool.size() + world.engine.pool._max_overflow  # type: ignore[attr-defined]
    admitted = min(ATTACKER_REQUESTS, world.app.state.settings.payouts_status_limit)
    transport = httpx.ASGITransport(app=world.app, raise_app_exceptions=False)
    async with (
        httpx.AsyncClient(transport=transport, base_url="http://testserver") as attacker,
        httpx.AsyncClient(transport=transport, base_url="http://testserver") as victim,
    ):
        flood = [
            asyncio.create_task(attacker.get(STATUS, headers=world.headers))
            for _ in range(ATTACKER_REQUESTS)
        ]
        # Line the flood up: the calls past the limit refused, the admitted ones inside their
        # Stripe read. Develop never gets there (one read at a time, the rest on the lock), so
        # the deadline ends the wait instead of failing it, and the asserts below say why.
        for _ in range(int(SETUP_DEADLINE_SECONDS / LINE_UP_POLL_SECONDS)):
            if world.stripe.in_flight == admitted and (
                sum(task.done() for task in flood) == ATTACKER_REQUESTS - admitted
            ):
                break
            await asyncio.sleep(LINE_UP_POLL_SECONDS)
        await asyncio.sleep(0.2)
        checked_out = world.engine.pool.checkedout()  # type: ignore[attr-defined]
        in_flight = world.stripe.in_flight
        waiters = await _lock_waiters(world.monitor)

        started = time.monotonic()
        unrelated = asyncio.create_task(victim.get(CATEGORIES))
        await asyncio.sleep(0.05)
        world.stripe.gate.set()
        answer = await unrelated
        victim_seconds = time.monotonic() - started
        responses = await asyncio.gather(*flood)
    return Outcome(
        pool_capacity=capacity,
        checked_out_before_release=checked_out,
        stripe_in_flight_before_release=in_flight,
        lock_waiters_before_release=waiters,
        victim_status=answer.status_code,
        victim_seconds=victim_seconds,
        attacker_statuses=Counter(response.status_code for response in responses),
    )


async def test_one_pro_flooding_payout_status_does_not_starve_other_users(world: World) -> None:
    """Failed on develop: 14 of 15 pooled connections sat on the row lock behind one Stripe
    read, so the unrelated request waited behind the whole queue, and no status call was
    refused."""
    outcome = await _flood(world)

    assert outcome.victim_status == 200, outcome.describe()
    assert outcome.victim_seconds < VICTIM_BUDGET_SECONDS, (
        "one pro's GET /v1/pros/me/payouts flood starved the pool: " + outcome.describe()
    )
    assert outcome.attacker_statuses.get(429, 0) > 0, (
        "no status call was rate limited: " + outcome.describe()
    )
    assert outcome.checked_out_before_release == 0, (
        "pooled connections held over the Stripe reads: " + outcome.describe()
    )
    assert outcome.lock_waiters_before_release == 0, outcome.describe()
