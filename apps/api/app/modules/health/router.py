from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from starlette.requests import Request

from app.config import Settings, get_app_settings
from app.modules.health.schemas import LivenessResponse, ReadinessResponse
from app.modules.health.service import DependencyProbes, LiveProbes, check_readiness

router = APIRouter(prefix="/health", tags=["health"])


def get_dependency_probes(request: Request) -> DependencyProbes:
    return LiveProbes(engine=request.app.state.engine, redis_client=request.app.state.redis)


@router.get("", response_model=LivenessResponse, summary="Liveness")
async def liveness() -> LivenessResponse:
    """The process is up. Checks no dependencies; this is the Railway healthcheck."""
    return LivenessResponse()


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    summary="Readiness",
    responses={
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "model": ReadinessResponse,
            "description": "Postgres or Redis did not answer in time.",
        }
    },
)
async def readiness(
    response: Response,
    probes: Annotated[DependencyProbes, Depends(get_dependency_probes)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> ReadinessResponse:
    """Postgres answers SELECT 1 and Redis answers PING, each within the configured timeout."""
    result = await check_readiness(probes, settings.health_check_timeout_seconds)
    if result.status != "ok":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return result
