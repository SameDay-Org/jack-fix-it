"""ARQ worker. Start it with:

arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
"""

import logging
from typing import Any

from arq import cron, func
from arq.connections import RedisSettings
from arq.typing import WorkerCoroutine
from arq.worker import Function

from app.config import get_settings
from app.db import create_engine, create_session_factory
from app.integrations.expo_push import ExpoPushSender
from app.integrations.storage import S3Storage, StorageNotConfiguredError
from app.modules.dispatch.tasks import dispatch_request
from app.modules.notifications.push_tasks import check_push_receipts, send_push
from app.modules.quotes.tasks import expire_quotes
from app.modules.requests.tasks import sanitize_task
from app.modules.uploads.tasks import sweep_orphan_uploads
from app.modules.webhooks.tasks import process_stripe_event
from app.observability import configure_logging, init_sentry

logger = logging.getLogger(__name__)


async def ping(ctx: dict[str, Any]) -> str:
    """Smoke-test task. ARQ refuses to start with zero functions."""
    return "pong"


async def startup(ctx: dict[str, Any]) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    init_sentry(settings)
    # What the tasks use (dispatch.tasks, push_tasks.PushDeps.from_context); ARQ adds
    # ctx["redis"] itself.
    engine = create_engine(settings)
    ctx["settings"] = settings
    ctx["engine"] = engine
    ctx["session_factory"] = create_session_factory(engine)
    ctx["push_sender"] = ExpoPushSender.from_settings(settings)
    try:
        ctx["storage"] = S3Storage.from_settings(settings)
    except StorageNotConfiguredError:
        # Development without storage: media copies wait (sanitize_request_media logs it), and
        # the orphan upload sweep has nothing to sweep.
        ctx["storage"] = None
    # Sentinel looks for this line to confirm a worker deploy is healthy.
    logger.info("worker_started", extra={"app_env": settings.app_env})


async def shutdown(ctx: dict[str, Any]) -> None:
    if "engine" in ctx:
        await ctx["engine"].dispose()
    logger.info("worker_stopped")


def discarding_result(
    coroutine: WorkerCoroutine,
    *,
    max_tries: int | None = None,
    timeout: float | None = None,
) -> Function:
    """A worker function that keeps no result in Redis (#176). A failed job's result is its
    pickled exception, and a database error's text holds its SQL statement with literals.
    Register every function through it (tests/test_worker.py checks)."""
    return func(
        coroutine, keep_result=0, keep_result_forever=False, max_tries=max_tries, timeout=timeout
    )


def every(minutes: int) -> set[int]:
    """The minutes of the hour a cron every `minutes` runs at (60 means once an hour)."""
    return set(range(0, 60, minutes))


class WorkerSettings:
    functions = (
        discarding_result(ping),
        discarding_result(dispatch_request),
        # With no result kept, a receipt that asks for a resend can queue the message's job id
        # again once the first run is over; the tries match the sends per device.
        discarding_result(send_push, max_tries=get_settings().push_max_attempts),
        sanitize_task(get_settings()),
        # A run per handler attempt: a failing event is failed on its last one.
        discarding_result(
            process_stripe_event, max_tries=get_settings().stripe_webhook_max_attempts
        ),
    )
    # A cron job keeps no result by default (ARQ's cron keep_result is 0); stated anyway.
    cron_jobs = (
        cron(
            check_push_receipts,
            minute=every(get_settings().push_receipt_check_minutes),
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            sweep_orphan_uploads,
            minute=every(get_settings().orphan_upload_sweep_minutes),
            timeout=get_settings().orphan_upload_sweep_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
        cron(
            expire_quotes,
            minute=every(get_settings().quote_expiry_sweep_minutes),
            timeout=get_settings().quote_expiry_timeout_seconds,
            keep_result=0,
            keep_result_forever=False,
        ),
    )
    # The worker's own default, which also covers the results ARQ writes itself for a job that
    # fails before it runs (too many tries, an unknown function): none is kept (#176).
    keep_result = 0
    keep_result_forever = False
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
