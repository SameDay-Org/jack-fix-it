"""ARQ worker. Start it with:

arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
"""

import logging
from typing import Any

from arq import cron, func
from arq.connections import RedisSettings

from app.config import get_settings
from app.db import create_engine, create_session_factory
from app.integrations.expo_push import ExpoPushSender
from app.integrations.storage import S3Storage, StorageNotConfiguredError
from app.modules.dispatch.tasks import dispatch_request
from app.modules.notifications.push_tasks import check_push_receipts, send_push
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES, sanitize_request_media
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
        # Development without storage: media copies wait (sanitize_request_media logs it).
        ctx["storage"] = None
    # Sentinel looks for this line to confirm a worker deploy is healthy.
    logger.info("worker_started", extra={"app_env": settings.app_env})


async def shutdown(ctx: dict[str, Any]) -> None:
    if "engine" in ctx:
        await ctx["engine"].dispose()
    logger.info("worker_stopped")


def every(minutes: int) -> set[int]:
    """The minutes of the hour a cron every `minutes` runs at (60 means once an hour)."""
    return set(range(0, 60, minutes))


class WorkerSettings:
    functions = (
        ping,
        dispatch_request,
        # No result is kept, so a receipt that asks for a resend can queue the message's job id
        # again once the first run is over; the tries match the sends per device.
        func(send_push, keep_result=0, max_tries=get_settings().push_max_attempts),
        # No result is kept: a failed run's exception (with its SQL) never stays in Redis, and
        # the job id is free again once a run ends; rows already copied are skipped. Two spare
        # tries: the job fails its rows from MEDIA_SANITIZE_MAX_TRIES on, so a try stopped by a
        # deploy or a timeout is followed by one that still settles them.
        func(
            sanitize_request_media,
            keep_result=0,
            max_tries=get_settings().media_sanitize_max_tries + SANITIZE_SPARE_TRIES,
            timeout=get_settings().media_sanitize_job_timeout_seconds,
        ),
    )
    cron_jobs = (
        cron(check_push_receipts, minute=every(get_settings().push_receipt_check_minutes)),
    )
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
