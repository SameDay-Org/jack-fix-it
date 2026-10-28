"""Shared test helpers."""

import gc
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Final

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

_SET_STATUS_WRITER: Final = text("SELECT set_config('app.status_writer', :value, true)")
# The fixtures' wildcard token: the trigger accepts it only in a database whose setting
# app.status_writer_fixtures is 'on', which conftest sets on the test database alone.
FIXTURES_TOKEN: Final = "fixtures"
_IN_FAILED_TRANSACTION: Final = "25P02"


# Timed runs per measurement: a busy test machine can stall one run; backtracking would make
# every run slow (#196).
TIMED_RUNS: Final = 3


@contextmanager
def gc_paused() -> Iterator[None]:
    """The cyclic garbage collector off inside the block, and back to its previous state after,
    even when the block raises. A full collection walks every live object of the test process
    (over a million late in the suite) and took up to 0.86 s on CI: when it fires inside a timed
    call, it measures the suite's heap, not the code under test (#194)."""
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        yield
    finally:
        if was_enabled:
            gc.enable()


def seconds_without_gc(work: Callable[[], object]) -> float:
    """Wall-clock seconds of work() with the collector paused (gc_paused). Backtracking still
    shows: the code itself runs slowly."""
    with gc_paused():
        started = time.perf_counter()
        work()
        return time.perf_counter() - started


async def async_seconds_without_gc(work: Callable[[], Awaitable[object]]) -> float:
    """seconds_without_gc for a coroutine: the collector is paused for the timed await only."""
    with gc_paused():
        started = time.perf_counter()
        await work()
        return time.perf_counter() - started


def best_seconds_without_gc(work: Callable[[], object]) -> float:
    """The fastest of TIMED_RUNS runs of work(), each timed by seconds_without_gc. One stalled
    run cannot fail a limit; a regression that slows every run still does."""
    return min(seconds_without_gc(work) for _ in range(TIMED_RUNS))


async def async_best_seconds_without_gc(work: Callable[[], Awaitable[object]]) -> float:
    """best_seconds_without_gc for a coroutine."""
    return min([await async_seconds_without_gc(work) for _ in range(TIMED_RUNS)])


@asynccontextmanager
async def as_status_writer(session: AsyncSession) -> AsyncIterator[None]:
    """Test fixtures only: lets the block write any request or job status past the database
    guard (#163). Use it to create rows in a given status, or to probe a status CHECK. The state
    machines use a token for one row instead; this wildcard works only in the test database
    (see FIXTURES_TOKEN), and production code never names app.status_writer (a static test)."""
    await session.execute(_SET_STATUS_WRITER, {"value": FIXTURES_TOKEN})
    try:
        yield
    finally:
        try:
            await session.execute(_SET_STATUS_WRITER, {"value": ""})
        except PendingRollbackError:
            pass  # the block's flush failed: the flag goes with the rollback
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) != _IN_FAILED_TRANSACTION:
                raise
