"""The timing helpers of tests/helpers.py (#196): the garbage collector is paused for the timed
work only, and a best of three ignores one stalled run but not a slow one."""

import asyncio
import gc
from collections.abc import Callable, Iterator
from typing import Final

import pytest

from tests.helpers import (
    TIMED_RUNS,
    async_best_seconds_without_gc,
    async_seconds_without_gc,
    best_seconds_without_gc,
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
