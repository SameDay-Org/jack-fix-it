"""Worker side of quotes (D9.4, #51 part 1): the cron that expires quotes past their expires_at.

A run takes one `now` and reads the requests with a quote due at it in batches of EXPIRY_BATCH,
by id, so each request comes up once per run. Each request is then expired in a transaction of
its own (QuoteExpiryService.expire_request), which holds that request's lock for its own few
statements only: a customer accepting or a pro quoting on another request never waits for the
batch. A request that fails is rolled back and logged by error class, and the run goes on with
the next one; a batch that cannot be read ends the run. Whatever is left, the next run does.
Nothing raises out of the cron. Logs carry ids and counts only.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime
from typing import Any, Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.quotes.service import QuoteExpiryService, RequestExpiry

logger = logging.getLogger(__name__)

# Requests read per query; each is then expired in its own transaction.
EXPIRY_BATCH: Final = 200

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def expire_quotes(ctx: dict[str, Any]) -> None:
    """ARQ cron: expires the quotes due now and backs out the requests left with none (see the
    module doc). Logs one `quotes_expired` summary per run, even when the run is cut short."""
    sessions: SessionFactory = ctx["session_factory"]
    now = datetime.now(UTC)
    expired = backed_out = failed = 0
    after: uuid.UUID | None = None
    try:
        while True:
            try:
                async with sessions() as session:
                    due = await QuoteExpiryService(session).requests_due(now, after, EXPIRY_BATCH)
            # A batch that cannot be read, whatever the reason, ends the run; the next run
            # reads it again. By class only: a database error's text can hold SQL literals.
            except Exception as error:  # noqa: BLE001
                logger.error("quote_expiry_unavailable", extra={"error": type(error).__name__})
                return
            for request_id in due:
                outcome = await _expire_one(sessions, request_id, now)
                if outcome is None:
                    failed += 1
                    continue
                expired += len(outcome.expired)
                backed_out += outcome.backed_out
            if len(due) < EXPIRY_BATCH:
                return
            after = due[-1]
    finally:
        logger.info(
            "quotes_expired",
            extra={"expired": expired, "requests_backed_out": backed_out, "failed": failed},
        )


async def _expire_one(
    sessions: SessionFactory, request_id: uuid.UUID, now: datetime
) -> RequestExpiry | None:
    """One request in its own transaction; None when it failed (rolled back, and logged)."""
    try:
        async with sessions() as session:
            outcome = await QuoteExpiryService(session).expire_request(request_id, now)
            await session.commit()
    # One request's failure, whatever it is, never stops the others; the next run tries it
    # again. By class only: a database error's text can hold SQL literals.
    except Exception as error:  # noqa: BLE001
        logger.error(
            "quote_expiry_failed",
            extra={"service_request_id": str(request_id), "error": type(error).__name__},
        )
        return None
    for quote_id in outcome.expired:
        logger.info(
            "quote_expired",
            extra={"quote_id": str(quote_id), "service_request_id": str(request_id)},
        )
    return outcome
