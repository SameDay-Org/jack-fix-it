"""scripts/backfill_address_geocodes.py (#384): a dry run by default, counts only, idempotent,
paced. Never calls Mapbox."""

import io

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.mapbox import KeptGeocode, MapboxUnavailableError, StreetAddress
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
        self.answers: dict[str, KeptGeocode | None] = {}
        self.down = False

    async def geocode_to_keep(self, address: StreetAddress) -> KeptGeocode | None:
        in_place = kept(region=address.state, postcode=address.zip_code[:5])
        self.answer = (
            MapboxUnavailableError() if self.down else self.answers.get(address.line1, in_place)
        )
        return await super().geocode_to_keep(address)


class Run:
    def __init__(self, session: AsyncSession, geocoder: FakeGeocoder) -> None:
        self.session = session
        self.geocoder = geocoder
        self.pauses: list[float] = []

    async def _sleep(self, seconds: float) -> None:
        self.pauses.append(seconds)

    async def __call__(self, *argv: str, config: Settings | None = None) -> tuple[int, str]:
        out = io.StringIO()
        code = await backfill.run(
            argv,
            sessions_of(self.session),
            config or settings(),
            self.geocoder,
            out,
            sleep=self._sleep,
        )
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
        f"Dry run: {pending} addresses without a point. Mapbox was not asked. With --apply "
        "each of them is one billed call.\n"
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
    same way, each a call. The run stops, and a later run takes up the rest."""
    addresses = [await make_address(db_session) for _ in range(4)]
    geocoder.down = True

    code, output = await run("--apply")

    assert code == 1
    assert len(geocoder.asked) == 1  # one call, not one per address
    assert run.pauses == []
    assert line(output, "Addresses looked at") == 1
    assert line(output, "Mapbox unavailable") == 1
    assert output.splitlines()[-1] == (
        "Stopped: Mapbox is unavailable. Run it again later for the rest."
    )
    for address in addresses:
        assert await point_of(db_session, address.id) == (None, None)

    # The later run takes up the rest.
    geocoder.down = False
    code, _ = await run("--apply")

    assert code == 0
    for address in addresses:
        assert await point_of(db_session, address.id) == (KEPT_LAT, KEPT_LNG)


async def test_an_unknown_flag_is_refused(run: Run, geocoder: ByStreet) -> None:
    with pytest.raises(SystemExit) as refused:
        await run("--yes")

    assert refused.value.code == 2
    assert geocoder.asked == []


def test_the_settings_bound_the_batch_and_the_rate() -> None:
    for bad in (
        {"geocode_backfill_batch_size": 0},
        {"geocode_backfill_batch_size": 1001},
        {"geocode_backfill_per_minute": 0},
    ):
        with pytest.raises(ValidationError):
            make_settings(**bad)
