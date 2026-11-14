"""A request's address gets its point once, when the request is made (#384).

Before this, every computed route placed the job's address again with Mapbox's temporary
geocoding (jobs/route.py), which may not be kept: one more call, and the customer's address
sent to a vendor once more, on most polls of a driving pro. With GEOCODE_ON_SAVE the address
is placed once with PERMANENT geocoding, the only kind Mapbox's terms let us store, and the
point goes to `addresses.lat/lng`; the route reads it and asks for no geocoding.

- When: after the request's commit, in the worker. POST /v1/requests queues `geocode_address`
  with the address id and nothing else. A worker task and not a step of the request, so the
  customer's save waits for the queue at the most (JOB_ENQUEUE_TIMEOUT_SECONDS), never for
  Mapbox, and no transaction is open while Mapbox answers.
- Once: a request keeps the address it was made with, and nothing edits one (a static test
  holds that: tests/test_address_geocode_guard.py), so a row that has its point is never
  placed again. The task is registered with one try: another run would be another billed
  call. Only the backfill script asks again about a row that kept nothing, once per run.
- One caller at a time: the worker's task and the backfill script both run this step, so it
  takes the address's claim (addresses/geocode_claim.py) before it asks, and looks at the row
  again once it holds it. A caller that finds the claim taken asks nothing (BUSY): the
  address is being handled. The holder's turn has one deadline, shorter than the claim, for
  the look, Mapbox and the write; a turn that runs out keeps nothing. The turn also reads
  the clock itself before it asks and before it keeps the point (_in_time).
- What is kept: the point, to POINT_PLACES decimals, and only when Mapbox places it in the
  address's own state and ZIP. Anything else (no such address, another state or ZIP, Mapbox
  failing or slow, no token) keeps nothing: the row stays without a point, and its route
  places the address by itself each time, as before.
- The write is conditional: the point lands only on a row that still has none and still reads
  as it did when it was sent to Mapbox. A point never describes another text.
- Logs: the address id and the outcome. Never a coordinate, a part of the address or Mapbox's
  own text.
"""

import asyncio
import logging
import secrets
import uuid
from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.mapbox import (
    AddressGeocoder,
    KeptGeocode,
    MapboxUnavailableError,
    StreetAddress,
)
from app.modules.addresses.geocode_claim import GeocodeClaims, GeocodeClaimUnavailableError
from app.modules.addresses.repository import AddressRepository
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

GEOCODE_TASK: Final = "geocode_address"
# Five decimals are about 1.1 m: where a route ends. The column could hold a sixth (11 cm),
# which no use of the point needs.
POINT_PLACES: Final = 5
_QUANTUM: Final = Decimal(1).scaleb(-POINT_PLACES)
_ZIP_DIGITS: Final = 5


class GeocodeOutcome(StrEnum):
    # Mapbox was not asked:
    OFF = "off"  # GEOCODE_ON_SAVE is false
    MISSING = "missing"  # no such address
    ALREADY = "already"  # the row has its point
    BUSY = "busy"  # another caller holds the address's claim: it is being handled
    # Mapbox was asked:
    STORED = "stored"
    NO_RESULT = "no_result"  # it finds no such address
    MISMATCH = "mismatch"  # its answer is in another state or ZIP
    # It failed, was slow, or there is no token. Also a turn that ran out before the point
    # was kept: counted as asked, whichever step was the slow one. (A turn cut while its
    # COMMIT was being answered may have kept the point: the next run reads ALREADY.)
    UNAVAILABLE = "unavailable"
    CHANGED = "changed"  # the row got a point, or another text, while it answered

    @property
    def asked(self) -> bool:
        """Whether this outcome cost a call to Mapbox."""
        return self not in _NOT_ASKED


_NOT_ASKED: Final = frozenset(
    {GeocodeOutcome.OFF, GeocodeOutcome.MISSING, GeocodeOutcome.ALREADY, GeocodeOutcome.BUSY}
)
_SKIPPED: Final = (logging.INFO, "address_geocode_skipped")
_NOT_KEPT: Final = (logging.WARNING, "address_geocode_not_kept")
_EVENTS: Final[Mapping[GeocodeOutcome, tuple[int, str]]] = MappingProxyType(
    {
        GeocodeOutcome.OFF: _SKIPPED,
        GeocodeOutcome.MISSING: _SKIPPED,
        GeocodeOutcome.ALREADY: _SKIPPED,
        GeocodeOutcome.BUSY: _SKIPPED,
        GeocodeOutcome.STORED: (logging.INFO, "address_geocoded"),
        GeocodeOutcome.NO_RESULT: _NOT_KEPT,
        GeocodeOutcome.MISMATCH: _NOT_KEPT,
        GeocodeOutcome.UNAVAILABLE: _NOT_KEPT,
        GeocodeOutcome.CHANGED: _NOT_KEPT,
    }
)


def geocode_job_id(address_id: uuid.UUID) -> str:
    return f"geocode-address:{address_id}"


async def enqueue_geocode(queue: JobQueue, address_id: uuid.UUID, timeout_seconds: float) -> bool:
    """Queues geocode_address for the address (after its commit). Only the id travels: the
    worker reads the address itself. See app.queue.enqueue."""
    return await enqueue(
        queue,
        GEOCODE_TASK,
        str(address_id),
        job_id=geocode_job_id(address_id),
        timeout_seconds=timeout_seconds,
    )


def same_area(asked: StreetAddress, found: KeptGeocode) -> bool:
    """Whether Mapbox's answer is in the state and the ZIP of the address it was asked about.
    A result elsewhere is another place with a like name, or the street of a mistyped ZIP:
    its point must not become the address's. An answer that names no state or no ZIP is not
    checked, so it is not kept either."""
    if found.region_code is None or found.postcode is None:
        return False
    return (
        found.region_code.upper() == asked.state.upper()
        and found.postcode[:_ZIP_DIGITS] == asked.zip_code[:_ZIP_DIGITS]
    )


class _TurnEndedError(Exception):
    """The holder's turn is over by the clock, and its deadline's timer has not run."""


def _in_time(turn_ends: float) -> None:
    """Ends a turn whose time is over. asyncio's deadline cuts a turn at an await, and only
    once the loop runs its timer: a loop that was held up (a step that blocked, a process
    that was paused) hands the turn its answer first, late. So the turn reads the clock
    before each thing that must not happen late: starting, asking Mapbox, keeping the
    point."""
    if asyncio.get_running_loop().time() >= turn_ends:
        raise _TurnEndedError


def rounded(degrees: float) -> Decimal:
    """A coordinate as it is stored: POINT_PLACES decimals, ties away from zero."""
    return Decimal(str(degrees)).quantize(_QUANTUM, rounding=ROUND_HALF_UP)


class AddressGeocodeService:
    """Owns its transactions: it commits before Redis or Mapbox is asked (nothing waits on
    them with a connection held) and again after the write."""

    def __init__(
        self,
        session: AsyncSession,
        geocoder: AddressGeocoder,
        claims: GeocodeClaims,
        *,
        enabled: bool,
    ) -> None:
        self._session = session
        self._addresses = AddressRepository(session)
        self._geocoder = geocoder
        self._claims = claims
        self._enabled = enabled

    async def geocode(self, address_id: uuid.UUID) -> GeocodeOutcome:
        """Gives the address its point when it has none and Mapbox places it in its own state
        and ZIP. Never raises for Mapbox: every outcome but STORED leaves the row as it was.
        Raises GeocodeClaimUnavailableError, Mapbox not asked, when the claim cannot be
        taken."""
        outcome = await self._geocode(address_id)
        level, event = _EVENTS[outcome]
        logger.log(level, event, extra={"address_id": str(address_id), "outcome": outcome.value})
        return outcome

    async def _geocode(self, address_id: uuid.UUID) -> GeocodeOutcome:
        if not self._enabled:
            return GeocodeOutcome.OFF
        # Before the claim: a row that needs no call takes none.
        place = await self._place_without_point(address_id)
        if isinstance(place, GeocodeOutcome):
            return place
        token = secrets.token_hex()
        # Counted from before Redis is asked: Redis counts the claim's time from when it
        # takes it, which is later, so this turn ends before the claim does.
        turn_ends = asyncio.get_running_loop().time() + self._claims.work_seconds
        if not await self._claims.claim(address_id, token=token):
            return GeocodeOutcome.BUSY
        try:
            async with asyncio.timeout_at(turn_ends) as turn:
                return await self._ask_and_keep(address_id, turn_ends)
        except _TurnEndedError:
            return await self._turn_ended(address_id)
        except TimeoutError:
            if not turn.expired():
                raise  # not the turn's deadline: a failure of its own, as before
            return await self._turn_ended(address_id)
        finally:
            await self._release(address_id, token)

    async def _turn_ended(self, address_id: uuid.UUID) -> GeocodeOutcome:
        """The turn ran out. A point it wrote and did not commit is undone here, past the
        deadline's scope: nothing cuts the rollback short."""
        await self._session.rollback()
        logger.warning("address_geocode_turn_ended", extra={"address_id": str(address_id)})
        return GeocodeOutcome.UNAVAILABLE

    async def _ask_and_keep(self, address_id: uuid.UUID, turn_ends: float) -> GeocodeOutcome:
        """The holder's turn. The look before the claim is old by now: a caller that held the
        claim since may have kept the point, so the row is read again, and this look decides."""
        _in_time(turn_ends)  # the claim can come with the turn's time spent
        asked = await self._place_without_point(address_id)
        if isinstance(asked, GeocodeOutcome):
            return asked
        _in_time(turn_ends)
        try:
            found = await self._geocoder.geocode_to_keep(asked)
        except MapboxUnavailableError:
            # The wrapper logged what failed, without the address.
            return GeocodeOutcome.UNAVAILABLE
        if found is None:
            return GeocodeOutcome.NO_RESULT
        if not same_area(asked, found):
            return GeocodeOutcome.MISMATCH
        kept = await self._addresses.set_point(
            address_id,
            line1=asked.line1,
            city=asked.city,
            state=asked.state,
            zip_code=asked.zip_code,
            lat=rounded(found.coordinate.lat),
            lng=rounded(found.coordinate.lng),
        )
        _in_time(turn_ends)
        await self._session.commit()
        return GeocodeOutcome.STORED if kept else GeocodeOutcome.CHANGED

    async def _place_without_point(self, address_id: uuid.UUID) -> StreetAddress | GeocodeOutcome:
        """The address as Mapbox is asked about it, or why it is not asked. Ends the read
        transaction: no pooled connection waits on Redis or on Mapbox."""
        place = await self._addresses.place_to_geocode(address_id)
        await self._session.commit()
        if place is None:
            return GeocodeOutcome.MISSING
        line1, city, state, zip_code, without_point = place
        if not without_point:
            return GeocodeOutcome.ALREADY
        # The street line and the place: the unit line places nothing, and is not even read.
        return StreetAddress(line1=line1, city=city, state=state, zip_code=zip_code)

    async def _release(self, address_id: uuid.UUID, token: str) -> None:
        try:
            await self._claims.release(address_id, token=token)
        except GeocodeClaimUnavailableError:
            # The claim ends by itself (geocode_claim.claim_seconds).
            logger.error(
                "address_geocode_claim_not_released", extra={"address_id": str(address_id)}
            )

    async def pending_count(self) -> int:
        """How many addresses have no point (the backfill's dry run)."""
        return await self._addresses.count_without_point()

    async def pending(self, *, after: uuid.UUID | None, limit: int) -> list[uuid.UUID]:
        """The next `limit` addresses without a point, by id, past `after` (the backfill)."""
        return await self._addresses.ids_without_point(after=after, limit=limit)
