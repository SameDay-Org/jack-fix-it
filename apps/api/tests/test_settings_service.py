"""SettingsService: typed, validated, read on every call (D9.1, #48; D9.3, #50)."""

import logging

import pytest
from pydantic import JsonValue
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.settings.errors import SettingMalformedError, SettingNotConfiguredError
from app.modules.settings.models import Setting
from app.modules.settings.service import (
    DISPATCH_MAX_PROS,
    DISPATCH_MAX_PROS_DEFAULT,
    INT4_MAX,
    PLATFORM_TAKE_RATE_BPS,
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


# An optional positive int (the quote caps, #50): absent is "not set", malformed is refused.

OPTIONAL_KEY = "probe_optional_limit"


async def put(session: AsyncSession, value: JsonValue) -> None:
    await session.execute(delete(Setting).where(Setting.key == OPTIONAL_KEY))
    session.add(Setting(key=OPTIONAL_KEY, value=value))
    await session.flush()


async def test_an_absent_optional_setting_is_none_and_logs_nothing(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        assert await SettingsService(db_session).optional_positive_int(OPTIONAL_KEY) is None

    assert invalid_logs(caplog) == []


@pytest.mark.parametrize("bound", [1, INT4_MAX])
async def test_an_optional_setting_reads_its_bounds(db_session: AsyncSession, bound: int) -> None:
    await put(db_session, bound)

    assert await SettingsService(db_session).optional_positive_int(OPTIONAL_KEY) == bound


@pytest.mark.parametrize(
    "value",
    ["98765", 0, True, False, -98765, INT4_MAX + 1, 98765.0, 98765.5, None, [98765], {"n": 98765}],
    ids=[
        "string",
        "zero",
        "true",
        "false",
        "negative",
        "above_int4",
        "whole_float",
        "float",
        "null",
        "list",
        "object",
    ],
)
async def test_a_malformed_optional_setting_raises_and_logs_the_key_only(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture, value: JsonValue
) -> None:
    await put(db_session, value)

    with caplog.at_level(logging.WARNING), pytest.raises(SettingMalformedError) as error:
        await SettingsService(db_session).optional_positive_int(OPTIONAL_KEY)

    assert error.value.key == OPTIONAL_KEY
    # A 503 not_configured wherever it is not caught, so no caller can treat it as unset.
    assert isinstance(error.value, SettingNotConfiguredError)
    assert (error.value.status_code, error.value.code) == (503, "not_configured")
    [record] = invalid_logs(caplog)
    assert record.__dict__["key"] == OPTIONAL_KEY
    output = JsonFormatter().format(record)
    assert "value" not in output
    assert "98765" not in output
    assert str(INT4_MAX + 1) not in output


# The platform's take rate (#246): absent is the default 1500, malformed is refused.


async def put_take_rate(session: AsyncSession, value: JsonValue) -> None:
    await session.execute(delete(Setting).where(Setting.key == PLATFORM_TAKE_RATE_BPS))
    session.add(Setting(key=PLATFORM_TAKE_RATE_BPS, value=value))
    await session.flush()


async def test_a_missing_take_rate_is_1500_and_logs_nothing(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    await db_session.execute(delete(Setting).where(Setting.key == PLATFORM_TAKE_RATE_BPS))

    with caplog.at_level(logging.WARNING):
        assert await SettingsService(db_session).platform_take_rate_bps() == 1500

    assert invalid_logs(caplog) == []


@pytest.mark.parametrize("bound", [0, 1234, 10_000])
async def test_a_stored_take_rate_is_read(db_session: AsyncSession, bound: int) -> None:
    await put_take_rate(db_session, bound)

    assert await SettingsService(db_session).platform_take_rate_bps() == bound


@pytest.mark.parametrize(
    "value",
    ["1500", -1, 10_001, True, False, 1500.0, 1500.5, None, [1500], {"bps": 1500}],
    ids=[
        "string",
        "negative",
        "above_whole",
        "true",
        "false",
        "whole_float",
        "float",
        "null",
        "list",
        "object",
    ],
)
async def test_a_malformed_take_rate_raises_and_logs_the_key_only(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture, value: JsonValue
) -> None:
    await put_take_rate(db_session, value)

    with caplog.at_level(logging.WARNING), pytest.raises(SettingMalformedError) as error:
        await SettingsService(db_session).platform_take_rate_bps()

    assert error.value.key == PLATFORM_TAKE_RATE_BPS
    # Never a silent 0 or the default: a 503 not_configured wherever it is not caught.
    assert (error.value.status_code, error.value.code) == (503, "not_configured")
    [record] = invalid_logs(caplog)
    assert record.__dict__["key"] == PLATFORM_TAKE_RATE_BPS
    output = JsonFormatter().format(record)
    assert "value" not in output
    assert "10001" not in output
