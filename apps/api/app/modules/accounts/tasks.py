"""Worker side of an account deletion (#97): the task queued after the deletion commits, and
the cron that finishes whatever is left (accounts.cleanup).

clean_up_deleted_account runs once per deletion. retry_account_cleanups is the net under it:
every ACCOUNT_DELETION_SWEEP_MINUTES it reads up to ACCOUNT_DELETION_BATCH_SIZE deletions whose
cards or files are not done and that no attempt took for ACCOUNT_DELETION_RETRY_AFTER_MINUTES
(a task never queued, a worker that died, Stripe or the storage unavailable, a copy that may
still upload), least recently tried first, and runs each in a session of its own. One
account's failure, whatever it is, is logged by error class and never stops the next; a batch
that cannot be read ends the run. Nothing raises out of either.
"""

import logging
import uuid
from datetime import timedelta
from typing import Any, Final

from redis.exceptions import RedisError

from app.config import Settings
from app.integrations.stripe_payment_methods import (
    StripePaymentMethods,
    worker_stripe_payment_methods,
)
from app.modules.accounts.cleanup import AccountCleanup
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

# The worker function's name (clean_up_deleted_account below, registered in app/worker.py).
ACCOUNT_CLEANUP_TASK: Final = "clean_up_deleted_account"
# What a run reports for an attempt that raised.
ERRORED: Final = "errored"


async def enqueue_account_cleanup(
    queue: JobQueue, user_id: uuid.UUID, timeout_seconds: float
) -> None:
    """Queues the cleanup of the deleted account, after the commit that deleted it. Never
    raises for a queue failure: the deletion stands, and the sweep cleans up on a later run.
    Logged with the user id only."""
    try:
        await enqueue(
            queue,
            ACCOUNT_CLEANUP_TASK,
            str(user_id),
            job_id=f"account-cleanup:{user_id}",
            timeout_seconds=timeout_seconds,
        )
    except (RedisError, OSError):  # TimeoutError is an OSError
        logger.error("account_cleanup_enqueue_failed", extra={"user_id": str(user_id)})


async def clean_up_deleted_account(ctx: dict[str, Any], user_id: str) -> None:
    """ARQ task: one attempt at a deleted account's cleanup (see the module doc)."""
    outcome = await _run_one(ctx, uuid.UUID(user_id))
    logger.info("account_cleanup_task_ran", extra={"user_id": user_id, "outcome": outcome})


async def retry_account_cleanups(ctx: dict[str, Any]) -> None:
    """ARQ cron: the deleted accounts whose cleanup is not done (module doc)."""
    settings: Settings = ctx["settings"]
    counts: dict[str, int] = {}
    try:
        try:
            due = await _cleanup(ctx).due(settings.account_deletion_batch_size)
        # A batch that cannot be read ends the run; the next run reads it again. By class
        # only: a database error's text can hold SQL literals.
        except Exception as error:  # noqa: BLE001
            logger.error("account_cleanups_unavailable", extra={"error": type(error).__name__})
            return
        for user_id in due:
            outcome = await _run_one(ctx, user_id)
            counts[outcome] = counts.get(outcome, 0) + 1
    finally:
        logger.info("account_cleanups_retried", extra={"outcomes": counts})


async def _run_one(ctx: dict[str, Any], user_id: uuid.UUID) -> str:
    """One account. Never raises: the attempt's outcome, or ERRORED."""
    try:
        return (await _cleanup(ctx).run(user_id)).value
    # One account's failure never stops the others; the sweep tries it again. By class only.
    except Exception as error:  # noqa: BLE001
        logger.error(
            "account_cleanup_errored",
            extra={"user_id": str(user_id), "error": type(error).__name__},
        )
        return ERRORED


def _cleanup(ctx: dict[str, Any]) -> AccountCleanup:
    settings: Settings = ctx["settings"]
    # Tests pass a fake under "stripe_payment_methods"; the worker builds its own client.
    methods: StripePaymentMethods | None = (
        ctx["stripe_payment_methods"]
        if "stripe_payment_methods" in ctx
        else worker_stripe_payment_methods()
    )
    return AccountCleanup(
        ctx["session_factory"],
        ctx["storage"],
        methods,
        timedelta(minutes=settings.account_deletion_retry_after_minutes),
    )
