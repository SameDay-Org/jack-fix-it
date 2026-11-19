"""Requests no dispatch reached (#478): sent while no pro was eligible, so they kept no
request_dispatches row (DispatchService.dispatch: NO_ELIGIBLE_PROS changes nothing).

Stalled: received or reviewing (what dispatch takes), with a category, no dispatch row at all
(a request with any row, even all declined or expired, stays with the existing flow), and
created within REDISPATCH_MAX_AGE_DAYS (requests have no lifetime of their own yet). Every read
is bounded (REDISPATCH_BATCH_SIZE) with all its filters in the statement, before the limit:
never an unbounded query. Reading only: the caller queues each request's dispatch
(dispatch.tasks), which locks the request and checks everything again.

- The kick (one pro may have become eligible): the stalled requests in one of the pro's
  categories at an address in one of its active service areas' ZIPs, oldest first. Every
  request it reads is one the pro matches, so requests elsewhere never fill its batch (#500
  round 1).
- The sweep (everything else): a request still stalled after a dispatch matched no pro stays
  stalled, so reading the oldest ones every run would read the same ones forever. The sweep
  reads forward instead, from where the last run stopped (dispatch.history's cursor), and
  starts over from the oldest once it reaches the end: every stalled request is read within
  ceil(stalled / batch) + 1 runs, whatever sits ahead of it. A request the sweep queued within
  REDISPATCH_RETRY_MINUTES is passed over, so one no pro can take is tried again about once per
  window, not every run. A request a dispatch reached has a row and leaves the set by itself.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.addresses.service import AddressService
from app.modules.dispatch.history import Cursor, RedispatchHistory
from app.modules.dispatch.repository import DispatchRepository
from app.modules.dispatch.service import DISPATCHABLE
from app.modules.pros.service import ProService
from app.modules.requests.service import UndispatchedRequest, undispatched_requests
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


@dataclass(frozen=True)
class SweepConfig:
    retry_after: timedelta
    # How long the history keeps an entry and the cursor (history_keep).
    keep: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "SweepConfig":
        retry_after = timedelta(minutes=settings.redispatch_retry_minutes)
        cadence = timedelta(minutes=settings.redispatch_sweep_minutes)
        return cls(retry_after=retry_after, keep=history_keep(retry_after, cadence))


def history_keep(retry_after: timedelta, cadence: timedelta) -> timedelta:
    """Twice the longer of the retry window and the sweep's cadence: an entry outlives its
    window (a request is never retried sooner than REDISPATCH_RETRY_MINUTES because its entry
    was trimmed), and the cursor outlives the gap between two runs. Bounded: entries older than
    this are trimmed on every write."""
    return 2 * max(retry_after, cadence)


@dataclass(frozen=True)
class SweepBatch:
    """What one sweep run read: the requests to queue now, how many it passed over (queued
    within the retry window), and where the next run starts (None: from the oldest)."""

    due: list[uuid.UUID]
    passed_over: int
    next_cursor: Cursor | None


async def sweep_batch(
    session: AsyncSession,
    history: RedispatchHistory,
    scan: StalledScan,
    config: SweepConfig,
    now: datetime,
) -> SweepBatch:
    """The sweep's next batch (see the module doc). A history read that fails raises: the
    caller ends the run."""
    cursor = await history.cursor()
    rows = await _undispatched(session, scan, after=cursor)
    if not rows and cursor is not None:
        # The last run stopped at the end: this one starts the next round.
        rows = await _undispatched(session, scan)
    # A full batch: the next run goes on after it; a short one reached the end.
    last = rows[-1] if len(rows) == scan.limit else None
    next_cursor = None if last is None else (last.created_at, last.id)
    queued_at = await history.queued_at([str(row.id) for row in rows])
    retry_before = (now - config.retry_after).timestamp()
    due = [row.id for row in rows if queued_at.get(str(row.id), retry_before) <= retry_before]
    return SweepBatch(due=due, passed_over=len(rows) - len(due), next_cursor=next_cursor)


async def stalled_requests_for_pro(
    session: AsyncSession, pro_id: uuid.UUID, scan: StalledScan
) -> list[uuid.UUID]:
    """The stalled requests this pro could take now (the kick): none unless the pro receives
    requests (approved, payouts enabled); else those in one of its categories at an address in
    one of its active service areas' ZIPs, oldest first. Both filters are in the statement,
    before the limit. The kick never reads the sweep's history."""
    coverage = await ProService(session).request_coverage(pro_id)
    if coverage is None or not coverage.category_ids:
        return []
    areas = ServiceAreaService(session)
    active = await areas.active_ids(coverage.service_area_ids)
    zips = {area.zip_code for area in await areas.get_many(active)}
    if not zips:
        return []
    addresses = AddressService.zips()
    # A ZIP+4 address is served when its 5-digit ZIP is (service_areas.schemas.zip5).
    covered = select(addresses.c.address_id).where(
        func.left(addresses.c.zip_code, 5).in_(sorted(zips))
    )
    rows = await _undispatched(
        session, scan, category_ids=coverage.category_ids, address_ids=covered
    )
    return [row.id for row in rows]


async def _undispatched(
    session: AsyncSession,
    scan: StalledScan,
    *,
    category_ids: tuple[uuid.UUID, ...] | None = None,
    address_ids: Select[uuid.UUID] | None = None,
    after: Cursor | None = None,
) -> list[UndispatchedRequest]:
    return await undispatched_requests(
        session,
        DispatchRepository.dispatched_request_ids(),
        DISPATCHABLE,
        created_after=scan.created_after,
        limit=scan.limit,
        category_ids=category_ids,
        address_ids=address_ids,
        after=after,
    )
