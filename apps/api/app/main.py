"""FastAPI application factory. Run it with `python -m app.serve`."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from arq.connections import ArqRedis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import v1_router
from app.config import CHAT_ORIGINAL_KEY_EXPECTED_IN, Settings, get_settings
from app.db import create_engine, create_session_factory
from app.errors import register_error_handlers
from app.middleware import REQUEST_ID_HEADER, NoStoreMiddleware, RequestIdMiddleware
from app.modules.health.router import router as health_router
from app.modules.jobs.location import location_backend
from app.observability import configure_logging, init_sentry

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    init_sentry(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Neither client connects here; they connect on first use.
        engine = create_engine(settings)
        # ARQ's own client (a Redis): rate limits and codes use it as is, and routes can queue
        # jobs for the worker through it (app/queue.py).
        redis = ArqRedis.from_url(settings.redis_url)
        app.state.engine = engine
        app.state.session_factory = create_session_factory(engine)
        app.state.redis = redis
        # The pros' live positions (#350) get a Redis of their own; see jobs/location_guard.py.
        locations = location_backend(settings, redis)
        app.state.location_backend = locations
        if locations is None:
            # Fail closed: the position routes answer 503 until LOCATION_REDIS_URL is set.
            logger.warning("location_redis_not_configured", extra={"app_env": settings.app_env})
        elif settings.location_redis_assume_ephemeral:
            # The deployer's word stands in for a CONFIG GET the Redis refuses.
            logger.warning(
                "location_redis_assume_ephemeral_set", extra={"app_env": settings.app_env}
            )
        if (
            settings.app_env in CHAT_ORIGINAL_KEY_EXPECTED_IN
            and settings.chat_original_cipher() is None
        ):
            # Fail closed (#72): redacted chat messages keep no original until it is set.
            logger.warning("chat_original_key_missing", extra={"app_env": settings.app_env})
        logger.info("api_started", extra={"app_env": settings.app_env})
        try:
            yield
        finally:
            if locations is not None and locations.redis is not redis:
                await locations.redis.aclose()
            await redis.aclose()
            await engine.dispose()

    app = FastAPI(title="Jack Fix It API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings

    # Added first so it is the innermost: it only needs the route the router matched.
    app.add_middleware(NoStoreMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", REQUEST_ID_HEADER],
        expose_headers=[REQUEST_ID_HEADER],
    )
    # Added last so it is the outermost user middleware and also tags CORS preflights.
    app.add_middleware(RequestIdMiddleware)
    register_error_handlers(app)

    app.include_router(health_router)
    app.include_router(v1_router)
    return app
