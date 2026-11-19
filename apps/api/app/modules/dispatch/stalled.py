"""Requests no dispatch reached (#478): sent while no pro was eligible, so they kept no
request_dispatches row (DispatchService.dispatch: NO_ELIGIBLE_PROS changes nothing).

Stalled: received or reviewing (what dispatch takes), with a category, no dispatch row at all
(a request with any row, even all declined or expired, stays with the existing flow), not held
by the BDC while it waits for the customer (info_requested_at, #82), and created within
REDISPATCH_MAX_AGE_DAYS (requests have no lifetime of their own yet). Read
oldest first, at most REDISPATCH_BATCH_SIZE per read: never an unbounded query. Reading only:
the caller queues each request's dispatch (dispatch.tasks), which locks the request and checks
everything again.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.addresses.service import AddressService
from app.modules.dispatch.repository import DispatchRepository
from app.modules.dispatch.service import DISPATCHABLE
from app.modules.pros.service import ProService
from app.modules.requests.service import UndispatchedRequest, undispatched_requests
from app.modules.service_areas.schemas import zip5
from app.modules.service_areas.service import ServiceAreaService


@dataclass(frozen=True)
class StalledScan:
    """One read's bounds: requests created after `created_after`, at most `limit`."""

    created_after: datetime
    limit: int

    @classmethod
    def at(cls, now: datetime, settings: Settings) -> "StalledScan":
        return cls(
            created_after=now - timedelta(days=settings.redispatch_max_age_days),
            limit=settings.redispatch_batch_size,
        )


async def stalled_requests(session: AsyncSession, scan: StalledScan) -> list[uuid.UUID]:
    """The stalled requests, oldest first (the sweep)."""
    return [row.id for row in await _undispatched(session, scan, None)]


async def stalled_requests_for_pro(
    session: AsyncSession, pro_id: uuid.UUID, scan: StalledScan
) -> list[uuid.UUID]:
    """The stalled requests this pro could take now (the kick): none unless the pro receives
    requests (approved, payouts enabled); else those in one of its categories whose address is
    in one of its active service areas. The read is bounded before the area filter, so the
    sweep takes what a kick leaves."""
    coverage = await ProService(session).request_coverage(pro_id)
    if coverage is None or not coverage.category_ids:
        return []
    areas = ServiceAreaService(session)
    active = await areas.active_ids(coverage.service_area_ids)
    zips = {area.zip_code for area in await areas.get_many(active)}
    if not zips:
        return []
    rows = await _undispatched(session, scan, coverage.category_ids)
    zip_of = await AddressService(session).zip_codes([row.address_id for row in rows])
    return [row.id for row in rows if zip5(zip_of.get(row.address_id, "")) in zips]


async def _undispatched(
    session: AsyncSession, scan: StalledScan, category_ids: tuple[uuid.UUID, ...] | None
) -> list[UndispatchedRequest]:
    return await undispatched_requests(
        session,
        DispatchRepository.dispatched_request_ids(),
        DISPATCHABLE,
        created_after=scan.created_after,
        limit=scan.limit,
        category_ids=category_ids,
    )
