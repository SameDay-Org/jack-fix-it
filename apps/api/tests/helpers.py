"""Shared test helpers."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Final

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

_SET_STATUS_WRITER: Final = text("SELECT set_config('app.status_writer', :value, true)")
_IN_FAILED_TRANSACTION: Final = "25P02"


@asynccontextmanager
async def as_status_writer(session: AsyncSession) -> AsyncIterator[None]:
    """Test fixtures only: lets the block write a request or job status past the database
    guard (#163), the way the state machines do around their own write. Use it to create rows
    in a given status, or to probe a status CHECK. Production code never calls it: the static
    guard flags app.status_writer anywhere but the two state machines."""
    await session.execute(_SET_STATUS_WRITER, {"value": "state_machine"})
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
