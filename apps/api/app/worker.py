"""ARQ worker. Start it with:

arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
"""

import logging
from typing import Any

from arq.connections import RedisSettings

from app.config import get_settings
from app.observability import configure_logging, init_sentry

logger = logging.getLogger(__name__)


async def ping(ctx: dict[str, Any]) -> str:
    """Smoke-test task. ARQ refuses to start with zero functions."""
    return "pong"


async def startup(ctx: dict[str, Any]) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    init_sentry(settings)
    # Sentinel looks for this line to confirm a worker deploy is healthy.
    logger.info("worker_started", extra={"app_env": settings.app_env})


async def shutdown(ctx: dict[str, Any]) -> None:
    logger.info("worker_stopped")


class WorkerSettings:
    functions = (ping,)
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
