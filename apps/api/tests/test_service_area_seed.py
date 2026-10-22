"""The idempotent seed of the served areas (D6.1, #36). The launch file is empty until #9."""

import json
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.service_areas.models import ServiceArea
from app.modules.service_areas.service import SEED_DATA_PATH, SeedResult, load_seed_data
from scripts import seed_service_areas

# Fixture areas only: no real region, city or ZIP.
ENTRIES: list[dict[str, str]] = [
    {"region": "Test Region", "city": "Testville", "state": "ZZ", "zip_code": "00001"},
    {"region": "Test Region", "city": "Testville", "state": "ZZ", "zip_code": "00002"},
    {"region": "Other Region", "city": "Elsewhere", "state": "YY", "zip_code": "00003"},
]


def sessions_of(
    session: AsyncSession,
) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    """A session factory that hands out the rolled-back test session."""

    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


def seed_file(tmp_path: Path, entries: list[dict[str, Any]], name: str = "seed_data") -> Path:
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps({"note": "test", "service_areas": entries}), encoding="utf-8")
    return path


async def area_count(session: AsyncSession) -> int:
    return (await session.scalar(select(func.count()).select_from(ServiceArea))) or 0


def test_launch_file_is_empty_until_the_zip_list_arrives() -> None:
    raw = json.loads(SEED_DATA_PATH.read_text(encoding="utf-8"))

    assert load_seed_data() == []
    assert "#9" in raw["note"]


async def test_empty_file_is_a_no_op(db_session: AsyncSession, tmp_path: Path) -> None:
    result = await seed_service_areas.seed(sessions_of(db_session), seed_file(tmp_path, []))

    assert result == SeedResult(inserted=0, skipped=0)
    assert await area_count(db_session) == 0


async def test_seed_inserts_missing_only(db_session: AsyncSession, tmp_path: Path) -> None:
    path = seed_file(tmp_path, ENTRIES)
    first = await seed_service_areas.seed(
        sessions_of(db_session), seed_file(tmp_path, ENTRIES[:1], "first")
    )

    second = await seed_service_areas.seed(sessions_of(db_session), path)
    third = await seed_service_areas.seed(sessions_of(db_session), path)

    assert first == SeedResult(inserted=1, skipped=0)
    assert second == SeedResult(inserted=2, skipped=1)
    assert third == SeedResult(inserted=0, skipped=3)
    rows = (await db_session.scalars(select(ServiceArea).order_by(ServiceArea.zip_code))).all()
    assert [
        {"region": r.region, "city": r.city, "state": r.state, "zip_code": r.zip_code} for r in rows
    ] == ENTRIES
    assert all(row.active for row in rows)


async def test_seed_never_overwrites(db_session: AsyncSession, tmp_path: Path) -> None:
    path = seed_file(tmp_path, ENTRIES)
    await seed_service_areas.seed(sessions_of(db_session), path)
    # An admin renames the city and turns the ZIP off.
    await db_session.execute(
        update(ServiceArea)
        .where(ServiceArea.zip_code == "00001")
        .values(city="Renamed", active=False)
    )

    result = await seed_service_areas.seed(sessions_of(db_session), path)

    row = await db_session.scalar(
        select(ServiceArea)
        .where(ServiceArea.zip_code == "00001")
        .execution_options(populate_existing=True)
    )
    assert result == SeedResult(inserted=0, skipped=3)
    assert row is not None
    assert (row.city, row.active) == ("Renamed", False)


@pytest.mark.parametrize(
    "bad",
    [
        {"zip_code": "0001"},
        {"zip_code": "00001-1234"},
        {"zip_code": "".join(chr(0xFF10 + int(d)) for d in "00004")},
        {"state": "zz"},
        {"state": "ZZZ"},
        {"region": "  "},
        {"city": ""},
        {"country": "US"},
    ],
    ids=[
        "short_zip",
        "zip_plus_4",
        "fullwidth_zip",
        "lowercase_state",
        "long_state",
        "blank_region",
        "empty_city",
        "unknown_field",
    ],
)
async def test_invalid_entry_rejected_before_any_write(
    db_session: AsyncSession, tmp_path: Path, bad: dict[str, str]
) -> None:
    entries = [ENTRIES[0], {**ENTRIES[1], **bad}]

    with pytest.raises(ValidationError):
        await seed_service_areas.seed(sessions_of(db_session), seed_file(tmp_path, entries))

    assert await area_count(db_session) == 0


async def test_duplicate_zip_in_file_rejected(db_session: AsyncSession, tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="duplicate ZIP"):
        await seed_service_areas.seed(
            sessions_of(db_session), seed_file(tmp_path, [ENTRIES[0], ENTRIES[0]])
        )

    assert await area_count(db_session) == 0
