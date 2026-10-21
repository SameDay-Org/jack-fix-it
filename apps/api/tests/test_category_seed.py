"""The idempotent seed of the launch categories (D4.5, #29). Expectations come from the file."""

import copy
import json
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.models import Category
from app.modules.categories.service import (
    SEED_DATA_PATH,
    CategoryService,
    SeedResult,
    load_seed_data,
)
from scripts import seed_categories

FILE_ENTRIES: list[dict[str, Any]] = json.loads(SEED_DATA_PATH.read_text(encoding="utf-8"))
LAUNCH_CATEGORY_COUNT = 5


def sessions_of(
    session: AsyncSession,
) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    """A session factory that hands out the rolled-back test session."""

    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


async def categories_by_slug(session: AsyncSession) -> dict[str, Category]:
    statement = select(Category).execution_options(populate_existing=True)
    return {row.slug: row for row in (await session.scalars(statement)).all()}


async def category_count(session: AsyncSession) -> int:
    return (await session.scalar(select(func.count()).select_from(Category))) or 0


async def test_seed_inserts_all_launch_categories(db_session: AsyncSession) -> None:
    result = await seed_categories.seed(sessions_of(db_session))

    assert result == SeedResult(inserted=LAUNCH_CATEGORY_COUNT, skipped=0)
    rows = await categories_by_slug(db_session)
    assert set(rows) == {entry["slug"] for entry in FILE_ENTRIES}
    assert len(rows) == LAUNCH_CATEGORY_COUNT
    for entry in FILE_ENTRIES:
        row = rows[entry["slug"]]
        assert row.names == entry["names"]
        assert row.intake_questions == []
        assert row.requires_license is False
        assert row.reference_price_cents is None
        assert row.icon is None
        assert row.active is True


async def test_seed_is_idempotent(db_session: AsyncSession) -> None:
    entries = load_seed_data()
    service = CategoryService(db_session)

    first = await service.seed(entries)
    second = await service.seed(entries)

    assert first == SeedResult(inserted=LAUNCH_CATEGORY_COUNT, skipped=0)
    assert second == SeedResult(inserted=0, skipped=LAUNCH_CATEGORY_COUNT)
    assert await category_count(db_session) == LAUNCH_CATEGORY_COUNT


async def test_seed_never_overwrites_admin_edits(db_session: AsyncSession) -> None:
    entries = load_seed_data()
    service = CategoryService(db_session)
    await service.seed(entries)
    edited = (await categories_by_slug(db_session))[entries[0].slug]
    edited.names = {"en": "Edited by an admin", "es": "Editado por un admin"}
    edited.intake_questions = [{"key": "rooms", "type": "number"}]
    edited.active = False
    await db_session.flush()

    result = await service.seed(entries)

    assert result == SeedResult(inserted=0, skipped=LAUNCH_CATEGORY_COUNT)
    row = (await categories_by_slug(db_session))[entries[0].slug]
    assert row.names == {"en": "Edited by an admin", "es": "Editado por un admin"}
    assert row.intake_questions == [{"key": "rooms", "type": "number"}]
    assert row.active is False


async def test_seed_inserts_only_missing(db_session: AsyncSession) -> None:
    entries = load_seed_data()
    service = CategoryService(db_session)
    await service.seed(entries)
    removed = entries[-1].slug
    await db_session.execute(delete(Category).where(Category.slug == removed))

    result = await service.seed(entries)

    assert result == SeedResult(inserted=1, skipped=LAUNCH_CATEGORY_COUNT - 1)
    assert removed in await categories_by_slug(db_session)


def test_seed_data_file_is_valid() -> None:
    entries = load_seed_data()

    assert [entry.slug for entry in entries] == [entry["slug"] for entry in FILE_ENTRIES]
    assert len(entries) == LAUNCH_CATEGORY_COUNT
    assert len({entry.slug for entry in entries}) == len(entries)
    for entry in entries:
        assert entry.names["en"].strip()
        assert entry.names["es"].strip()
        # Criterion 1: no license, no invented price, no icon or questions yet, active.
        assert entry.requires_license is False
        assert entry.reference_price_cents is None
        assert entry.icon is None
        assert entry.intake_questions == []
        assert entry.active is True


def _first_entry_with(**changes: object) -> list[dict[str, Any]]:
    entries = copy.deepcopy(FILE_ENTRIES)
    entries[0].update(changes)
    return entries


@pytest.mark.parametrize(
    "entries",
    [
        _first_entry_with(slug="Not A Slug"),
        _first_entry_with(slug="under_score"),
        _first_entry_with(names={"en": "Only English"}),
        _first_entry_with(names={"en": "Blank Spanish", "es": "  "}),
        _first_entry_with(reference_price_cents=-1),
        _first_entry_with(unexpected="field"),
        [*FILE_ENTRIES, FILE_ENTRIES[0]],
    ],
    ids=[
        "slug_with_spaces",
        "slug_with_underscore",
        "missing_es",
        "blank_es",
        "negative_price",
        "unknown_field",
        "duplicate_slug",
    ],
)
async def test_seed_rejects_invalid_entry(
    db_session: AsyncSession, tmp_path: Path, entries: list[dict[str, Any]]
) -> None:
    path = tmp_path / "seed_data.json"
    path.write_text(json.dumps(entries), encoding="utf-8")

    with pytest.raises(ValidationError):
        await seed_categories.seed(sessions_of(db_session), path)

    assert await category_count(db_session) == 0


def test_seed_command_prints_counts_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def fake_run() -> SeedResult:
        return SeedResult(inserted=4, skipped=1)

    monkeypatch.setattr(seed_categories, "_run", fake_run)

    seed_categories.main()

    output = capsys.readouterr().out
    assert output == "Categories seeded: 4 inserted, 1 already present\n"
    for entry in FILE_ENTRIES:
        assert entry["slug"] not in output
        assert entry["names"]["en"] not in output
