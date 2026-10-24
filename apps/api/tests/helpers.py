"""Shared test helpers."""

import gc
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Final

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

_SET_STATUS_WRITER: Final = text("SELECT set_config('app.status_writer', :value, true)")
# The fixtures' wildcard token: the trigger accepts it only in a database whose setting
# app.status_writer_fixtures is 'on', which conftest sets on the test database alone.
FIXTURES_TOKEN: Final = "fixtures"
_IN_FAILED_TRANSACTION: Final = "25P02"


def seconds_without_gc(work: Callable[[], object]) -> float:
    """Wall-clock seconds of work() with the cyclic garbage collector paused. A full collection
    walks every live object of the test process (over a million late in the suite) and took up
    to 0.86 s on CI: when it fires inside a timed call, it measures the suite's heap, not the
    code under test (#194). Backtracking still shows: the code itself runs slowly."""
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        started = time.perf_counter()
        work()
        return time.perf_counter() - started
    finally:
        if was_enabled:
            gc.enable()


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
