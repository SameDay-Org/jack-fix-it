"""The timing helpers of tests/helpers.py (#196): the garbage collector is paused for the timed
work only, and a best of three ignores one stalled run but not a slow one. And the leak check
for numbers (#300), and the field-by-field leak checks (#387), which random ids and clocks
must not trip."""

import asyncio
import gc
import logging
from collections.abc import Callable, Iterator
from typing import Final

import pytest

from tests.helpers import (
    TIMED_RUNS,
    async_best_seconds_without_gc,
    async_seconds_without_gc,
    best_seconds_without_gc,
    fields_holding,
    json_fields,
    log_fields,
    masked_fields,
    mentions_number,
    seconds_without_gc,
)

# The limit the best of three guards, a sample under it and a stalled one over it. Dyadic
# fractions: the fake clock adds and subtracts them exactly, so durations compare with ==.
LIMIT: Final = 0.25
FAST: Final = 0.125
STALL: Final = 0.5


class WorkError(Exception):
    pass


class FakeClock:
    """The clock the best-of-three tests pass to the helpers: it moves only when the work
    advances it, so each sample's duration is scripted and nothing sleeps (#196). It records
    whether the collector was on at each reading."""

    def __init__(self) -> None:
        self.now = 0.0
        self.reads: list[bool] = []

    def __call__(self) -> float:
        self.reads.append(gc.isenabled())
        return self.now


@pytest.fixture(autouse=True)
def restore_gc() -> Iterator[None]:
    """A failing helper must not leave the collector off for the rest of the suite."""
    was_enabled = gc.isenabled()
    yield
    if was_enabled:
        gc.enable()
    else:
        gc.disable()


async def measure(helper: str, work: Callable[[], None]) -> float:
    """work() timed by one helper; the async helpers time it inside a coroutine that awaits."""

    async def awaited() -> None:
        work()
        await asyncio.sleep(0)

    if helper == "seconds_without_gc":
        return seconds_without_gc(work)
    if helper == "best_seconds_without_gc":
        return best_seconds_without_gc(work)
    if helper == "async_seconds_without_gc":
        return await async_seconds_without_gc(awaited)
    return await async_best_seconds_without_gc(awaited)


@pytest.mark.parametrize(
    "helper",
    [
        "seconds_without_gc",
        "async_seconds_without_gc",
        "best_seconds_without_gc",
        "async_best_seconds_without_gc",
    ],
)
@pytest.mark.parametrize("enabled_before", [True, False], ids=["enabled", "disabled"])
@pytest.mark.parametrize("raises", [False, True], ids=["returns", "raises"])
async def test_seconds_without_gc_pauses_and_restores_gc(
    helper: str, enabled_before: bool, raises: bool
) -> None:
    if enabled_before:
        gc.enable()
    else:
        gc.disable()
    seen: list[bool] = []

    def work() -> None:
        seen.append(gc.isenabled())
        if raises:
            raise WorkError

    if raises:
        with pytest.raises(WorkError):
            await measure(helper, work)
    else:
        assert await measure(helper, work) >= 0

    runs = TIMED_RUNS if helper.startswith(("best", "async_best")) and not raises else 1
    assert seen == [False] * runs
    assert gc.isenabled() is enabled_before


async def test_async_seconds_without_gc_pauses_across_the_await() -> None:
    gc.enable()
    seen: list[bool] = []

    async def work() -> None:
        seen.append(gc.isenabled())
        await asyncio.sleep(0)
        seen.append(gc.isenabled())

    await async_seconds_without_gc(work)

    assert seen == [False, False]
    assert gc.isenabled()


@pytest.mark.parametrize("stalled", range(TIMED_RUNS))
def test_best_of_three_ignores_one_stalled_run(stalled: int) -> None:
    gc.enable()
    clock = FakeClock()
    runs: list[None] = []

    def work() -> None:
        clock.now += STALL if len(runs) == stalled else FAST
        runs.append(None)

    best = best_seconds_without_gc(work, clock=clock)

    assert best == FAST < LIMIT
    assert len(runs) == TIMED_RUNS
    assert clock.reads == [False] * (2 * TIMED_RUNS)


@pytest.mark.parametrize("stalled", range(TIMED_RUNS))
async def test_async_best_of_three_ignores_one_stalled_run(stalled: int) -> None:
    gc.enable()
    clock = FakeClock()
    runs: list[None] = []

    async def work() -> None:
        clock.now += STALL if len(runs) == stalled else FAST
        await asyncio.sleep(0)
        runs.append(None)

    best = await async_best_seconds_without_gc(work, clock=clock)

    assert best == FAST < LIMIT
    assert len(runs) == TIMED_RUNS
    assert clock.reads == [False] * (2 * TIMED_RUNS)


def test_best_of_three_fails_when_every_run_is_slow() -> None:
    gc.enable()
    clock = FakeClock()
    runs: list[None] = []

    def work() -> None:
        clock.now += STALL
        runs.append(None)

    best = best_seconds_without_gc(work, clock=clock)

    assert best == STALL > LIMIT
    assert len(runs) == TIMED_RUNS
    assert clock.reads == [False] * (2 * TIMED_RUNS)


async def test_async_best_of_three_fails_when_every_run_is_slow() -> None:
    gc.enable()
    clock = FakeClock()
    runs: list[None] = []

    async def work() -> None:
        clock.now += STALL
        await asyncio.sleep(0)
        runs.append(None)

    best = await async_best_seconds_without_gc(work, clock=clock)

    assert best == STALL > LIMIT
    assert len(runs) == TIMED_RUNS
    assert clock.reads == [False] * (2 * TIMED_RUNS)


@pytest.mark.parametrize(
    "text",
    [
        '{"value": 98765}',
        '{"value": "98765"}',
        "[98765]",
        "value -98765 refused",
        "98765.5",
        "the cap is 98765.",
    ],
)
def test_a_logged_number_is_found(text: str) -> None:
    assert mentions_number(text, 98765)


@pytest.mark.parametrize(
    "text",
    [
        "5f398765-1a2b-4c3d-8e9f-0a1b2c3d4e5f",  # inside a uuid's group
        "a1b2c3d4-9876-4c3d-8e9f-98765b2c3d4e",  # a uuid group starting with it
        "pi_fake0abc_secret_98765abc",  # a hex secret
        "2026-11-06T12:34:56.987650+00:00",  # a timestamp's fraction
        "1987650",  # a longer number
        "0.98765",  # another number's fraction
    ],
)
def test_digits_inside_ids_and_clocks_are_not_a_number(text: str) -> None:
    assert not mentions_number(text, 98765)


def test_json_fields_are_every_key_and_scalar_at_any_depth() -> None:
    value = {"a": 1, "b": [None, {"c": "x", "d": [True, 2.5]}], "e": ("y",)}

    assert json_fields(value) == ["a", "1", "b", "None", "c", "x", "d", "True", "2.5", "e", "y"]


def test_masked_fields_mask_the_ids_and_instants_inside_each_field() -> None:
    value = {
        "timestamp": "2026-11-13T08:10:26.123456+00:00",
        "at": "2026-11-13 08:10:26",
        "id": "5f398765-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
        "link": "jackfixit://jobs/5F398765-1A2B-4C3D-8E9F-0A1B2C3D4E5F/chat",
        "lat": 26.123457,
        "text": "seen at 26.123457 on 2026-11-13T08:10:26Z",
        "date": "2026-11-13",
    }

    assert masked_fields(value) == [
        *("timestamp", "<instant>", "at", "<instant>", "id", "<uuid>"),
        *("link", "jackfixit://jobs/<uuid>/chat", "lat", "26.123457"),
        *("text", "seen at 26.123457 on <instant>", "date", "2026-11-13"),
    ]


# A coordinate as a key, where a reviewer's probe hid it from the scans (#389).
NEEDLE: Final = "26.123457"


@pytest.mark.parametrize(
    "extra",
    [{NEEDLE: "present"}, {"review_regression": {NEEDLE: "present"}}],
    ids=["depth_1", "depth_2"],
)
def test_a_needle_as_a_key_of_a_log_record_is_found(extra: dict[str, object]) -> None:
    record = logging.LogRecord("app.probe", logging.INFO, __file__, 1, "probe_event", None, None)
    record.__dict__.update(extra)

    assert [field for field in log_fields([record]) if NEEDLE in field] == [NEEDLE]


@pytest.mark.parametrize(
    "found",
    [
        {NEEDLE: "present"},
        {"extra": {NEEDLE: "present"}},
        {"breadcrumbs": {"values": [{"data": {NEEDLE: "present"}}]}},
    ],
    ids=["depth_1", "depth_2", "in_a_list_item"],
)
def test_a_needle_as_a_key_of_a_sentry_event_is_found(found: dict[str, object]) -> None:
    event = {"timestamp": "2026-11-13T08:10:26.123457Z", **found}

    assert fields_holding(NEEDLE, [event]) == [NEEDLE]
