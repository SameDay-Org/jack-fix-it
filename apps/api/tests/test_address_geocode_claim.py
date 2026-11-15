"""addresses/geocode_claim.py (#384, Vault rounds 1 and 2): one caller at a time asks Mapbox
about an address, and one billed call per address per window. The claims and the attempts'
marks are in the real Redis of REDIS_URL. The overlaps the Vault found run on real, committed
sessions: the worker's own task beside the backfill script, two runs of the script, and the
three ways a claim ends under a holder still at work. Mapbox is a stand-in: nothing leaves
the machine."""

import asyncio
import io
import logging
import re
import threading
import time
import traceback
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, TextIO, cast

import pytest
import sentry_sdk
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import URL, delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.integrations.mapbox import KeptGeocode, StreetAddress
from app.modules.addresses import geocode_claim
from app.modules.addresses.geocode import AddressGeocodeService, GeocodeOutcome
from app.modules.addresses.geocode_claim import (
    GeocodeClaimUnavailableError,
    RedisGeocodeClaims,
    attempt_key,
    claim_key,
    claim_seconds,
)
from app.modules.addresses.models import Address
from app.modules.addresses.repository import AddressRepository
from app.modules.addresses.tasks import geocode_address
from app.modules.users.models import User
from app.observability import JsonFormatter, init_sentry
from scripts import backfill_address_geocodes as backfill
from tests.conftest import make_settings
from tests.test_address_geocode import (
    GEOCODE_LOGGER,
    KEPT_LAT,
    KEPT_LNG,
    TOKEN,
    FakeGeocoder,
    forget_attempts,
    kept,
    make_address,
    point_of,
)
from tests.test_backfill_address_geocodes import Terminal, line
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

__all__ = ["sentry_transport"]

MAPBOX_TIMEOUT = 5.0
REDIS_TIMEOUT = 2.0
WINDOW = 1800.0  # the attempt window's default
# A window that ends within a test, with round trips to spare on a loaded runner.
SHORT_WINDOW = 2.0
# The holder's own deadlines in the Vault's reproductions: a claim of four seconds (a second
# of deadlines and three of margin), so a test waits for it to end.
SHORT_DEADLINES: dict[str, Any] = {
    "mapbox_timeout_seconds": 0.5,
    "job_enqueue_timeout_seconds": 0.25,
}
BUSY_LINE = "Claimed, or asked about within the attempt window (skipped)"


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    """The real Redis of REDIS_URL, without attempt marks before and after the test (the
    backfill marks other tests' committed rows too)."""
    client = Redis.from_url(Settings().redis_url)
    await forget_attempts(client)
    try:
        yield client
    finally:
        await forget_attempts(client)
        await client.aclose()


@pytest.fixture
async def address_ids(redis: Redis) -> AsyncIterator[list[uuid.UUID]]:
    """Ids of no row, for the claims alone; their keys are deleted afterwards."""
    ids = [uuid.uuid4() for _ in range(2)]
    yield ids
    await redis.delete(*(claim_key(address_id) for address_id in ids))


def claims_of(redis: Redis) -> RedisGeocodeClaims:
    return RedisGeocodeClaims(
        redis,
        mapbox_timeout_seconds=MAPBOX_TIMEOUT,
        timeout_seconds=REDIS_TIMEOUT,
        attempt_window_seconds=WINDOW,
    )


def short_window_claims(redis: Redis, monkeypatch: pytest.MonkeyPatch) -> RedisGeocodeClaims:
    """Claims whose window ends within a test. The window must be longer than the claim, so
    the claim is a second: deadlines of a second, no margin (the turn's real database steps
    take far less)."""
    monkeypatch.setattr(geocode_claim, "DATABASE_SECONDS", 0)
    monkeypatch.setattr(geocode_claim, "EARLY_END_SECONDS", 0)
    claims = RedisGeocodeClaims(
        redis,
        mapbox_timeout_seconds=0.5,
        timeout_seconds=0.25,
        attempt_window_seconds=SHORT_WINDOW,
    )
    assert claims.claim_seconds == 1
    return claims


def test_the_window_outlasts_the_claim(redis: Redis) -> None:
    """A mark that ended inside its holder's turn would record nothing: such a window builds
    no claims, so every geocode stops before Redis or Mapbox is asked."""
    with pytest.raises(ValueError, match="GEOCODE_ATTEMPT_WINDOW_SECONDS"):
        RedisGeocodeClaims(
            redis, mapbox_timeout_seconds=5.0, timeout_seconds=2.0, attempt_window_seconds=12
        )
    assert RedisGeocodeClaims(
        redis, mapbox_timeout_seconds=5.0, timeout_seconds=2.0, attempt_window_seconds=13
    )
    # A Mapbox deadline near a minute against the smallest window the settings allow.
    settings = make_settings(mapbox_timeout_seconds=55.0, geocode_attempt_window_seconds=60)
    with pytest.raises(ValueError, match="GEOCODE_ATTEMPT_WINDOW_SECONDS"):
        RedisGeocodeClaims.from_settings(redis, settings)


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
    assert claims.claim_seconds == 12
    assert 11_000 < await redis.pttl(claim_key(one)) <= 12_000


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
    second here: Mapbox's half a second and two Redis calls of a quarter, no margin), and the
    next caller has it."""
    monkeypatch.setattr(geocode_claim, "DATABASE_SECONDS", 0)
    monkeypatch.setattr(geocode_claim, "EARLY_END_SECONDS", 0)
    claims = RedisGeocodeClaims(
        redis, mapbox_timeout_seconds=0.5, timeout_seconds=0.25, attempt_window_seconds=WINDOW
    )
    address_id = address_ids[0]
    assert claims.claim_seconds == 1
    assert await claims.claim(address_id, token="dead")
    assert not await claims.claim(address_id, token="next")  # not before its time

    await asyncio.sleep(1.2)  # past the claim's second

    assert await claims.claim(address_id, token="next")
    assert await redis.get(claim_key(address_id)) == b"next"


def test_a_claim_outlasts_its_holders_turn(redis: Redis) -> None:
    """The claim's time is Mapbox's deadline and a margin: the deadlines of the two Redis calls
    of the turn (the claim, the attempt's mark), two seconds for the database steps, and the
    second the holder stops early."""
    assert claim_seconds(mapbox_timeout_seconds=5.0, redis_timeout_seconds=2.0) == 12
    assert claim_seconds(mapbox_timeout_seconds=0.3, redis_timeout_seconds=0.3) == 4  # rounded up
    settings = make_settings(mapbox_timeout_seconds=7.5, job_enqueue_timeout_seconds=1.5)

    claims = RedisGeocodeClaims.from_settings(redis, settings)

    assert claims.claim_seconds == 14
    # The holder's turn: long enough for every deadline, over before Redis ends the claim.
    assert 7.5 + 2 * 1.5 < claims.work_seconds < claims.claim_seconds
    assert claims.attempt_window_seconds == settings.geocode_attempt_window_seconds


async def test_a_redis_that_is_down_gives_no_claim() -> None:
    dead = Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2)
    claims = claims_of(dead)
    try:
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.claim(uuid.uuid4(), token="x")
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.mark_attempt(uuid.uuid4(), token="x")
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.release(uuid.uuid4(), token="x")
    finally:
        await dead.aclose()


async def test_a_redis_that_hangs_is_given_up_on(silent_redis_url: str) -> None:
    hung = Redis.from_url(silent_redis_url)  # no socket timeout, as the worker's pool
    claims = RedisGeocodeClaims(
        hung, mapbox_timeout_seconds=MAPBOX_TIMEOUT, timeout_seconds=0.2, attempt_window_seconds=60
    )
    started = time.monotonic()
    try:
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.claim(uuid.uuid4(), token="x")
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.mark_attempt(uuid.uuid4(), token="x")
        with pytest.raises(GeocodeClaimUnavailableError):
            await claims.release(uuid.uuid4(), token="x")
    finally:
        await hung.aclose()

    assert time.monotonic() - started < 2  # three calls of 0.2 s each, not a hang


SENTINEL = "SentinelRedisText-4412-pw"


class FailingRedis:
    """A Redis whose every call fails with SENTINEL in its error's text: a password, a host,
    anything Redis's client may put there."""

    def register_script(self, script: str) -> Callable[..., Awaitable[object]]:
        async def run(**arguments: object) -> object:
            raise RedisConnectionError(SENTINEL)

        return run

    async def set(self, *arguments: object, **options: object) -> bool:
        raise RedisConnectionError(SENTINEL)


async def test_redis_error_text_reaches_no_log_and_no_sentry(
    sentry_transport: MemoryTransport, caplog: pytest.LogCaptureFixture
) -> None:
    """Vault round 2: the error is raised from None, so Redis's own error is not its cause and
    is not shown as its context: a failed job's log line (ARQ logs it with its traceback) and
    its Sentry event carry none of its text."""
    init_sentry(make_settings(sentry_dsn=TEST_DSN))
    claims = RedisGeocodeClaims(
        cast(Redis, FailingRedis()),
        mapbox_timeout_seconds=MAPBOX_TIMEOUT,
        timeout_seconds=REDIS_TIMEOUT,
        attempt_window_seconds=WINDOW,
    )
    address_id = uuid.uuid4()
    errors: list[GeocodeClaimUnavailableError] = []
    for call in (claims.claim, claims.mark_attempt, claims.release):
        with pytest.raises(GeocodeClaimUnavailableError) as raised:
            await call(address_id, token="x")
        errors.append(raised.value)

    with caplog.at_level(logging.ERROR, logger="arq.jobs"):
        for error in errors:
            logging.getLogger("arq.jobs").error("job failed", exc_info=error)
            sentry_sdk.capture_exception(error)
    sentry_sdk.flush()

    for error in errors:
        assert error.__cause__ is None
        assert error.__suppress_context__
        assert SENTINEL not in "".join(traceback.format_exception(error))
    assert len(caplog.records) == 3
    assert SENTINEL not in "\n".join(JsonFormatter().format(r) for r in caplog.records)
    sent = _payloads(sentry_transport)
    assert len(sent) >= 3  # the three captures, and the log lines as events
    assert [payload for payload in sent if SENTINEL in payload] == []


# One billed call per address per window: the attempt's mark


async def test_an_attempt_is_marked_once_per_window(
    redis: Redis, address_ids: list[uuid.UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    claims = short_window_claims(redis, monkeypatch)
    one, other = address_ids
    try:
        assert await claims.mark_attempt(one, token="first")
        assert not await claims.mark_attempt(one, token="second")
        assert await claims.mark_attempt(other, token="second")  # each address has its own

        # In Redis: one key by the address's id, holding the token, that ends by itself.
        assert attempt_key(one) == f"geocode-address-attempt:{one}"
        assert await redis.get(attempt_key(one)) == b"first"
        assert 0 < await redis.pttl(attempt_key(one)) <= SHORT_WINDOW * 1000
        # Not the claim's key, and the release of a claim leaves it.
        assert await claims.claim(one, token="first")
        await claims.release(one, token="first")
        assert await redis.get(attempt_key(one)) == b"first"

        await asyncio.sleep(SHORT_WINDOW + 0.1)  # past the window

        assert await claims.mark_attempt(one, token="third")
        assert await redis.get(attempt_key(one)) == b"third"
    finally:
        await redis.delete(*(attempt_key(address_id) for address_id in address_ids))


async def test_one_billed_call_per_address_per_window(
    db_session: AsyncSession, redis: Redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An address that kept nothing is not asked about again until its attempt's mark ends
    (SHORT_WINDOW here). The mark holds the holder's random token: nothing of the address."""
    texts = {"line1": "4412 Markwindow Rd", "line2": "Unit Markwindow", "city": "Markwindowton"}
    address = await make_address(db_session, **texts)
    geocoder = FakeGeocoder()
    geocoder.answer = None
    geocode = AddressGeocodeService(
        db_session, geocoder, short_window_claims(redis, monkeypatch), enabled=True
    ).geocode

    assert await geocode(address.id) is GeocodeOutcome.NO_RESULT
    assert not await redis.exists(claim_key(address.id))  # the claim given back
    mark = await redis.get(attempt_key(address.id))  # the mark kept
    assert mark is not None
    assert re.fullmatch(rb"[0-9a-f]{64}", mark)
    keys = [key async for key in redis.scan_iter(match=f"*{address.id}*")]
    assert keys == [attempt_key(address.id).encode()]
    assert await geocode(address.id) is GeocodeOutcome.BUSY  # within the window
    assert len(geocoder.asked) == 1

    await asyncio.sleep(SHORT_WINDOW + 0.1)  # past the window

    assert await geocode(address.id) is GeocodeOutcome.NO_RESULT
    assert len(geocoder.asked) == 2


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


def config(**overrides: Any) -> Settings:
    return make_settings(
        **{
            "geocode_on_save": True,
            "mapbox_access_token": TOKEN,
            "mapbox_timeout_seconds": MAPBOX_TIMEOUT,
            "job_enqueue_timeout_seconds": REDIS_TIMEOUT,
            **overrides,
        }
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
    assert await redis.exists(attempt_key(address.id))  # the mark stays for its window


async def test_two_backfills_ask_mapbox_once_about_one_address(
    sessions: async_sessionmaker[AsyncSession],
    redis: Redis,
    address: Address,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Both runs walk every row without a point, other tests' committed ones too, and mark
    them (each such row is not found here). So each run may find some of them marked by the
    other: only the address's own outcomes are counted, from the step's log lines."""
    mapbox = SlowMapbox(address.line1)
    with caplog.at_level(logging.INFO, logger=GEOCODE_LOGGER):
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
    # Only the address can be kept (any other row is not found): the first run kept it, and
    # the second, which found it claimed, did not ask.
    assert (line(first_output, "Point kept"), line(second_output, "Point kept")) == (1, 0)
    ours = [r for r in caplog.records if r.__dict__.get("address_id") == str(address.id)]
    assert sorted(r.__dict__["outcome"] for r in ours) == ["busy", "stored"]
    async with sessions() as session:
        assert await point_of(session, address.id) == (KEPT_LAT, KEPT_LNG)


# Vault round 2: a claim that ends under a holder still at work. Each reproduction ends with
# one billed call: the holder's attempt is marked, and the next caller finds the mark.


async def claim_gone(redis: Redis, address_id: uuid.UUID) -> None:
    """Waits for the address's claim to end by itself: Redis's own count of its time left."""
    left = await redis.pttl(claim_key(address_id))
    assert 0 < left <= 4_000  # the holder's short claim, still held
    await asyncio.sleep(left / 1000 + 0.1)
    assert not await redis.exists(claim_key(address_id))


async def test_a_holder_paused_past_its_claim_is_not_billed_twice(
    sessions: async_sessionmaker[AsyncSession],
    redis: Redis,
    address: Address,
    test_database_url: URL,
) -> None:
    """The worker's call is in flight when its process stops (here: a thread with a loop of
    its own, held in a blocking wait), its clock going on. Its claim ends by itself; the
    backfill reaches the address, reads it without a point, and finds the attempt's mark."""
    accepted, resume = threading.Event(), threading.Event()
    paused_calls: list[StreetAddress] = []

    class PausedMapbox:
        async def geocode_to_keep(self, asked: StreetAddress) -> KeptGeocode | None:
            paused_calls.append(asked)
            accepted.set()
            resume.wait(timeout=30)  # no await: the holder's whole loop stops
            return kept(region=asked.state, postcode=asked.zip_code[:5])

    def paused_worker() -> str:
        async def run() -> str:
            engine = create_async_engine(test_database_url)
            client = Redis.from_url(Settings().redis_url)
            try:
                ctx = {
                    "session_factory": async_sessionmaker(engine, expire_on_commit=False),
                    "address_geocoder": PausedMapbox(),
                    "redis": client,
                    "settings": config(**SHORT_DEADLINES),
                }
                return await geocode_address(ctx, str(address.id))
            finally:
                await client.aclose()
                await engine.dispose()

        return asyncio.run(run())

    mapbox = SlowMapbox(address.line1)
    mapbox.answer.set()
    worker = asyncio.ensure_future(asyncio.to_thread(paused_worker))
    try:
        assert await asyncio.to_thread(accepted.wait, 10)
        await claim_gone(redis, address.id)  # ended while its holder is paused

        code, output = await apply(sessions, mapbox, redis)
    finally:
        resume.set()
        outcome = await worker

    assert len(paused_calls) == 1
    assert mapbox.calls == []  # one bill: the paused one
    assert code == 0
    assert line(output, BUSY_LINE) == 1
    assert outcome == "unavailable"  # resumed past its turn: it keeps nothing
    async with sessions() as session:
        assert await point_of(session, address.id) == (None, None)
    assert await redis.exists(attempt_key(address.id))  # nobody asks again within the window


async def test_a_commit_that_lands_late_is_not_billed_twice(
    sessions: async_sessionmaker[AsyncSession],
    redis: Redis,
    address: Address,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The worker writes its point in time, and its COMMIT is held up on the way (the Vault
    held it in a wire proxy; here it goes on a task of its own, which the turn's deadline does
    not cancel, and lands when the test lets it). The claim ends with the point not visible;
    the backfill reads the address without one, and finds the attempt's mark."""
    mapbox = SlowMapbox(address.line1)
    mapbox.answer.set()
    sent, land = asyncio.Event(), asyncio.Event()
    in_flight: list[asyncio.Task[None]] = []
    written: list[AsyncSession] = []
    write = AddressRepository.set_point

    async def write_and_note(self: AddressRepository, address_id: uuid.UUID, **point: Any) -> bool:
        written.append(self._session)
        return await write(self, address_id, **point)

    monkeypatch.setattr(AddressRepository, "set_point", write_and_note)

    @asynccontextmanager
    async def sessions_with_a_late_commit() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            commit, rollback = session.commit, session.rollback

            async def lands_when_let() -> None:
                await land.wait()
                await commit()

            async def commit_held_on_the_way() -> None:
                if not any(s is session for s in written):
                    return await commit()  # the looks' own
                sent.set()
                in_flight.append(asyncio.create_task(lands_when_let()))
                await asyncio.shield(in_flight[0])

            async def rollback_behind_the_commit() -> None:
                if in_flight:  # one connection: the COMMIT on its way comes first
                    await in_flight[0]
                await rollback()

            monkeypatch.setattr(session, "commit", commit_held_on_the_way)
            monkeypatch.setattr(session, "rollback", rollback_behind_the_commit)
            yield session

    ctx = {
        "session_factory": sessions_with_a_late_commit,
        "address_geocoder": mapbox,
        "redis": redis,
        "settings": config(**SHORT_DEADLINES),
    }
    worker = asyncio.create_task(geocode_address(ctx, str(address.id)))
    backfill_run: asyncio.Task[tuple[int, str]] | None = None
    try:
        async with asyncio.timeout(5):
            await sent.wait()
        await claim_gone(redis, address.id)  # the point is not visible yet
        async with sessions() as session:
            assert await point_of(session, address.id) == (None, None)

        backfill_run = asyncio.create_task(apply(sessions, mapbox, redis))
        await asyncio.wait([backfill_run], timeout=3)  # done, or held on the row's lock
        land.set()
        outcome = await worker
        code, output = await backfill_run
    finally:
        land.set()
        await asyncio.gather(worker, *in_flight, return_exceptions=True)
        if backfill_run is not None:
            await asyncio.gather(backfill_run, return_exceptions=True)

    assert len(mapbox.calls) == 1  # one bill
    assert code == 0
    assert line(output, BUSY_LINE) == 1
    assert outcome == "unavailable"  # its turn ended while the COMMIT was on its way
    async with sessions() as session:
        assert await point_of(session, address.id) == (KEPT_LAT, KEPT_LNG)  # it landed


async def test_a_claim_lost_mid_call_is_not_billed_twice(
    sessions: async_sessionmaker[AsyncSession], redis: Redis, address: Address
) -> None:
    """The claim's key is lost while the worker's call is in flight (an early expiry, a
    restart of Redis): the backfill takes a claim of its own, reads the address without a
    point, and finds the attempt's mark."""
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
            await mapbox.asked.wait()
        assert await redis.delete(claim_key(address.id)) == 1

        code, output = await apply(sessions, mapbox, redis)

        mapbox.answer.set()
        outcome = await worker
    finally:
        mapbox.answer.set()
        await asyncio.gather(worker, return_exceptions=True)

    assert len(mapbox.calls) == 1  # one bill
    assert code == 0
    assert line(output, BUSY_LINE) == 1
    assert outcome == "stored"
    async with sessions() as session:
        assert await point_of(session, address.id) == (KEPT_LAT, KEPT_LNG)
