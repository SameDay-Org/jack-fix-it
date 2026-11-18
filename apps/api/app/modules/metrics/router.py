from collections.abc import Callable
from datetime import date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.db import get_session
from app.errors import ErrorResponse
from app.middleware import NoStoreRoute
from app.modules.auth.permissions import PanelUser
from app.modules.metrics.schemas import MetricsOut
from app.modules.metrics.service import MetricsConfig, MetricsService, utc_now
from app.rate_limit import RateLimiter, enforce_limit, get_rate_limiter

# The BDC and admins read the dashboard's figures (#84). No HTTP cache keeps an answer, errors
# included.
staff_router = APIRouter(prefix="/admin/metrics", tags=["metrics"], route_class=NoStoreRoute)


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


def get_metrics_clock() -> Callable[[], datetime]:
    """FastAPI dependency: the server's clock for "today" (a fixed one in tests)."""
    return utc_now


def get_metrics_service(
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    clock: Annotated[Callable[[], datetime], Depends(get_metrics_clock)],
) -> MetricsService:
    return MetricsService(session, MetricsConfig.from_settings(settings), clock)


async def limit_metrics_reads(
    user: PanelUser,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> None:
    """METRICS_READ_LIMIT reads per staff member per METRICS_READ_WINDOW_SECONDS: each one
    aggregates every request and job of its range."""
    await enforce_limit(
        limiter,
        "metrics_read",
        str(user.id),
        limit=settings.metrics_read_limit,
        window_seconds=settings.metrics_read_window_seconds,
        timeout_seconds=settings.rate_limit_timeout_seconds,
    )


@staff_router.get(
    "",
    response_model=MetricsOut,
    summary="The dashboard's metrics (staff)",
    dependencies=[Depends(limit_metrics_reads)],
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_token: missing, invalid or expired token."),
        status.HTTP_403_FORBIDDEN: _error("forbidden: only agents and admins."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: a date that is not YYYY-MM-DD. invalid_range: `from` after "
            "`to`, a range longer than METRICS_MAX_RANGE_DAYS days, or `tz` not an IANA time "
            "zone."
        ),
        status.HTTP_429_TOO_MANY_REQUESTS: _error(
            "rate_limited: more than METRICS_READ_LIMIT reads in the window; Retry-After says "
            "when to try again."
        ),
    },
)
async def read_metrics(
    user: PanelUser,
    metrics: Annotated[MetricsService, Depends(get_metrics_service)],
    first: Annotated[
        date | None, Query(alias="from", description="The first day, YYYY-MM-DD.")
    ] = None,
    last: Annotated[
        date | None,
        Query(alias="to", description="The last day, YYYY-MM-DD, inclusive (default: today)."),
    ] = None,
    tz: Annotated[
        str | None,
        Query(
            max_length=64,
            pattern=r"^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$",
            description="An IANA time zone the days are read in (default: BUSINESS_TIME_ZONE).",
        ),
    ] = None,
) -> MetricsOut:
    """The MVP exit metrics over whole days, both inclusive (default: the last
    METRICS_DEFAULT_RANGE_DAYS days, today included). Ratios come with their numerator and
    denominator (null when the denominator is 0), each figure with its formula's key
    (docs/kpis.md), and a per-day series. Aggregates only: no name, contact, address or id.
    Revenue is gross of refunds until they are recorded (`refunds_netted`)."""
    return await metrics.read(first, last, tz)
