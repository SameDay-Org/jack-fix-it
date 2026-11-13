"""Where a pro's live position could outlive its key (#350, Vault round 1): the store's Redis
keeping it on disk or in its slow log (B1), and an HTTP cache keeping a response (B2).

The check of what a Redis keeps runs on a stand-in that answers CONFIG GET, never on a
CONFIG SET of the shared test Redis; two tests read the real one as it is.
"""

import logging
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import cast

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import NoPermissionError, RedisError, ResponseError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.main import create_app
from app.modules.jobs.location import (
    KEY_PREFIX,
    LocationBackend,
    NoJobLocationStore,
    Position,
    RedisJobLocationStore,
    get_job_location_store,
    location_backend,
)
from app.modules.jobs.location_guard import (
    APPEND_ONLY,
    CHECKED_SETTINGS,
    SAVE,
    SLOW_LOG,
    EphemeralRedisGuard,
    LocationStoreRefusedError,
)
from app.modules.jobs.models import JobStatus
from app.observability import JsonFormatter
from tests.conftest import make_settings
from tests.job_world import JobWorld, make_job
from tests.test_pro_location_api import (
    CODE,
    LAT,
    LAT2,
    LNG,
    LNG2,
    NEEDLES,
    NO_POSITION,
    STORE_TIMEOUT,
    UNAVAILABLE,
    clock,
    dead_redis,
    fix,
    log_fields,
    on_the_way_job,
    ping,
    plant,
    prefix,
    queue,
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

GUARD_LOGGER = "app.modules.jobs.location_guard"
LOCATION_LOGGER = "app.modules.jobs.location"
# A Redis that keeps nothing: no snapshot, no AOF, the slow log off.
SAFE = {SAVE: "", APPEND_ONLY: "no", SLOW_LOG: "-1"}
SNAPSHOTS = {**SAFE, SAVE: "3600 1 300 100 60 10000"}
CONFIG_RENAMED = "unknown command 'CONFIG', with args beginning with: 'GET' 'save'"
CONFIG_DENIED = "this user has no permissions to run the 'config|get' command"
RECHECK = 60.0
OTHER_REDIS_URL = "redis://positions.invalid:6380/3"


class ConfigOnly:
    """A Redis that answers the check's one command from `config`, or raises `error`."""

    def __init__(
        self, config: dict[str, str] | None = None, error: Exception | None = None
    ) -> None:
        self.config = dict(SAFE if config is None else config)
        self.error = error
        self.asked: list[str] = []

    async def config_get(self, name: str) -> dict[str, str]:
        self.asked.append(name)
        if self.error is not None:
            raise self.error
        return {name: self.config[name]} if name in self.config else {}


def guard_on(
    fake: ConfigOnly,
    *,
    enforce: bool = True,
    assume: bool = False,
    now: Callable[[], float] = lambda: 0.0,
) -> EphemeralRedisGuard:
    return EphemeralRedisGuard(
        cast(Redis, fake),
        enforce=enforce,
        assume_ephemeral=assume,
        recheck_seconds=RECHECK,
        clock=now,
    )


Said = tuple[str, str, list[str], list[str], bool]


def said(caplog: pytest.LogCaptureFixture) -> list[Said]:
    """What the check logged: level, event, the unsafe and the unreadable settings, enforced."""
    return [
        (r.levelname, r.getMessage(), r.unsafe, r.unreadable, r.enforced)  # type: ignore[attr-defined]  # extras
        for r in caplog.records
        if r.name == GUARD_LOGGER
    ]


async def refusal_of(guard: EphemeralRedisGuard) -> str:
    with pytest.raises(LocationStoreRefusedError) as refused:
        await guard.require()
    return refused.value.reason


# B1: the check of what the Redis keeps


@pytest.mark.parametrize(
    ("name", "value"),
    [
        (SAVE, "3600 1 300 100 60 10000"),
        (SAVE, "60 1"),
        (APPEND_ONLY, "yes"),
        (SLOW_LOG, "10000"),
        (SLOW_LOG, "0"),  # 0 logs every command
    ],
)
async def test_a_redis_that_keeps_positions_is_refused(
    caplog: pytest.LogCaptureFixture, name: str, value: str
) -> None:
    fake = ConfigOnly({**SAFE, name: value})

    with caplog.at_level(logging.DEBUG):
        reason = await refusal_of(guard_on(fake))

    assert reason == "not_ephemeral"
    assert said(caplog) == [("ERROR", "location_redis_not_ephemeral", [name], [], True)]
    # The deployer's word never overrides what the Redis itself says.
    assert await refusal_of(guard_on(fake, assume=True)) == "not_ephemeral"


async def test_a_redis_that_keeps_nothing_is_accepted(caplog: pytest.LogCaptureFixture) -> None:
    fake = ConfigOnly()

    with caplog.at_level(logging.DEBUG):
        await guard_on(fake).require()

    assert fake.asked == list(CHECKED_SETTINGS)
    assert said(caplog) == [("INFO", "location_redis_ephemeral", [], [], True)]


@pytest.mark.parametrize(
    "error",
    [ResponseError(CONFIG_RENAMED), NoPermissionError(CONFIG_DENIED)],
    ids=["command-renamed", "acl"],
)
async def test_config_refused_is_refused_unless_the_deployer_vouches(
    caplog: pytest.LogCaptureFixture, error: Exception
) -> None:
    fake = ConfigOnly(error=error)
    unreadable = list(CHECKED_SETTINGS)

    with caplog.at_level(logging.DEBUG):
        reason = await refusal_of(guard_on(fake))
        await guard_on(fake, assume=True).require()  # LOCATION_REDIS_ASSUME_EPHEMERAL=true

    assert reason == "unverifiable"
    assert said(caplog) == [
        ("ERROR", "location_redis_unverifiable", [], unreadable, True),
        ("WARNING", "location_redis_assumed_ephemeral", [], unreadable, True),
    ]
    # The server's own text stays out of the logs.
    logs = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert "CONFIG" not in logs
    assert "config|get" not in logs
    assert not any(r.exc_info for r in caplog.records)


@pytest.mark.parametrize(
    "config",
    [
        {APPEND_ONLY: "no", SLOW_LOG: "-1"},  # the server does not know `save`
        {**SAFE, SLOW_LOG: "off"},  # not a number
    ],
    ids=["missing", "not-a-number"],
)
async def test_an_answer_that_cannot_be_read_is_not_an_answer(config: dict[str, str]) -> None:
    assert await refusal_of(guard_on(ConfigOnly(config))) == "unverifiable"
    await guard_on(ConfigOnly(config), assume=True).require()
    # One setting unreadable and another unsafe: the unsafe one decides, vouched for or not.
    keeps = {**config, APPEND_ONLY: "yes"}
    assert await refusal_of(guard_on(ConfigOnly(keeps), assume=True)) == "not_ephemeral"


@pytest.mark.parametrize(
    ("fake", "event", "unsafe", "unreadable"),
    [
        (ConfigOnly(SNAPSHOTS), "location_redis_not_ephemeral", [SAVE], []),
        (
            ConfigOnly(error=ResponseError(CONFIG_RENAMED)),
            "location_redis_unverifiable",
            [],
            list(CHECKED_SETTINGS),
        ),
    ],
    ids=["keeps", "will-not-say"],
)
async def test_outside_staging_and_production_it_is_only_logged(
    caplog: pytest.LogCaptureFixture,
    fake: ConfigOnly,
    event: str,
    unsafe: list[str],
    unreadable: list[str],
) -> None:
    with caplog.at_level(logging.DEBUG):
        await guard_on(fake, enforce=False).require()  # no refusal

    assert said(caplog) == [("WARNING", event, unsafe, unreadable, False)]


async def test_the_answer_is_remembered_then_asked_again(
    caplog: pytest.LogCaptureFixture,
) -> None:
    now = [1000.0]
    fake = ConfigOnly(SNAPSHOTS)
    guard = guard_on(fake, now=lambda: now[0])
    one_round = len(CHECKED_SETTINGS)

    with caplog.at_level(logging.DEBUG):
        assert await refusal_of(guard) == "not_ephemeral"
        assert await refusal_of(guard) == "not_ephemeral"
        assert len(fake.asked) == one_round  # the second call asked nothing
        fake.config[SAVE] = ""  # the deployer fixes the Redis
        now[0] += RECHECK - 0.1
        assert await refusal_of(guard) == "not_ephemeral"  # not asked again yet
        now[0] += 0.1
        await guard.require()  # asked again: accepted, with no restart
        assert len(fake.asked) == 2 * one_round
        fake.config[APPEND_ONLY] = "yes"  # turned on while the API runs
        await guard.require()  # still the remembered answer
        now[0] += RECHECK
        assert await refusal_of(guard) == "not_ephemeral"

    # Each answer is logged when it changes, not on every request.
    assert [(event, unsafe) for _, event, unsafe, _, _ in said(caplog)] == [
        ("location_redis_not_ephemeral", [SAVE]),
        ("location_redis_ephemeral", []),
        ("location_redis_not_ephemeral", [APPEND_ONLY]),
    ]


async def test_an_unreachable_redis_is_an_outage_not_an_answer(
    caplog: pytest.LogCaptureFixture, dead_redis: Redis
) -> None:
    fake = ConfigOnly(error=RedisConnectionError("down"))
    guard = guard_on(fake)

    with caplog.at_level(logging.DEBUG):
        with pytest.raises(RedisConnectionError):
            await guard.require()
        fake.error = None
        await guard.require()  # asked again at once: the outage was not remembered
        with pytest.raises((RedisError, OSError)):  # the real client, nothing listening
            await EphemeralRedisGuard(
                dead_redis, enforce=True, assume_ephemeral=True, recheck_seconds=RECHECK
            ).require()

    assert [event for _, event, _, _, _ in said(caplog)] == ["location_redis_ephemeral"]


async def test_the_real_redis_answer_is_read(
    redis: Redis, caplog: pytest.LogCaptureFixture
) -> None:
    """The check against the test Redis as it is configured, whatever that is: the test's own
    CONFIG GET says what to expect."""
    answers: dict[str, str] = {}
    for name in CHECKED_SETTINGS:
        [(key, value)] = (await redis.config_get(name)).items()
        answers[str(key)] = str(value)
    keeps = [
        name
        for name, kept in [
            (SAVE, answers[SAVE] != ""),
            (APPEND_ONLY, answers[APPEND_ONLY] != "no"),
            (SLOW_LOG, int(answers[SLOW_LOG]) >= 0),
        ]
        if kept
    ]
    guard = EphemeralRedisGuard(
        redis, enforce=True, assume_ephemeral=False, recheck_seconds=RECHECK
    )

    with caplog.at_level(logging.DEBUG):
        if keeps:
            assert await refusal_of(guard) == "not_ephemeral"
        else:
            await guard.require()

    [(_, _, unsafe, unreadable, _)] = said(caplog)
    assert (unsafe, unreadable) == (keeps, [])  # every setting was read from the real reply


async def test_a_real_redis_that_refuses_config(redis: Redis) -> None:
    """A user of the test Redis that may run everything but CONFIG, as on a managed Redis."""
    name, password = f"jobloc-test-{uuid.uuid4().hex}", uuid.uuid4().hex
    await redis.acl_setuser(
        name,
        enabled=True,
        passwords=[f"+{password}"],
        keys=["*"],
        categories=["+@all"],
        commands=["-config"],
    )
    address = redis.connection_pool.connection_kwargs
    limited = Redis(
        host=address["host"],
        port=address["port"],
        db=address["db"],
        username=name,
        password=password,
    )
    try:
        assert await limited.ping()  # the user works; only CONFIG is refused

        def guard(assume: bool) -> EphemeralRedisGuard:
            return EphemeralRedisGuard(
                limited, enforce=True, assume_ephemeral=assume, recheck_seconds=RECHECK
            )

        assert await refusal_of(guard(False)) == "unverifiable"
        await guard(True).require()
    finally:
        await limited.aclose()
        await redis.acl_deluser(name)


# B1: which Redis, by environment


@pytest.mark.parametrize(
    ("app_env", "location_url", "own_redis", "enforced"),
    [
        ("development", None, False, False),  # the fallback: REDIS_URL's
        ("test", None, False, False),
        ("development", OTHER_REDIS_URL, True, False),
        ("staging", OTHER_REDIS_URL, True, True),
        ("production", OTHER_REDIS_URL, True, True),
    ],
)
async def test_which_redis_holds_the_positions(
    monkeypatch: pytest.MonkeyPatch,
    dead_redis: Redis,
    app_env: str,
    location_url: str | None,
    own_redis: bool,
    enforced: bool,
) -> None:
    settings = make_settings(location_redis_url=location_url)
    # Only the branch under test: the deployed validators need many other settings.
    monkeypatch.setattr(settings, "app_env", app_env)

    backend = location_backend(settings, dead_redis)

    assert backend is not None
    try:
        assert (backend.redis is not dead_redis) == own_redis
        assert backend.guard.enforce is enforced
        if own_redis:
            address = backend.redis.connection_pool.connection_kwargs
            assert (address["host"], address["port"], address["db"]) == (
                "positions.invalid",
                6380,
                3,
            )
    finally:
        if own_redis:
            await backend.redis.aclose()


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_staging_and_production_never_fall_back_to_the_shared_redis(
    monkeypatch: pytest.MonkeyPatch, dead_redis: Redis, app_env: str
) -> None:
    settings = make_settings()
    monkeypatch.setattr(settings, "app_env", app_env)

    assert location_backend(settings, dead_redis) is None


def test_location_redis_settings() -> None:
    defaults = make_settings()
    assert defaults.location_redis_url is None
    assert defaults.location_redis_assume_ephemeral is False
    assert defaults.location_redis_recheck_seconds == 60
    assert make_settings(location_redis_url="").location_redis_url is None
    assert make_settings(location_redis_url=OTHER_REDIS_URL).location_redis_url == OTHER_REDIS_URL
    with pytest.raises(ValidationError) as refused:
        make_settings(location_redis_url="https://default:hunter2@positions.invalid")
    assert "LOCATION_REDIS_URL must start with" in str(refused.value)
    assert "hunter2" not in str(refused.value)  # the URL holds the password
    with pytest.raises(ValidationError):
        make_settings(location_redis_recheck_seconds=0)


@pytest.mark.parametrize(
    ("app_env", "extra", "event"),
    [
        ("staging", {}, "location_redis_not_configured"),
        ("production", {}, "location_redis_not_configured"),
        (
            "production",
            {"location_redis_url": OTHER_REDIS_URL, "location_redis_assume_ephemeral": True},
            "location_redis_assume_ephemeral_set",
        ),
        ("production", {"location_redis_url": OTHER_REDIS_URL}, None),
        ("development", {}, None),
        ("test", {}, None),
    ],
)
async def test_startup_says_what_the_positions_run_on(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    app_env: str,
    extra: dict[str, object],
    event: str | None,
) -> None:
    settings = make_settings(**extra)
    monkeypatch.setattr(settings, "app_env", app_env)
    app = create_app(settings)

    with caplog.at_level(logging.DEBUG):
        async with app.router.lifespan_context(app):
            backend = app.state.location_backend

    events = [
        (r.levelname, r.getMessage())
        for r in caplog.records
        if r.name == "app.main" and r.getMessage().startswith("location_redis")
    ]
    assert events == ([("WARNING", event)] if event else [])
    assert (backend is None) == (event == "location_redis_not_configured")


# B1: the routes on a store that is missing or refused


def refused_backend(reason: str, redis: Redis) -> LocationBackend | None:
    """What startup would leave on the app's state: no backend, or the real test Redis behind
    a check that refuses it."""
    if reason == "not_configured":
        return None
    fake = (
        ConfigOnly(SNAPSHOTS)
        if reason == "not_ephemeral"
        else ConfigOnly(error=NoPermissionError(CONFIG_DENIED))
    )
    return LocationBackend(redis, guard_on(fake))


def use_the_apps_own_store(app: FastAPI, backend: LocationBackend | None) -> None:
    app.state.location_backend = backend
    del app.dependency_overrides[get_job_location_store]


@pytest.mark.parametrize("reason", ["not_configured", "not_ephemeral", "unverifiable"])
async def test_missing_or_refused_store_answers_503_and_keeps_nothing(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    redis: Redis,
    clock: list[datetime],
    caplog: pytest.LogCaptureFixture,
    reason: str,
) -> None:
    use_the_apps_own_store(app, refused_backend(reason, redis))
    job = await on_the_way_job(db_session, world)
    done = await make_job(db_session, world, JobStatus.COMPLETED)
    key = f"{KEY_PREFIX}:{job.id}"
    ids = {"job_id": str(job.id), "pro_id": str(world.pro.profile_id)}

    with caplog.at_level(logging.DEBUG):
        sent = await ping(db_client, job.id, world.pro)
        got = await read(db_client, job.id, world.customer)
        # The job is still looked at first: these never reach the store.
        foreign = await ping(db_client, job.id, world.other_pro, fix(lat=LAT2, lng=LNG2))
        late = await ping(db_client, done.id, world.pro, fix(lat=LAT2, lng=LNG2))
        untracked = await read(db_client, done.id, world.customer)

    assert (sent.status_code, sent.json()) == (503, UNAVAILABLE)
    assert (got.status_code, got.json()) == (503, UNAVAILABLE)
    assert [foreign.status_code, late.status_code] == [404, 409]
    assert (untracked.status_code, untracked.json()) == (200, NO_POSITION)
    assert await redis.exists(key) == 0  # the position never went to Redis
    logged = [
        (
            r.levelname,
            r.getMessage(),
            getattr(r, "job_id", None),
            getattr(r, "pro_id", None),
            getattr(r, "reason", None),
        )
        for r in caplog.records
        if r.name == LOCATION_LOGGER
    ]
    assert logged == [
        ("ERROR", "pro_location_refused", ids["job_id"], ids["pro_id"], reason),
        ("ERROR", "pro_location_refused", ids["job_id"], None, reason),
    ]
    # Ids, the event and the reason only: no coordinate in any log line or answer.
    logs = log_fields(caplog.records)
    for needle in NEEDLES:
        assert [field for field in logs if needle in field] == [], needle
        for response in (sent, got, foreign, late, untracked):
            assert needle not in response.text, needle
    for record in caplog.records:
        if record.name in (LOCATION_LOGGER, GUARD_LOGGER):
            extras = set(vars(record)) - set(vars(logging.makeLogRecord({})))
            assert extras <= {
                "job_id",
                "pro_id",
                "reason",
                "unsafe",
                "unreadable",
                "enforced",
                "request_id",
                "message",
                "asctime",
            }, extras
    assert not any(r.exc_info for r in caplog.records)


async def check_in_and_start(
    client: httpx.AsyncClient, job_id: uuid.UUID, world: JobWorld
) -> list[int]:
    checked_in = await client.post(
        f"/v1/pros/me/jobs/{job_id}/check-in",
        json={"arrival_code": CODE, "lat": 28.5, "lng": -81.3},
        headers=world.pro.headers,
    )
    started = await client.post(f"/v1/pros/me/jobs/{job_id}/start", headers=world.pro.headers)
    return [checked_in.status_code, started.status_code]


@pytest.mark.parametrize("reason", ["not_ephemeral", "unverifiable"])
async def test_a_refused_store_still_deletes(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    redis: Redis,
    clock: list[datetime],
    reason: str,
) -> None:
    """A position written before the Redis was refused (its settings changed while the API
    ran) is still removed when its tracking ends: a delete carries no position."""
    use_the_apps_own_store(app, refused_backend(reason, redis))
    job = await on_the_way_job(db_session, world)
    written = RedisJobLocationStore(redis, timeout_seconds=STORE_TIMEOUT)  # the app's prefix
    try:
        await plant(written, job.id)
        assert (await read(db_client, job.id, world.customer)).status_code == 503

        assert await check_in_and_start(db_client, job.id, world) == [200, 200]

        assert await redis.exists(written.key(job.id)) == 0
    finally:
        await redis.delete(written.key(job.id))


async def test_a_missing_store_never_holds_a_job_step(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: list[datetime],
    caplog: pytest.LogCaptureFixture,
) -> None:
    use_the_apps_own_store(app, None)
    job = await on_the_way_job(db_session, world)

    with caplog.at_level(logging.DEBUG):
        assert await check_in_and_start(db_client, job.id, world) == [200, 200]

    assert not [r for r in caplog.records if r.name == LOCATION_LOGGER]  # nothing to delete


async def test_development_and_test_fall_back_to_the_shared_redis(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    redis: Redis,
    clock: list[datetime],
    settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No LOCATION_REDIS_URL in test: startup's backend is the app's own Redis, and whatever
    that Redis keeps is logged, never refused."""
    use_the_apps_own_store(app, location_backend(settings, redis))
    job = await on_the_way_job(db_session, world)
    key = f"{KEY_PREFIX}:{job.id}"
    try:
        with caplog.at_level(logging.DEBUG):
            assert (await ping(db_client, job.id, world.pro)).status_code == 204
            position = await shown(db_client, job.id, world)

        assert (position["lat"], position["lng"]) == (LAT, LNG)
        assert await redis.exists(key) == 1
    finally:
        await redis.delete(key)
    [(level, _, _, unreadable, enforced)] = said(caplog)  # asked once for the two calls
    assert level in ("INFO", "WARNING")
    assert (unreadable, enforced) == ([], False)


# B2: no HTTP cache may keep a response of the position routes


class Crashes(NoJobLocationStore):
    async def put(
        self, job_id: uuid.UUID, position: Position, *, min_interval: timedelta, ttl_seconds: int
    ) -> bool:
        raise RuntimeError("an unexpected bug")


async def test_every_position_response_says_no_store(
    app: FastAPI,
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    store: RedisJobLocationStore,
    dead_redis: Redis,
    clock: list[datetime],
    settings: Settings,
) -> None:
    job = await on_the_way_job(db_session, world)
    done = await make_job(db_session, world, JobStatus.COMPLETED)
    down = RedisJobLocationStore(dead_redis, timeout_seconds=0.3, prefix="jobloc-test-down")
    body = fix()
    responses: dict[str, httpx.Response] = {}

    responses["read: none yet"] = await read(db_client, job.id, world.customer)
    responses["ping: kept"] = await ping(db_client, job.id, world.pro)
    responses["ping: dropped"] = await ping(db_client, job.id, world.pro)
    responses["read: shown"] = await read(db_client, job.id, world.customer)
    responses["ping: anonymous"] = await db_client.put(url(job.id), json=body)
    responses["read: anonymous"] = await db_client.get(url(job.id))
    responses["ping: not a pro"] = await ping(db_client, job.id, world.customer)
    responses["read: not a customer"] = await read(db_client, job.id, world.pro)
    responses["ping: another's job"] = await ping(db_client, job.id, world.other_pro)
    responses["read: another's job"] = await read(db_client, job.id, world.other_customer)
    responses["ping: not on the way"] = await ping(db_client, done.id, world.pro)
    responses["ping: invalid"] = await ping(db_client, job.id, world.pro, fix(lat=95.123457))
    responses["read: invalid id"] = await db_client.get(
        "/v1/jobs/not-a-uuid/pro-location", headers=world.customer.headers
    )
    responses["wrong method"] = await db_client.post(
        url(job.id), json=body, headers=world.pro.headers
    )
    app.dependency_overrides[get_job_location_store] = lambda: down
    responses["ping: store down"] = await ping(db_client, job.id, world.pro)
    responses["read: store down"] = await read(db_client, job.id, world.customer)
    app.dependency_overrides[get_job_location_store] = NoJobLocationStore
    responses["ping: store refused"] = await ping(db_client, job.id, world.pro)
    responses["read: store refused"] = await read(db_client, job.id, world.customer)
    app.dependency_overrides[get_job_location_store] = Crashes
    responses["ping: crash"] = await ping(db_client, job.id, world.pro)
    settings.pro_location_rate_limit = 1  # this pro is far past it
    responses["ping: flood"] = await ping(db_client, job.id, world.pro)
    elsewhere = await db_client.get("/health")

    assert {name: r.status_code for name, r in responses.items()} == {
        "read: none yet": 200,
        "ping: kept": 204,
        "ping: dropped": 204,
        "read: shown": 200,
        "ping: anonymous": 401,
        "read: anonymous": 401,
        "ping: not a pro": 403,
        "read: not a customer": 403,
        "ping: another's job": 404,
        "read: another's job": 404,
        "ping: not on the way": 409,
        "ping: invalid": 422,
        "read: invalid id": 422,
        "wrong method": 405,
        "ping: store down": 503,
        "read: store down": 200,
        "ping: store refused": 503,
        "read: store refused": 503,
        "ping: crash": 500,
        "ping: flood": 429,
    }
    assert responses["read: none yet"].json() == NO_POSITION
    assert responses["read: shown"].json()["position"]["lat"] == LAT
    # `private` or `no-cache` would still let a cache store the response: exactly no-store.
    assert {name: r.headers.get("cache-control") for name, r in responses.items()} == dict.fromkeys(
        responses, "no-store"
    )
    assert responses["ping: flood"].headers["retry-after"]  # the handler's own header stays
    assert responses["ping: crash"].headers["x-request-id"]
    # Only these routes: the header is the route's, not the app's.
    assert elsewhere.status_code == 200
    assert "cache-control" not in elsewhere.headers
