"""The Vault's round 1 probes of the position routes (#350, PR #357), kept as regression
tests: extreme numbers, the real Redis rate limiter, replayed device times, an expiry nobody
forces, a delete that failed, and a Redis that is entirely down.
"""

import asyncio
import time
from datetime import datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.jobs.location import (
    NoJobLocationStore,
    RedisJobLocationStore,
    get_job_location_store,
    location_backend,
)
from app.rate_limit import RedisRateLimiter, get_rate_limiter
from tests.job_world import JobWorld
from tests.test_pro_location_api import (
    CODE,
    LAT,
    NO_POSITION,
    NOW,
    UNAVAILABLE,
    VALIDATION,
    clock,
    dead_redis,
    fix,
    on_the_way_job,
    ping,
    prefix,
    queue,
    raw,
    read,
    redis,
    settings,
    shown,
    store,
    url,
    world,
)

__all__ = [  # fixtures, used by name
    "clock",
    "dead_redis",
    "prefix",
    "queue",
    "redis",
    "settings",
    "store",
    "world",
]

BAD_REQUEST = {"error": {"code": "bad_request", "message": "Bad Request."}}
JSON = {"Content-Type": "application/json"}


@pytest.mark.parametrize(
    ("token", "refused"),
    [
        ("1" * 400, (422, VALIDATION)),
        ("-" + "9" * 400, (422, VALIDATION)),
        # Past the JSON parser's own limit on an integer's digits: refused before the schema,
        # with the generic 400 and nothing of the input.
        ("1" * 5000, (400, BAD_REQUEST)),
        ("1e309", (422, VALIDATION)),
        ("NaN", (422, VALIDATION)),
        ("-Infinity", (422, VALIDATION)),
    ],
    ids=["huge-int", "huge-negative", "parser-int-limit", "overflow-exponent", "nan", "-inf"],
)
async def test_extreme_number_is_refused_and_not_stored(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    token: str,
    refused: tuple[int, dict[str, object]],
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await db_client.put(
        url(job.id), content=raw(lat=token), headers={**world.pro.headers, **JSON}
    )

    assert (response.status_code, response.json()) == refused
    assert await store.get(job.id) is None


async def test_long_fraction_is_stored_as_one_bounded_float(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
) -> None:
    job = await on_the_way_job(db_session, world)

    response = await db_client.put(
        url(job.id),
        content=raw(lat="26." + "1234567890" * 20_000),  # 200,000 digits
        headers={**world.pro.headers, **JSON},
    )

    assert response.status_code == 204, response.text
    stored = await redis.hget(store.key(job.id), "position")  # type: ignore[misc]  # as in the store
    assert stored is not None
    assert len(stored) < 300
    assert (await shown(db_client, job.id, world))["lat"] == 26.123456789012344


async def test_real_redis_limit_counts_refused_and_dropped_pings(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
    prefix: str,
    settings: Settings,
) -> None:
    settings.pro_location_rate_limit = 5
    limiter = RedisRateLimiter(redis, prefix=f"{prefix}:rate", clock=lambda: NOW.timestamp())
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    job = await on_the_way_job(db_session, world)

    responses = [
        await ping(db_client, job.id, world.pro),  # kept
        await ping(db_client, job.id, world.pro),  # dropped: too soon
        await ping(db_client, job.id, world.pro, fix(lat=True)),  # invalid
        await ping(db_client, world.customer.id, world.pro),  # no such job
        await ping(db_client, job.id, world.pro, fix(speed=100)),  # unknown field
        await ping(db_client, job.id, world.pro),  # the sixth
    ]

    assert [r.status_code for r in responses] == [204, 204, 422, 404, 422, 429]
    assert responses[-1].headers["retry-after"]
    # One counter for the pro, whatever became of each ping.
    assert len([key async for key in redis.scan_iter(match=f"{prefix}:rate:*")]) == 1


async def expiry_of(redis: Redis, key: str) -> int:
    """The key's expiry as a Unix time in milliseconds: it moves only when the key is written."""
    # redis-py types pexpiretime for its sync client; on redis.asyncio it is awaitable.
    return int(await redis.pexpiretime(key))  # type: ignore[misc]


async def test_replayed_future_time_never_extends_the_retention(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    clock: list[datetime],
    redis: Redis,
) -> None:
    job = await on_the_way_job(db_session, world)
    ahead = fix(NOW + timedelta(seconds=300))  # the furthest ahead a device may be
    assert (await ping(db_client, job.id, world.pro, ahead)).status_code == 204
    expires_at = await expiry_of(redis, store.key(job.id))
    clock[0] += timedelta(seconds=4)

    # An older fix is answered and dropped: neither the position nor its expiry moves.
    assert (await ping(db_client, job.id, world.pro, fix(clock[0], lat=30))).status_code == 204

    assert await expiry_of(redis, store.key(job.id)) == expires_at
    assert (await shown(db_client, job.id, world))["lat"] == LAT
    too_old = fix(clock[0] - timedelta(seconds=601))
    too_new = fix(clock[0] + timedelta(seconds=301))
    assert (await ping(db_client, job.id, world.pro, too_old)).status_code == 422
    assert (await ping(db_client, job.id, world.pro, too_new)).status_code == 422


async def test_position_expires_with_nobody_forcing_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    settings: Settings,
    redis: Redis,
) -> None:
    settings.pro_location_ttl_seconds = 1
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204

    await asyncio.sleep(1.1)

    assert await redis.exists(store.key(job.id)) == 0
    assert (await read(db_client, job.id, world.customer)).json() == NO_POSITION


class DeleteDown(NoJobLocationStore):
    async def delete(self, job_id: object) -> None:
        raise RedisConnectionError("test outage")


async def test_position_left_by_a_failed_delete_is_never_shown(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    redis: Redis,
) -> None:
    job = await on_the_way_job(db_session, world)
    assert (await ping(db_client, job.id, world.pro)).status_code == 204
    app.dependency_overrides[get_job_location_store] = DeleteDown

    checked_in = await db_client.post(
        f"/v1/pros/me/jobs/{job.id}/check-in",
        json={"arrival_code": CODE, "lat": 25.0, "lng": -80.0},
        headers=world.pro.headers,
    )

    assert checked_in.status_code == 200, checked_in.text
    assert await redis.exists(store.key(job.id)) == 1  # the delete failed: the key is there
    app.dependency_overrides[get_job_location_store] = lambda: store  # Redis is back
    assert (await read(db_client, job.id, world.customer)).json() == NO_POSITION
    assert (await ping(db_client, job.id, world.pro)).status_code == 409


async def test_whole_redis_down_including_the_rate_limiter(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: list[datetime],
    dead_redis: Redis,
    settings: Settings,
) -> None:
    """Nothing replaced: the app's own rate limiter and location store, both on a Redis that
    is not there."""
    job = await on_the_way_job(db_session, world)
    app.state.redis = dead_redis
    app.state.location_backend = location_backend(settings, dead_redis)
    del app.dependency_overrides[get_rate_limiter]
    del app.dependency_overrides[get_job_location_store]
    started_at = time.monotonic()

    sent = await ping(db_client, job.id, world.pro)
    got = await read(db_client, job.id, world.customer)

    assert (sent.status_code, sent.json()) == (503, UNAVAILABLE)
    assert (got.status_code, got.json()) == (200, NO_POSITION)
    assert time.monotonic() - started_at < 3
