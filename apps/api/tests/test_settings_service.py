"""SettingsService: typed, validated, read on every call (D9.1, #48)."""

import logging

import pytest
from pydantic import JsonValue
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings.models import Setting
from app.modules.settings.service import (
    DISPATCH_MAX_PROS,
    DISPATCH_MAX_PROS_DEFAULT,
    SettingsService,
)
from app.observability import JsonFormatter


async def store(session: AsyncSession, value: JsonValue) -> None:
    await session.execute(
        update(Setting).where(Setting.key == DISPATCH_MAX_PROS).values(value=value)
    )


def invalid_logs(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.message == "setting_invalid"]


async def test_the_seeded_value_is_read(db_session: AsyncSession) -> None:
    assert await SettingsService(db_session).dispatch_max_pros() == 5


async def test_a_change_applies_to_the_next_read(db_session: AsyncSession) -> None:
    settings = SettingsService(db_session)
    assert await settings.dispatch_max_pros() == 5

    await store(db_session, 12)

    assert await settings.dispatch_max_pros() == 12


@pytest.mark.parametrize("bound", [1, 50])
async def test_the_bounds_are_valid(db_session: AsyncSession, bound: int) -> None:
    await store(db_session, bound)

    assert await SettingsService(db_session).dispatch_max_pros() == bound


async def test_a_missing_row_falls_back_to_the_default(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    await db_session.execute(delete(Setting).where(Setting.key == DISPATCH_MAX_PROS))

    with caplog.at_level(logging.WARNING):
        assert await SettingsService(db_session).dispatch_max_pros() == DISPATCH_MAX_PROS_DEFAULT

    [record] = invalid_logs(caplog)
    assert record.__dict__["key"] == DISPATCH_MAX_PROS


@pytest.mark.parametrize(
    "value",
    [0, 51, -3, 2.5, True, "7", None, [5], {"n": 5}],
    ids=["zero", "above_max", "negative", "float", "bool", "string", "null", "list", "object"],
)
async def test_an_invalid_value_falls_back_to_the_default_and_logs_the_key_only(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture, value: JsonValue
) -> None:
    await store(db_session, value)

    with caplog.at_level(logging.WARNING):
        assert await SettingsService(db_session).dispatch_max_pros() == DISPATCH_MAX_PROS_DEFAULT

    [record] = invalid_logs(caplog)
    assert record.__dict__["key"] == DISPATCH_MAX_PROS
    assert "value" not in JsonFormatter().format(record)
