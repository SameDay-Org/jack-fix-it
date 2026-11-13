"""Shared test helpers."""

import gc
import re
import time
import uuid
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
# Hex digits as letters: a fixture slug stays unique with no digit in it that a leak check
# could read as part of the number it looks for (#283).
_DIGITS_AS_LETTERS: Final = str.maketrans("0123456789", "ghijklmnop")
# An ISO-8601 instant as the API, the logs and Sentry write it.
_CLOCK: Final = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?"
)


def json_leaves(value: object) -> list[object]:
    """Every scalar inside a parsed JSON value: dict values and list or tuple items, at any
    depth. A leak check compares these, never searches the serialized text, where a random
    uuid or a clock's digits spell a short needle by chance (#387)."""
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in json_leaves(item)]
    if isinstance(value, list | tuple):
        return [leaf for item in value for leaf in json_leaves(item)]
    return [value]


def unclocked_fields(value: object) -> list[str]:
    """The leaves of a parsed JSON value as text, less the ISO instants: where a leak check may
    search for a needle no uuid can spell (one with a "." in it), since a clock's digits read
    12:00:26.1234 by chance (#387)."""
    return [
        str(leaf)
        for leaf in json_leaves(value)
        if not (isinstance(leaf, str) and _CLOCK.fullmatch(leaf))
    ]


def mentions_number(text: str, number: int) -> bool:
    """Whether `text` (a log line, a response body) carries `number` as a number of its own: signed
    or with a fraction (98765, -98765, 98765.5), never a digit run inside a uuid, a hex id, a
    longer number or a timestamp's fraction, which random ids and clocks produce by chance."""
    pattern = rf"(?<![\w.-])-?{number}(?:\.\d+)?(?![\w-])(?!\.\d)"
    return re.search(pattern, text) is not None


# Timed runs per measurement: a busy test machine can stall one run; backtracking would make
# every run slow (#196).
TIMED_RUNS: Final = 3


def letter_tag(length: int = 8) -> str:
    """A random tag of lowercase letters, for unique fixture slugs (#283)."""
    return uuid.uuid4().hex[:length].translate(_DIGITS_AS_LETTERS)


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


def seconds_without_gc(
    work: Callable[[], object], *, clock: Callable[[], float] = time.perf_counter
) -> float:
    """Seconds of work() on clock (the wall clock by default) with the collector paused
    (gc_paused). Backtracking still shows: the code itself runs slowly. clock is a seam for
    test_helpers.py, which scripts the readings instead of sleeping, and lets the floor budget
    of test_redaction.py read this thread's CPU time (#300)."""
    with gc_paused():
        started = clock()
        work()
        return clock() - started


async def async_seconds_without_gc(
    work: Callable[[], Awaitable[object]], *, clock: Callable[[], float] = time.perf_counter
) -> float:
    """seconds_without_gc for a coroutine: the collector is paused for the timed await only."""
    with gc_paused():
        started = clock()
        await work()
        return clock() - started


def best_seconds_without_gc(
    work: Callable[[], object], *, clock: Callable[[], float] = time.perf_counter
) -> float:
    """The fastest of TIMED_RUNS runs of work(), each timed by seconds_without_gc. One stalled
    run cannot fail a limit; a regression that slows every run still does."""
    return min(seconds_without_gc(work, clock=clock) for _ in range(TIMED_RUNS))


async def async_best_seconds_without_gc(
    work: Callable[[], Awaitable[object]], *, clock: Callable[[], float] = time.perf_counter
) -> float:
    """best_seconds_without_gc for a coroutine."""
    return min([await async_seconds_without_gc(work, clock=clock) for _ in range(TIMED_RUNS)])


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
