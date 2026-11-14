"""addresses/geocode_claim.py (#384, Vault round 1): one caller at a time asks Mapbox about an
address. The claims are in the real Redis of REDIS_URL. The overlaps the Vault found run on
real, committed sessions: the worker's own task beside the backfill script, and two runs of
the script. Mapbox is a stand-in: nothing leaves the machine."""

import asyncio
import io
import time
import uuid
from collections.abc import AsyncIterator
from typing import TextIO, cast

import pytest
from redis.asyncio import Redis
from sqlalchemy import URL, delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.integrations.mapbox import KeptGeocode, StreetAddress
from app.modules.addresses import geocode_claim
from app.modules.addresses.geocode_claim import (
    GeocodeClaimUnavailableError,
    RedisGeocodeClaims,
    claim_key,
    claim_seconds,
)
from app.modules.addresses.models import Address
from app.modules.addresses.tasks import geocode_address
from app.modules.users.models import User
from scripts import backfill_address_geocodes as backfill
from tests.conftest import make_settings
from tests.test_address_geocode import KEPT_LAT, KEPT_LNG, TOKEN, kept, make_address, point_of
from tests.test_backfill_address_geocodes import Terminal, line

MAPBOX_TIMEOUT = 5.0
REDIS_TIMEOUT = 2.0
BUSY_LINE = "Claimed by the worker or another run (skipped)"


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(Settings().redis_url)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def address_ids(redis: Redis) -> AsyncIterator[list[uuid.UUID]]:
    """Ids of no row, for the claims alone; their keys are deleted afterwards."""
    ids = [uuid.uuid4() for _ in range(2)]
    yield ids
    await redis.delete(*(claim_key(address_id) for address_id in ids))


def claims_of(redis: Redis) -> RedisGeocodeClaims:
    return RedisGeocodeClaims(
        redis, mapbox_timeout_seconds=MAPBOX_TIMEOUT, timeout_seconds=REDIS_TIMEOUT
    )


# The claim


async def test_one_caller_holds_an_address_at_a_time(
    redis: Redis, address_ids: list[uuid.UUID]
) -> None:
    claims = claims_of(redis)
    one, other = address_ids

    assert await claims.claim(one, token="first")
    assert not await claims.claim(one, token="second")
    assert not await claims.claim(one, token="first")  # not its holder a second time either
    assert await claims.claim(other, token="second")  # each address has its own

    # In Redis: one key by the address's id, holding the token, that ends by itself.
    assert claim_key(one) == f"geocode-address-claim:{one}"
    assert await redis.get(claim_key(one)) == b"first"
    assert claims.claim_seconds == 10
    assert 9_000 < await redis.pttl(claim_key(one)) <= 10_000


async def test_only_its_holder_gives_a_claim_back(
    redis: Redis, address_ids: list[uuid.UUID]
) -> None:
    claims = claims_of(redis)
    address_id = address_ids[0]
    assert await claims.claim(address_id, token="holder")

    await claims.release(address_id, token="another")

    assert not await claims.claim(address_id, token="another")  # still the holder's
    await claims.release(address_id, token="holder")
    assert await claims.claim(address_id, token="another")
    # The holder before, late: its claim ended, and this one is not its to end.
    await claims.release(address_id, token="holder")
    assert await redis.get(claim_key(address_id)) == b"another"


async def test_a_dead_holders_claim_ends_by_itself(
    redis: Redis, address_ids: list[uuid.UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A holder that died never gives its claim back. Redis ends it after the claim's time (a
    second here: the two deadlines of half a second, no margin), and the next caller has it."""
    monkeypatch.setattr(geocode_claim, "DATABASE_SECONDS", 0)
    monkeypatch.setattr(geocode_claim, "EARLY_END_SECONDS", 0)
    claims = RedisGeocodeClaims(redis, mapbox_timeout_seconds=0.5, timeout_seconds=0.5)
    address_id = address_ids[0]
    assert claims.claim_seconds == 1
    assert await claims.claim(address_id, token="dead")
    assert not await claims.claim(address_id, token="next")  # not before its time

    await asyncio.sleep(1.2)  # past the claim's second

    assert await claims.claim(address_id, token="next")
    assert await redis.get(claim_key(address_id)) == b"next"


def test_a_claim_outlasts_its_holders_turn(redis: Redis) -> None:
    """The claim's time is Mapbox's deadline and a margin: the deadline of the call that takes
    it, two seconds for the database steps, and the second the holder stops early."""
    assert claim_seconds(mapbox_timeout_seconds=5.0, redis_timeout_seconds=2.0) == 10
    assert claim_seconds(mapbox_timeout_seconds=0.3, redis_timeout_seconds=0.3) == 4  # rounded up
    settings = make_settings(mapbox_timeout_seconds=7.5, job_enqueue_timeout_seconds=1.5)

    claims = RedisGeocodeClaims.from_settings(redis, settings)

    assert claims.claim_seconds == 12
    # The holder's turn: long enough for both deadlines, over before Redis ends the claim.
    assert 7.5 + 1.5 < claims.work_seconds < claims.claim_seconds


async def test_a_redis_that_is_down_gives_no_claim() -> None:
    dead = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    claims = claims_of(dead)
    try:
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.claim(uuid.uuid4(), token="x")
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.release(uuid.uuid4(), token="x")
    finally:
        await dead.aclose()


async def test_a_redis_that_hangs_is_given_up_on(silent_redis_url: str) -> None:
    hung = Redis.from_url(silent_redis_url)  # no socket timeout, as the worker's pool
    claims = RedisGeocodeClaims(hung, mapbox_timeout_seconds=MAPBOX_TIMEOUT, timeout_seconds=0.2)
    started = time.monotonic()
    try:
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.claim(uuid.uuid4(), token="x")
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.release(uuid.uuid4(), token="x")
    finally:
        await hung.aclose()

    assert time.monotonic() - started < 2  # two calls of 0.2 s each, not a hang


# The overlaps: real sessions, each its own connection, and real commits


class SlowMapbox:
    """Mapbox for one street. Each call about it waits for `answer` (bounded), as a call in
    flight does. Any other address is not found: the script reads every row without a point,
    and the test database may hold other tests' committed rows."""

    def __init__(self, street: str) -> None:
        self.street = street
        self.calls: list[StreetAddress] = []
        self.asked = asyncio.Event()
        self.answer = asyncio.Event()

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        if address.line1 != self.street:
            return None
        self.calls.append(address)
        self.asked.set()
        async with asyncio.timeout(5):
            await self.answer.wait()
        return kept(region=address.state, postcode=address.zip_code[:5])


@pytest.fixture
async def sessions(test_database_url: URL) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(test_database_url)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def address(sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[Address]:
    """A committed address without a point, on a street of its own. Deleted afterwards, with
    its user."""
    async with sessions() as session:
        row = await make_address(session, line1=f"{uuid.uuid4().hex[:8]} Claimquill Way")
        await session.commit()
    try:
        yield row
    finally:
        async with sessions() as session:
            await session.execute(delete(Address).where(Address.id == row.id))
            await session.execute(delete(User).where(User.id == row.user_id))
            await session.commit()


def config() -> Settings:
    return make_settings(
        geocode_on_save=True,
        mapbox_access_token=TOKEN,
        mapbox_timeout_seconds=MAPBOX_TIMEOUT,
        job_enqueue_timeout_seconds=REDIS_TIMEOUT,
    )


async def apply(
    sessions: async_sessionmaker[AsyncSession], mapbox: SlowMapbox, redis: Redis
) -> tuple[int, str]:
    """`--apply` as the script's own _main runs it: its claims in Redis, an operator at a
    terminal typing the number asked for, no pause between calls."""

    async def no_pause(seconds: float) -> None:
        pass

    out = io.StringIO()
    code = await backfill.run(
        ["--apply"],
        sessions,
        config(),
        mapbox,
        out,
        sleep=no_pause,
        claims=RedisGeocodeClaims.from_settings(redis, config()),
        stdin=cast(TextIO, Terminal(out)),
    )
    return code, out.getvalue()


async def test_the_worker_and_the_backfill_ask_mapbox_once_about_one_address(
    sessions: async_sessionmaker[AsyncSession], redis: Redis, address: Address
) -> None:
    """The Vault's overlap: the worker's job waits for Mapbox's answer about a new address
    while the backfill, which reads that row as one without a point, reaches it."""
    mapbox = SlowMapbox(address.line1)
    ctx = {
        "session_factory": sessions,
        "address_geocoder": mapbox,
        "redis": redis,
        "settings": config(),
    }
    worker = asyncio.create_task(geocode_address(ctx, str(address.id)))
    try:
        async with asyncio.timeout(5):
            await mapbox.asked.wait()  # the worker's call is in flight
        # Its claim is in ctx["redis"], the queue's own: where the script takes its claims.
        assert await redis.exists(claim_key(address.id))

        code, output = await apply(sessions, mapbox, redis)

        mapbox.answer.set()
        outcome = await worker
    finally:
        mapbox.answer.set()
        await asyncio.gather(worker, return_exceptions=True)

    assert len(mapbox.calls) == 1  # one bill
    assert outcome == "stored"
    assert code == 0
    assert line(output, BUSY_LINE) == 1  # skipped, not waited for
    assert line(output, "Point kept") == 0
    async with sessions() as session:
        assert await point_of(session, address.id) == (KEPT_LAT, KEPT_LNG)
    assert not await redis.exists(claim_key(address.id))  # given back


async def test_two_backfills_ask_mapbox_once_about_one_address(
    sessions: async_sessionmaker[AsyncSession], redis: Redis, address: Address
) -> None:
    mapbox = SlowMapbox(address.line1)
    first = asyncio.create_task(apply(sessions, mapbox, redis))
    try:
        async with asyncio.timeout(5):
            await mapbox.asked.wait()  # the first run's call is in flight

        second_code, second_output = await apply(sessions, mapbox, redis)

        mapbox.answer.set()
        first_code, first_output = await first
    finally:
        mapbox.answer.set()
        await asyncio.gather(first, return_exceptions=True)

    assert len(mapbox.calls) == 1
    assert (first_code, second_code) == (0, 0)
    assert (line(first_output, "Point kept"), line(first_output, BUSY_LINE)) == (1, 0)
    assert (line(second_output, "Point kept"), line(second_output, BUSY_LINE)) == (0, 1)
    async with sessions() as session:
        assert await point_of(session, address.id) == (KEPT_LAT, KEPT_LNG)
