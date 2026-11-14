"""scripts/backfill_address_geocodes.py (#384): a dry run by default, counts only, idempotent,
paced; --apply only with an operator at a terminal who types the number of addresses, and one
caller per address. Never calls Mapbox."""

import io
import re
import sys
import uuid
from typing import TextIO, cast

import pytest
from pydantic import ValidationError
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.mapbox import KeptGeocode, MapboxUnavailableError, StreetAddress
from app.modules.addresses.geocode_claim import RedisGeocodeClaims, claim_seconds
from app.modules.addresses.models import Address
from scripts import backfill_address_geocodes as backfill
from tests.conftest import make_settings
from tests.test_address_geocode import (
    CITY,
    FOUND,
    KEPT_LAT,
    KEPT_LNG,
    NEEDLES,
    STREET,
    TOKEN,
    FakeGeocoder,
    MemoryGeocodeClaims,
    kept,
    make_address,
    point_of,
    sessions_of,
)

BATCH = 2
PER_MINUTE = 120  # a pause of half a second between two calls


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "geocode_on_save": True,
        "mapbox_access_token": TOKEN,
        "geocode_backfill_batch_size": BATCH,
        "geocode_backfill_per_minute": PER_MINUTE,
        **overrides,
    }
    return make_settings(**values)


class ByStreet(FakeGeocoder):
    """Answers by the street asked about: `answers[line1]`; any other address is found in
    its own state and ZIP (the test database may hold other tests' committed rows, which the
    script reads too), unless `down` is set: then every call is unavailable."""

    def __init__(self) -> None:
        super().__init__()
        self.answers: dict[str, KeptGeocode | Exception | None] = {}
        self.down = False

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        in_place = kept(region=address.state, postcode=address.zip_code[:5])
        self.answer = (
            MapboxUnavailableError() if self.down else self.answers.get(address.line1, in_place)
        )
        return await super().geocode_to_keep(address)


class Terminal:
    """Standard input with an operator at a terminal, who types `answer`: by default the
    number the script asks for on `out`, where the terminal shows what is typed. An empty
    `answer` is the end of the input. `tty=False` is the same line in a pipe or a file: no
    terminal, nobody there."""

    def __init__(self, out: io.StringIO, answer: str | None = None, *, tty: bool = True) -> None:
        self._out = out
        self._answer = answer
        self._tty = tty
        self.lines_read = 0

    def isatty(self) -> bool:
        return self._tty

    def readline(self) -> str:
        self.lines_read += 1
        answer = self._answer
        if answer is None:
            [count] = re.findall(r"^Type (\d+) to go on", self._out.getvalue(), flags=re.MULTILINE)
            answer = f"{count}\n"
        self._out.write(answer)  # the terminal shows what is typed
        return answer


class Run:
    def __init__(self, session: AsyncSession, geocoder: FakeGeocoder) -> None:
        self.session = session
        self.geocoder = geocoder
        self.claims = MemoryGeocodeClaims()
        self.pauses: list[float] = []
        self.lines_read = 0  # of the last run's standard input

    async def _sleep(self, seconds: float) -> None:
        self.pauses.append(seconds)

    async def __call__(
        self,
        *argv: str,
        config: Settings | None = None,
        answer: str | None = None,
        tty: bool = True,
    ) -> tuple[int, str]:
        out = io.StringIO()
        terminal = Terminal(out, answer, tty=tty)
        code = await backfill.run(
            argv,
            sessions_of(self.session),
            config or settings(),
            self.geocoder,
            out,
            sleep=self._sleep,
            claims=self.claims,
            stdin=cast(TextIO, terminal),
        )
        self.lines_read = terminal.lines_read
        return code, out.getvalue()


@pytest.fixture
def geocoder() -> ByStreet:
    return ByStreet()


@pytest.fixture
def run(db_session: AsyncSession, geocoder: ByStreet) -> Run:
    return Run(db_session, geocoder)


async def without_point(session: AsyncSession) -> int:
    """The rows the script sees: the test database may hold other tests' committed rows."""
    rows = await session.scalars(
        select(Address.id).where(Address.lat.is_(None) | Address.lng.is_(None))
    )
    return len(rows.all())


def asked_streets(geocoder: FakeGeocoder) -> list[str]:
    return [address.line1 for address in geocoder.asked]


def line(output: str, label: str) -> int:
    [found] = [row for row in output.splitlines() if row.strip().startswith(f"{label}:")]
    return int(found.rsplit(":", 1)[1])


async def test_a_dry_run_counts_and_asks_nothing(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    mine = [await make_address(db_session) for _ in range(3)]
    await make_address(db_session, lat=KEPT_LAT, lng=KEPT_LNG)  # has its point: not counted
    pending = await without_point(db_session)

    code, output = await run()  # no --apply

    assert code == 0
    assert geocoder.asked == []
    assert run.pauses == []
    assert pending >= len(mine)
    assert output == (
        f"Dry run: {pending} addresses without a point, of every request, open or not. "
        "Mapbox was not asked. With --apply each of them is one billed call.\n"
    )
    for address in mine:
        assert await point_of(db_session, address.id) == (None, None)


async def test_a_dry_run_needs_neither_the_switch_nor_a_token(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    await make_address(db_session)

    code, output = await run(config=settings(geocode_on_save=False, mapbox_access_token=None))

    assert code == 0
    assert output.startswith("Dry run: ")
    assert geocoder.asked == []


@pytest.mark.parametrize(
    ("overrides", "said"),
    [
        ({"geocode_on_save": False}, "Error: GEOCODE_ON_SAVE is false."),
        ({"mapbox_access_token": None}, "Error: MAPBOX_ACCESS_TOKEN is not set."),
    ],
    ids=["switch_off", "no_token"],
)
async def test_apply_is_refused_without_the_switch_or_the_token(
    db_session: AsyncSession,
    run: Run,
    geocoder: ByStreet,
    overrides: dict[str, object],
    said: str,
) -> None:
    address = await make_address(db_session)

    code, output = await run("--apply", config=settings(**overrides))

    assert code == 1
    assert output.startswith(said)
    assert output.rstrip().endswith("Nothing was asked.")
    assert geocoder.asked == []
    assert await point_of(db_session, address.id) == (None, None)


async def test_apply_fills_every_address_without_a_point_and_a_second_run_asks_nothing_more(
    db_session: AsyncSession, run: Run, geocoder: ByStreet, capsys: pytest.CaptureFixture[str]
) -> None:
    # More rows than one step reads (BATCH), each on its own street.
    placed = [await make_address(db_session, line1=f"{n} Zephyrquill Lane") for n in range(5)]
    nowhere = await make_address(db_session, line1="1 Nowhere Zephyrquill")
    elsewhere = await make_address(db_session, line1="2 Elsewhere Zephyrquill")
    already = await make_address(db_session, lat=KEPT_LAT, lng=KEPT_LNG, line1="3 Zephyrquill")
    geocoder.answers = {nowhere.line1: None, elsewhere.line1: kept(postcode="32899")}
    pending = await without_point(db_session)

    code, output = await run("--apply")

    assert code == 0
    for address in placed:
        assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)
    for address in (nowhere, elsewhere):
        assert await point_of(db_session, address.id) == (None, None)
    # Each row without a point was asked about once; the one that had its point never.
    streets = asked_streets(geocoder)
    assert len(streets) == len(set(streets)) == pending
    assert {a.line1 for a in (*placed, nowhere, elsewhere)} <= set(streets)
    assert already.line1 not in streets
    # Paced: a pause after each call, of 60 s / GEOCODE_BACKFILL_PER_MINUTE.
    assert run.pauses == [60 / PER_MINUTE] * pending
    # Counts only: no address, no coordinate, and in the script's own lines no id either.
    assert line(output, "Addresses looked at") == pending
    assert line(output, "Point kept") == pending - 2
    assert line(output, "Not found by Mapbox") == 1
    assert line(output, "Found in another state or ZIP (nothing kept)") == 1
    assert line(output, "Mapbox unavailable") == 0
    assert "Stopped" not in output
    captured = capsys.readouterr()
    for needle in (*NEEDLES, STREET, CITY, str(FOUND.lat), str(KEPT_LAT)):
        assert needle not in output + captured.out + captured.err, needle
    for address in (*placed, nowhere, elsewhere):
        assert str(address.id) not in output

    # Idempotent: a second run asks only about the two that still have no point.
    geocoder.asked.clear()
    code, output = await run("--apply")

    assert code == 0
    assert sorted(asked_streets(geocoder)) == sorted([nowhere.line1, elsewhere.line1])
    assert line(output, "Addresses looked at") == 2
    assert line(output, "Point kept") == 0
    for address in placed:
        assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)


async def test_apply_stops_when_mapbox_is_unavailable(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    """A refused token, no billing, a rate limit, an outage: the next rows would fail the
    same way, each a call. Three such answers in a row stop the run, and a later run takes
    up the rest."""
    addresses = [await make_address(db_session) for _ in range(6)]
    geocoder.down = True

    code, output = await run("--apply")

    assert backfill.STOP_AFTER_UNAVAILABLE == 3
    assert code == 1
    assert len(geocoder.asked) == 3  # three calls, not one per address
    assert run.pauses == [60 / PER_MINUTE] * 2  # paced between them
    assert line(output, "Addresses looked at") == 3
    assert line(output, "Mapbox unavailable") == 3
    assert output.splitlines()[-1] == (
        "Stopped: Mapbox was unavailable 3 times in a row. Run it again later for the rest."
    )
    for address in addresses:
        assert await point_of(db_session, address.id) == (None, None)

    # The later run takes up the rest.
    geocoder.down = False
    code, _ = await run("--apply")

    assert code == 0
    for address in addresses:
        assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)


async def test_an_address_mapbox_refuses_does_not_end_the_run(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    """The wrapper says "unavailable" for a refusal of one request too (a text Mapbox will
    not take). Were that row the end of every run, no row after it would ever get a point."""
    addresses = [await make_address(db_session, line1=f"{n} Zephyrquill Lane") for n in range(6)]
    in_id_order = sorted(addresses, key=lambda address: address.id)
    # Two refused, one placed, two refused: never three in a row, as the run reads them.
    refused = [in_id_order[n] for n in (0, 1, 3, 4)]
    geocoder.answers = {address.line1: MapboxUnavailableError() for address in refused}

    code, output = await run("--apply")

    assert code == 0
    assert "Stopped" not in output
    assert line(output, "Mapbox unavailable") == 4
    for address in addresses:
        expected = (None, None) if address in refused else (KEPT_LAT, KEPT_LNG)
        assert await point_of(db_session, address.id) == expected


@pytest.mark.parametrize("flag", ["--yes", "-y", "--force", "--no-input", "--assume-yes"])
async def test_no_flag_skips_the_question(
    db_session: AsyncSession, run: Run, geocoder: ByStreet, flag: str
) -> None:
    await make_address(db_session)

    for argv in ((flag,), ("--apply", flag)):
        with pytest.raises(SystemExit) as refused:
            await run(*argv)

        assert refused.value.code == 2
    assert geocoder.asked == []
    assert vars(backfill.parse_args(["--apply"])) == {"apply": True}  # the one flag there is


# --apply needs an operator (Vault round 1)

NOT_CONFIRMED = "Not confirmed. Nothing was asked."
NO_TERMINAL = (
    "Error: --apply needs an operator at a terminal, and standard input is not one. "
    "Nothing was asked."
)


def said_before_asking(pending: int) -> list[str]:
    return [
        f"{pending} addresses without a point, of every request, open or not, would be sent "
        "to Mapbox.",
        f"Permanent geocoding is billed per address: up to {pending} billed calls.",
    ]


@pytest.mark.parametrize(
    "answer",
    ["", "\n", "n\n", "yes\n", "y\n", "geocode\n", "{more}\n", "{pending} addresses\n", "0\n"],
    ids=["end_of_input", "empty_line", "no", "yes", "y", "a_word", "another_number", "more", "0"],
)
async def test_apply_asks_nothing_until_the_operator_types_the_number(
    db_session: AsyncSession, run: Run, geocoder: ByStreet, answer: str
) -> None:
    addresses = [await make_address(db_session) for _ in range(2)]
    pending = await without_point(db_session)

    typed = answer.format(pending=pending, more=pending + 1)

    code, output = await run("--apply", answer=typed)

    assert code == 1
    assert geocoder.asked == []
    assert run.claims.calls == []
    assert run.pauses == []
    assert run.lines_read == 1
    # What it would do and what it costs, the question, and the refusal: nothing else.
    assert output.splitlines() == [
        *said_before_asking(pending),
        f"Type {pending} to go on (anything else stops): {typed.rstrip()}",
        NOT_CONFIRMED,
    ]
    for address in addresses:
        assert await point_of(db_session, address.id) == (None, None)


@pytest.mark.parametrize("piped", [None, ""], ids=["the_number_in_a_pipe", "nothing_in_a_pipe"])
async def test_apply_is_refused_without_a_terminal(
    db_session: AsyncSession, run: Run, geocoder: ByStreet, piped: str | None
) -> None:
    """A pipe, a file, a scheduled job: nobody is there, whatever the input holds. With no
    terminal the script does not even read it."""
    address = await make_address(db_session)
    pending = await without_point(db_session)
    in_the_pipe = f"{pending}\n" if piped is None else piped

    code, output = await run("--apply", answer=in_the_pipe, tty=False)

    assert code == 1
    assert geocoder.asked == []
    assert run.claims.calls == []
    assert run.lines_read == 0
    assert output.splitlines() == [*said_before_asking(pending), NO_TERMINAL]
    assert await point_of(db_session, address.id) == (None, None)


@pytest.mark.parametrize("typed", ["{pending}\n", "  {pending} \n", "{pending}"])
async def test_apply_goes_on_once_the_operator_types_the_number(
    db_session: AsyncSession, run: Run, geocoder: ByStreet, typed: str
) -> None:
    addresses = [await make_address(db_session, line1=f"{n} Zephyrquill Lane") for n in range(2)]
    pending = await without_point(db_session)

    answer = typed.format(pending=pending)

    code, output = await run("--apply", answer=answer)

    assert code == 0
    assert run.lines_read == 1
    assert len(geocoder.asked) == pending
    # Said and asked before the first call; then the report.
    assert output.splitlines()[:4] == [
        *said_before_asking(pending),
        f"Type {pending} to go on (anything else stops): {answer.rstrip(chr(10))}",
        f"Addresses looked at: {pending}",
    ]
    for address in addresses:
        assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)


async def test_apply_with_nothing_to_fill_asks_nobody(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    await make_address(db_session)
    await db_session.execute(  # every row the script sees has its point
        update(Address)
        .where(Address.lat.is_(None) | Address.lng.is_(None))
        .values(lat=KEPT_LAT, lng=KEPT_LNG)
    )

    code, output = await run("--apply", answer="")

    assert (code, output) == (0, "No address without a point. Nothing was asked.\n")
    assert run.lines_read == 0
    assert geocoder.asked == []


async def test_apply_asks_about_no_more_addresses_than_the_operator_confirmed(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    """Requests made while the run goes on bring new rows without a point. The operator
    agreed to a number of billed calls: the run makes that many and says the rest waits."""
    confirmed = [await make_address(db_session, line1=f"{n} Zephyrquill Lane") for n in range(3)]
    pending = await without_point(db_session)
    late = [
        uuid.UUID(f"ffffffff-ffff-4fff-bfff-fffffffffff{n}") for n in range(2)
    ]  # read last: the run reads by id

    async def two_more_requests() -> None:
        run.claims.on_claim = None
        for n, address_id in enumerate(late):
            await make_address(db_session, id=address_id, line1=f"{n} Latequill Lane")

    run.claims.on_claim = two_more_requests

    code, output = await run("--apply")

    assert code == 0
    streets = asked_streets(geocoder)
    assert len(streets) == pending
    assert {a.line1 for a in confirmed} <= set(streets)
    assert not {"0 Latequill Lane", "1 Latequill Lane"} & set(streets)
    assert run.pauses == [60 / PER_MINUTE] * pending
    assert output.splitlines()[-1] == (
        f"Stopped: Mapbox was asked about {pending} addresses, the number confirmed, and more "
        "are without a point by now. Run it again for the rest."
    )
    for address_id in late:
        assert await point_of(db_session, address_id) == (None, None)


# One caller per address (Vault round 1); the overlaps on real sessions and the real Redis
# are in tests/test_address_geocode_claim.py

BUSY_LINE = "Claimed by the worker or another run (skipped)"


async def test_an_address_claimed_elsewhere_is_skipped_not_waited_for(
    db_session: AsyncSession, run: Run, geocoder: ByStreet
) -> None:
    addresses = [await make_address(db_session, line1=f"{n} Zephyrquill Lane") for n in range(3)]
    theirs = addresses[1]
    run.claims.held[theirs.id] = "the worker's token"
    pending = await without_point(db_session)

    code, output = await run("--apply")

    assert code == 0
    assert theirs.line1 not in asked_streets(geocoder)
    assert len(geocoder.asked) == pending - 1
    assert run.pauses == [60 / PER_MINUTE] * (pending - 1)  # no call, no pause
    assert line(output, "Addresses looked at") == pending
    assert line(output, BUSY_LINE) == 1
    assert line(output, "Point kept") == pending - 1
    assert "Stopped" not in output
    assert await point_of(db_session, theirs.id) == (None, None)
    assert run.claims.held == {theirs.id: "the worker's token"}  # the holder's, still


@pytest.mark.parametrize("calls_before", [0, 1], ids=["from_the_start", "during_the_run"])
async def test_redis_unreachable_stops_the_run_before_the_next_call(
    db_session: AsyncSession, run: Run, geocoder: ByStreet, calls_before: int
) -> None:
    """Without its claim no address is asked about: the worker, or another run, may be asking
    about it right now, and nobody could tell."""
    addresses = [await make_address(db_session) for _ in range(3)]

    async def redis_goes_down() -> None:
        run.claims.down = True

    if calls_before:
        run.claims.on_claim = redis_goes_down  # after the first address's claim
    else:
        run.claims.down = True

    code, output = await run("--apply")

    assert code == 1
    assert len(geocoder.asked) == calls_before
    assert line(output, "Addresses looked at") == calls_before
    assert output.splitlines()[-1] == (
        "Stopped: Redis (REDIS_URL) is unreachable, so no address can be claimed. "
        "Mapbox was not asked about this address or the rest."
    )
    kept_points = [await point_of(db_session, a.id) != (None, None) for a in addresses]
    assert sum(kept_points) == calls_before


async def test_main_gives_the_run_the_terminal_and_the_queues_redis(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The script's own wiring: standard input as it is (never a stand-in that answers), and
    the claims in REDIS_URL's Redis, where the worker takes its own; not the positions'."""
    config = settings(location_redis_url="redis://positions.invalid:6379/0")
    given: dict[str, object] = {}

    async def run_stub(*args: object, **kwargs: object) -> int:
        given.update(kwargs, args=args)
        return 7

    monkeypatch.setattr(backfill, "run", run_stub)
    monkeypatch.setattr(backfill, "get_settings", lambda: config)
    monkeypatch.setattr(backfill, "configure_logging", lambda level: None)

    assert await backfill._main(["--apply"]) == 7

    assert given["stdin"] is sys.stdin
    claims = given["claims"]
    assert isinstance(claims, RedisGeocodeClaims)
    assert claims.claim_seconds == claim_seconds(
        mapbox_timeout_seconds=config.mapbox_timeout_seconds,
        redis_timeout_seconds=config.job_enqueue_timeout_seconds,
    )
    expected = Redis.from_url(config.redis_url)
    try:
        assert (
            claims._redis.connection_pool.connection_kwargs
            == expected.connection_pool.connection_kwargs
        )
    finally:
        await expected.aclose()


def test_the_settings_bound_the_batch_and_the_rate() -> None:
    for bad in (
        {"geocode_backfill_batch_size": 0},
        {"geocode_backfill_batch_size": 1001},
        {"geocode_backfill_per_minute": 0},
    ):
        with pytest.raises(ValidationError):
            make_settings(**bad)
