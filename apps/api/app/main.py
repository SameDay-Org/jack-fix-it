"""FastAPI application factory. Run it with `python -m app.serve`."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from arq.connections import ArqRedis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import v1_router
from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.errors import register_error_handlers
from app.middleware import REQUEST_ID_HEADER, RequestIdMiddleware
from app.modules.health.router import router as health_router
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
        logger.info("api_started", extra={"app_env": settings.app_env})
        try:
            yield
        finally:
            await redis.aclose()
            await engine.dispose()

    app = FastAPI(title="Jack Fix It API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings

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
