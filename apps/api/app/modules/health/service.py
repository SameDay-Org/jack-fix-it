import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.modules.health.schemas import CheckStatus, DependencyChecks, ReadinessResponse

logger = logging.getLogger(__name__)


class DependencyProbes(Protocol):
    """Each probe returns when the dependency answers and raises otherwise."""

    async def database(self) -> None: ...

    async def redis(self) -> None: ...


@dataclass(frozen=True)
class LiveProbes:
    engine: AsyncEngine
    redis_client: Redis

    async def database(self) -> None:
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def redis(self) -> None:
        await self.redis_client.ping()


async def check_readiness(probes: DependencyProbes, timeout_seconds: float) -> ReadinessResponse:
    database, redis = await asyncio.gather(
        _run_probe("database", probes.database, timeout_seconds),
        _run_probe("redis", probes.redis, timeout_seconds),
    )
    ready = database is CheckStatus.OK and redis is CheckStatus.OK
    return ReadinessResponse(
        status="ok" if ready else "unavailable",
        checks=DependencyChecks(database=database, redis=redis),
    )


async def _run_probe(
    name: str, probe: Callable[[], Awaitable[None]], timeout_seconds: float
) -> CheckStatus:
    try:
        await asyncio.wait_for(probe(), timeout=timeout_seconds)
    except Exception as exc:  # noqa: BLE001 - any failure means "not ready"
        # Only the exception type: driver messages can include hosts and user names.
        logger.warning(
            "readiness_probe_failed",
            extra={"dependency": name, "error_type": type(exc).__name__},
        )
        return CheckStatus.FAIL
    return CheckStatus.OK
