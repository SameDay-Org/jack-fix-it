"""Geocode on save (#384): a request's address gets its point once, from the worker, with
Mapbox's permanent geocoding, behind GEOCODE_ON_SAVE. Never calls Mapbox."""

import dataclasses
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from decimal import Decimal
from typing import Any

import httpx
import pytest
import sentry_sdk
from arq.worker import Function
from redis.exceptions import RedisError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.mapbox import (
    Coordinate,
    KeptGeocode,
    MapboxRouteProvider,
    MapboxUnavailableError,
    StreetAddress,
    UnconfiguredRouteProvider,
)
from app.integrations.storage import get_storage
from app.modules.addresses.geocode import (
    GEOCODE_TASK,
    POINT_PLACES,
    AddressGeocodeService,
    GeocodeOutcome,
    geocode_job_id,
    rounded,
    same_area,
)
from app.modules.addresses.models import Address
from app.modules.addresses.tasks import geocode_address
from app.modules.requests.models import ServiceRequest
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import MAPBOX_URL_LABEL, configure_logging, init_sentry
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter
from app.worker import WorkerSettings
from tests.conftest import InMemoryRateLimiter, _rolled_back_session, make_app, make_settings
from tests.helpers import log_fields, masked_fields
from tests.test_requests_api import (
    ENQUEUE_TIMEOUT,
    FakeStorage,
    RecordingQueue,
    create,
    make_caller,
    make_category,
    queue,
    served,
    storage,
)
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport

# Fixtures, used by name.
__all__ = ["queue", "sentry_transport", "served", "storage"]

GEOCODE_LOGGER = "app.modules.addresses.geocode"
MAPBOX_LOGGER = "app.integrations.mapbox"
# Fixture values only: no real token, no real place. Words and digits nothing else spells.
TOKEN = "pk.test-geocode-token-not-real"
STREET = "9471 Zephyrquill Lane"
UNIT = "Unit 7Q-probe"
CITY = "Quillhaven"
STATE = "FL"
ZIP = "32801-4455"  # the ZIP `served` serves, with its +4
FOUND = Coordinate(lat=28.5383551, lng=-81.3792365)
KEPT_LAT, KEPT_LNG = Decimal("28.53836"), Decimal("-81.37924")
VENDOR_TEXT = "Mapbox says: probe-vendor-geocode"
# The ZIP is no needle: five digits can turn up in a log line's own timestamp or in an id.
NEEDLES = (
    TOKEN,
    "Zephyrquill",
    "7Q-probe",
    "Quillhaven",
    "28.5383",
    "81.3792",
    "probe-vendor-geocode",
    "api.mapbox.com",
)
ASKED = StreetAddress(line1=STREET, city=CITY, state=STATE, zip_code=ZIP)


def kept(
    region: str | None = "FL", postcode: str | None = "32801", point: Coordinate = FOUND
) -> KeptGeocode:
    return KeptGeocode(coordinate=point, region_code=region, postcode=postcode)


class FakeGeocoder:
    """An AddressGeocoder that records what it is asked. `answer` is what Mapbox says (raised
    when it is an exception); `meanwhile` runs while it "answers"."""

    def __init__(self, session: AsyncSession | None = None) -> None:
        self.asked: list[StreetAddress] = []
        self.answer: KeptGeocode | Exception | None = kept()
        self.meanwhile: Callable[[], Awaitable[None]] | None = None
        self.in_transaction: list[bool] = []
        self._session = session

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        self.asked.append(address)
        if self._session is not None:
            self.in_transaction.append(self._session.in_transaction())
        if self.meanwhile is not None:
            await self.meanwhile()
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def sessions_of(
    session: AsyncSession,
) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    """A session factory that hands out the rolled-back test session."""

    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


async def make_address(session: AsyncSession, **fields: Any) -> Address:
    user = User(
        email=f"customer-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.CUSTOMER
    )
    session.add(user)
    await session.flush()
    values: dict[str, Any] = {
        "line1": STREET,
        "line2": UNIT,
        "city": CITY,
        "state": STATE,
        "zip_code": ZIP,
        **fields,
    }
    address = Address(user_id=user.id, **values)
    session.add(address)
    await session.flush()
    return address


async def point_of(session: AsyncSession, address_id: uuid.UUID) -> tuple[Any, Any]:
    """The row's lat and lng as the database has them (not as the session remembers them)."""
    row = (
        await session.execute(select(Address.lat, Address.lng).where(Address.id == address_id))
    ).one()
    return row[0], row[1]


def service(
    session: AsyncSession, geocoder: FakeGeocoder, *, enabled: bool = True
) -> AddressGeocodeService:
    return AddressGeocodeService(session, geocoder, enabled=enabled)


@pytest.fixture
def settings() -> Settings:
    return make_settings(geocode_on_save=True, job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT)


# The switch


def test_the_switch_is_off_by_default() -> None:
    assert make_settings().geocode_on_save is False
    assert (
        make_settings().geocode_backfill_batch_size,
        make_settings().geocode_backfill_per_minute,
    ) == (100, 300)


async def test_switch_off_asks_mapbox_nothing(db_session: AsyncSession) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder()

    outcome = await service(db_session, geocoder, enabled=False).geocode(address.id)

    assert outcome is GeocodeOutcome.OFF
    assert geocoder.asked == []
    assert await point_of(db_session, address.id) == (None, None)


# The point, once


async def test_an_address_gets_its_point_once(db_session: AsyncSession) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder(db_session)

    first = await service(db_session, geocoder).geocode(address.id)
    again = await service(db_session, geocoder).geocode(address.id)

    assert (first, again) == (GeocodeOutcome.STORED, GeocodeOutcome.ALREADY)
    # Asked once, by the street line and the place: the unit line never leaves.
    assert geocoder.asked == [ASKED]
    assert "line2" not in {field.name for field in dataclasses.fields(StreetAddress)}
    # Rounded to five decimals: the column would take a sixth.
    assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)
    # No transaction of ours is open while Mapbox answers.
    assert geocoder.in_transaction == [False]
    # The rest of the row is as it was.
    row = (
        await db_session.execute(
            select(
                Address.line1, Address.line2, Address.city, Address.state, Address.zip_code
            ).where(Address.id == address.id)
        )
    ).one()
    assert tuple(row) == (STREET, UNIT, CITY, STATE, ZIP)


async def test_a_row_with_half_a_point_is_one_without(db_session: AsyncSession) -> None:
    address = await make_address(db_session, lat=Decimal("1.5"))
    geocoder = FakeGeocoder()

    assert await service(db_session, geocoder).geocode(address.id) is GeocodeOutcome.STORED
    assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)


async def test_no_such_address_asks_nothing(db_session: AsyncSession) -> None:
    geocoder = FakeGeocoder()

    assert await service(db_session, geocoder).geocode(uuid.uuid4()) is GeocodeOutcome.MISSING
    assert geocoder.asked == []


@pytest.mark.parametrize(
    ("answer", "outcome"),
    [
        (None, GeocodeOutcome.NO_RESULT),
        (MapboxUnavailableError(), GeocodeOutcome.UNAVAILABLE),
        (kept(region="GA"), GeocodeOutcome.MISMATCH),
        (kept(postcode="32802"), GeocodeOutcome.MISMATCH),
        (kept(region=None), GeocodeOutcome.MISMATCH),
        (kept(postcode=None), GeocodeOutcome.MISMATCH),
    ],
    ids=["no_result", "unavailable", "other_state", "other_zip", "no_state", "no_zip"],
)
async def test_an_answer_that_is_not_the_address_keeps_nothing(
    db_session: AsyncSession, answer: KeptGeocode | Exception | None, outcome: GeocodeOutcome
) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder()
    geocoder.answer = answer

    assert await service(db_session, geocoder).geocode(address.id) is outcome

    # The address is saved as it was, without a point: its route places it by itself.
    assert geocoder.asked == [ASKED]
    assert await point_of(db_session, address.id) == (None, None)


@pytest.mark.parametrize(
    ("found", "same"),
    [
        (kept("FL", "32801"), True),
        (kept("fl", "32801-9999"), True),  # the state's case and a +4 do not matter
        (kept("GA", "32801"), False),
        (kept("FL", "32802"), False),
        (kept("FL", "3280"), False),
        (kept(None, "32801"), False),
        (kept("FL", None), False),
    ],
)
def test_same_area_needs_the_state_and_the_five_digit_zip(found: KeptGeocode, same: bool) -> None:
    assert same_area(ASKED, found) is same


@pytest.mark.parametrize(
    ("degrees", "stored"),
    [
        (28.5383551, "28.53836"),
        (-81.3792365, "-81.37924"),
        (0.000005, "0.00001"),  # a tie goes away from zero, as Postgres rounds
        (-0.000005, "-0.00001"),
        (26.1, "26.10000"),
    ],
)
def test_a_coordinate_is_stored_to_five_decimals(degrees: float, stored: str) -> None:
    assert POINT_PLACES == 5
    assert str(rounded(degrees)) == stored


# The write is conditional


async def test_a_point_never_lands_on_a_changed_text(db_session: AsyncSession) -> None:
    """Nothing edits a request's address today. Were one edited while Mapbox answers, the
    point found for the old text is dropped."""
    address = await make_address(db_session)
    geocoder = FakeGeocoder()

    async def edit() -> None:
        await db_session.execute(
            update(Address).where(Address.id == address.id).values(line1="1 Other Street")
        )

    geocoder.meanwhile = edit

    assert await service(db_session, geocoder).geocode(address.id) is GeocodeOutcome.CHANGED
    assert await point_of(db_session, address.id) == (None, None)


@pytest.mark.parametrize("field", ["city", "state", "zip_code"])
async def test_each_part_of_the_place_guards_the_point(
    db_session: AsyncSession, field: str
) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder()
    other = {"city": "Elsewhere", "state": "GA", "zip_code": "32801"}[field]

    async def edit() -> None:
        await db_session.execute(
            update(Address).where(Address.id == address.id).values({field: other})
        )

    geocoder.meanwhile = edit

    assert await service(db_session, geocoder).geocode(address.id) is GeocodeOutcome.CHANGED
    assert await point_of(db_session, address.id) == (None, None)


async def test_a_point_kept_meanwhile_is_not_replaced(db_session: AsyncSession) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder()
    theirs = (Decimal("28.10000"), Decimal("-81.20000"))

    async def another_run_keeps_its_point() -> None:
        await db_session.execute(
            update(Address).where(Address.id == address.id).values(lat=theirs[0], lng=theirs[1])
        )

    geocoder.meanwhile = another_run_keeps_its_point

    assert await service(db_session, geocoder).geocode(address.id) is GeocodeOutcome.CHANGED
    assert await point_of(db_session, address.id) == theirs


# The worker task


def task_ctx(session: AsyncSession, geocoder: object, **settings: object) -> dict[str, object]:
    return {
        "session_factory": sessions_of(session),
        "address_geocoder": geocoder,
        "settings": make_settings(**settings),
    }


async def test_the_task_keeps_the_point(db_session: AsyncSession) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder()
    ctx = task_ctx(db_session, geocoder, geocode_on_save=True)

    assert await geocode_address(ctx, str(address.id)) == "stored"
    # ARQ may run a job twice: the second run asks Mapbox nothing.
    assert await geocode_address(ctx, str(address.id)) == "already"

    assert geocoder.asked == [ASKED]
    assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)


async def test_a_job_queued_before_the_switch_went_off_asks_nothing(
    db_session: AsyncSession,
) -> None:
    address = await make_address(db_session)
    geocoder = FakeGeocoder()

    outcome = await geocode_address(task_ctx(db_session, geocoder), str(address.id))

    assert outcome == "off"
    assert geocoder.asked == []
    assert await point_of(db_session, address.id) == (None, None)


async def test_without_a_token_the_task_keeps_nothing(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    address = await make_address(db_session)
    ctx = task_ctx(db_session, UnconfiguredRouteProvider(), geocode_on_save=True)

    with caplog.at_level(logging.DEBUG):
        assert await geocode_address(ctx, str(address.id)) == "unavailable"

    assert await point_of(db_session, address.id) == (None, None)
    # A known state of a deploy: two warnings, no Sentry event.
    assert [(r.name, r.levelno, r.message) for r in caplog.records if r.name != "asyncio"] == [
        (MAPBOX_LOGGER, logging.WARNING, "mapbox_not_configured"),
        (GEOCODE_LOGGER, logging.WARNING, "address_geocode_not_kept"),
    ]


def test_the_worker_runs_the_task_once_and_keeps_no_result() -> None:
    [function] = [
        f for f in WorkerSettings.functions if isinstance(f, Function) and f.name == GEOCODE_TASK
    ]
    assert function.coroutine is geocode_address
    # One try: each run that reaches Mapbox is a billed call.
    assert function.max_tries == 1
    assert (function.keep_result_s, function.keep_result_forever) == (0, False)


# POST /v1/requests queues it, after the commit, with the switch on


async def address_of(session: AsyncSession, request_id: str) -> uuid.UUID:
    address_id = await session.scalar(
        select(ServiceRequest.address_id).where(ServiceRequest.id == uuid.UUID(request_id))
    )
    assert address_id is not None
    return address_id


PROBE_ADDRESS = {"line1": STREET, "line2": UNIT, "city": CITY, "state": STATE, "zip_code": ZIP}


async def test_a_new_request_queues_the_geocode_of_its_address(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana = await make_caller(db_session)
    category_id = await make_category(db_session)
    photo = ana.media_key(".jpg")

    response = await create(
        db_client, ana, category_id=str(category_id), address=PROBE_ADDRESS, media_keys=[photo]
    )

    assert response.status_code == 201, response.text
    request_id = response.json()["id"]
    address_id = await address_of(db_session, request_id)
    # Last, after dispatch and the media copies; the address id and nothing else travels.
    assert list(queue.jobs.items()) == [
        (f"dispatch:{request_id}", ("dispatch_request", (request_id,))),
        (f"sanitize:{request_id}", ("sanitize_request_media", (request_id,))),
        (geocode_job_id(address_id), (GEOCODE_TASK, (str(address_id),))),
    ]
    assert geocode_job_id(address_id) == f"geocode-address:{address_id}"
    # The save itself asked nothing and wrote no point: the answer has no coordinate either.
    assert await point_of(db_session, address_id) == (None, None)
    assert response.json()["address"] == PROBE_ADDRESS


async def test_switch_off_queues_no_geocode(
    db_session: AsyncSession, storage: FakeStorage, queue: RecordingQueue
) -> None:
    # An app of the default settings: GEOCODE_ON_SAVE is false.
    app = make_app(make_settings(job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT))
    app.state.rolled_back_session = db_session
    app.dependency_overrides[get_session] = _rolled_back_session
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_job_queue] = lambda: queue
    limiter = InMemoryRateLimiter()
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    ana = await make_caller(db_session)
    category_id = await make_category(db_session)

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await create(client, ana, category_id=str(category_id))

    assert response.status_code == 201, response.text
    assert [function for function, _ in queue.jobs.values()] == ["dispatch_request"]


async def test_a_replay_queues_nothing_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana = await make_caller(db_session)
    category_id = await make_category(db_session)
    headers = {**ana.headers, "Idempotency-Key": str(uuid.uuid4())}
    body = {"description": "Probe", "address": PROBE_ADDRESS, "category_id": str(category_id)}

    first = await db_client.post("/v1/requests", json=body, headers=headers)
    enqueues = len(queue.before)
    replay = await db_client.post("/v1/requests", json=body, headers=headers)

    assert (first.status_code, replay.status_code) == (201, 200)
    assert enqueues == 2  # dispatch, then the geocode
    assert len(queue.before) == enqueues  # the replay made no address: nothing to place


@pytest.mark.parametrize("failure", [RedisError("probe"), TimeoutError()], ids=["redis", "slow"])
async def test_a_geocode_that_cannot_be_queued_never_fails_the_request(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
    failure: Exception,
) -> None:
    ana = await make_caller(db_session)
    category_id = await make_category(db_session)
    queue.failure = failure

    with caplog.at_level(logging.DEBUG):
        response = await create(db_client, ana, category_id=str(category_id), address=PROBE_ADDRESS)

    assert response.status_code == 201, response.text
    request_id = response.json()["id"]
    address_id = await address_of(db_session, request_id)
    [record] = [r for r in caplog.records if r.message == "address_geocode_enqueue_failed"]
    assert record.levelno == logging.ERROR
    assert (record.__dict__["service_request_id"], record.__dict__["address_id"]) == (
        request_id,
        str(address_id),
    )
    for needle in NEEDLES:
        assert [field for field in log_fields(caplog.records) if needle in field] == [], needle


async def test_a_queue_that_hangs_holds_the_save_for_the_enqueue_timeout_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    ana = await make_caller(db_session)
    category_id = await make_category(db_session)
    queue.hang = True

    response = await create(db_client, ana, category_id=str(category_id))

    # JOB_ENQUEUE_TIMEOUT_SECONDS ended each enqueue: the request is saved all the same.
    assert response.status_code == 201, response.text
    assert len(queue.before) == 2


# Privacy: ids and outcomes only, in the logs and in Sentry


LOG_EXTRAS = {"address_id", "outcome", "api", "status_code", "error", "reason"}


def _feature(region: str = "FL", postcode: str = "32801") -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [FOUND.lng, FOUND.lat]},
        "properties": {
            "feature_type": "address",
            "full_address": f"{STREET}, {CITY}, Florida 32801, United States",
            "context": {
                "region": {"name": "Florida", "region_code": region},
                "postcode": {"name": postcode},
                "place": {"name": CITY},
            },
        },
    }


class Mapbox:
    """Mapbox's side of the wire: answers each call with the next of `answers`."""

    def __init__(self, *answers: httpx.Response) -> None:
        self.answers = list(answers)
        self.asked: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(request)
        return self.answers.pop(0)

    def provider(self) -> MapboxRouteProvider:
        return MapboxRouteProvider(
            access_token=TOKEN, timeout_seconds=0.5, transport=httpx.MockTransport(self)
        )


def found_response(**area: str) -> httpx.Response:
    return httpx.Response(200, json={"type": "FeatureCollection", "features": [_feature(**area)]})


async def test_logs_carry_the_address_id_and_the_outcome_only(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    """The real client against a fake wire, at LOG_LEVEL=DEBUG: a point kept, an answer in
    another ZIP, no such address, and Mapbox refusing with the address in its own text."""
    configure_logging("DEBUG")
    mapbox = Mapbox(
        found_response(),
        found_response(postcode="32899"),
        httpx.Response(200, json={"type": "FeatureCollection", "features": []}),
        httpx.Response(403, json={"message": f"{VENDOR_TEXT}: {STREET}, {CITY}"}),
    )
    addresses = [await make_address(db_session) for _ in range(4)]
    ctx = task_ctx(db_session, mapbox.provider(), geocode_on_save=True)

    with caplog.at_level(logging.DEBUG):
        outcomes = [await geocode_address(ctx, str(address.id)) for address in addresses]

    assert outcomes == ["stored", "mismatch", "no_result", "unavailable"]
    # The four calls said they were to be kept, and carried the address in the query only.
    assert [request.url.params["permanent"] for request in mapbox.asked] == ["true"] * 4
    assert all(request.method == "GET" for request in mapbox.asked)
    ours = [r for r in caplog.records if r.name in (GEOCODE_LOGGER, MAPBOX_LOGGER)]
    assert [(r.levelname, r.message, r.__dict__.get("outcome")) for r in ours] == [
        ("INFO", "address_geocoded", "stored"),
        ("WARNING", "address_geocode_not_kept", "mismatch"),
        ("WARNING", "address_geocode_not_kept", "no_result"),
        ("ERROR", "mapbox_failed", None),
        ("WARNING", "address_geocode_not_kept", "unavailable"),
    ]
    geocode_records = [r for r in ours if r.name == GEOCODE_LOGGER]
    assert [r.__dict__["address_id"] for r in geocode_records] == [str(a.id) for a in addresses]
    for record in ours:
        extras = set(vars(record)) - set(vars(logging.makeLogRecord({})))
        assert extras <= LOG_EXTRAS | {"message", "asctime"}, extras
    output = log_fields(caplog.records)
    for needle in NEEDLES:
        assert [field for field in output if needle in field] == [], needle


async def test_nothing_reaches_sentry(
    sentry_transport: MemoryTransport, db_session: AsyncSession
) -> None:
    """Sentry on, sending to memory. A point kept, then Mapbox refusing the next address (its
    ERROR log is an event, with both calls among its breadcrumbs): no token, address,
    coordinate, vendor text or vendor URL in it."""
    init_sentry(make_settings(sentry_dsn=TEST_DSN))
    sentry_sdk.get_isolation_scope().clear_breadcrumbs()
    mapbox = Mapbox(
        found_response(),
        httpx.Response(403, json={"message": f"{VENDOR_TEXT}: {STREET}, {CITY}"}),
    )
    first, second = await make_address(db_session), await make_address(db_session)
    ctx = task_ctx(db_session, mapbox.provider(), geocode_on_save=True)

    outcomes = [await geocode_address(ctx, str(a.id)) for a in (first, second)]
    sentry_sdk.flush()

    assert outcomes == ["stored", "unavailable"]
    events = [json.loads(payload) for payload in _payloads(sentry_transport)]
    [failed] = [e for e in events if e.get("logentry", {}).get("message") == "mapbox_failed"]
    calls = [c["data"] for c in failed["breadcrumbs"]["values"] if c.get("type") == "http"]
    # Both calls left a breadcrumb: the method and the status, never the URL (the address).
    assert [(c["http.method"], c["url"]) for c in calls] == [("GET", MAPBOX_URL_LABEL)] * 2
    assert all("http.query" not in c for c in calls)
    wire = masked_fields(events)
    for needle in NEEDLES:
        assert [field for field in wire if needle in field] == [], needle
