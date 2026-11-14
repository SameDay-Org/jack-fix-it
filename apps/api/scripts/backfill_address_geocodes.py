"""Give the addresses made before geocode on save their point (#384).

    uv run python -m scripts.backfill_address_geocodes            # dry run: counts only
    uv run python -m scripts.backfill_address_geocodes --apply    # asks Mapbox, keeps points

From apps/api; on Railway from a shell in the worker (`railway ssh --service worker`).

Geocode on save (app/modules/addresses/geocode.py) covers the requests made while
GEOCODE_ON_SAVE is on. This fills the rows made before, and those whose geocoding did not
happen, with the very same step: one permanent geocoding call per address without a point, the
point kept only when Mapbox puts it in the address's own state and ZIP.

- Which rows: every address without a point, whatever became of its request (open,
  cancelled, expired or done). The dry run's count is the number of calls --apply makes.
- A dry run unless --apply is given: it counts the addresses without a point and asks Mapbox
  nothing.
- --apply needs GEOCODE_ON_SAVE=true and MAPBOX_ACCESS_TOKEN: each address asked about is a
  billed call. It reads GEOCODE_BACKFILL_BATCH_SIZE ids at a time and asks about at most
  GEOCODE_BACKFILL_PER_MINUTE addresses a minute.
- --apply needs an operator: it never runs unattended. Before Mapbox is asked anything it
  prints how many addresses it would send and that each is billed, and goes on only when
  standard input is a terminal and the operator types that number. No terminal (a pipe, a
  file, a scheduled job), the end of the input, an empty line or any other answer stops the
  run, exit 1, Mapbox not asked. Nothing skips the question: there is no --yes flag and no
  variable for it. The run then asks about that many addresses at the most.
- One caller per address: the worker may be geocoding the same rows, and another run of this
  script too. Each address is claimed in Redis (REDIS_URL, the queue's own;
  app/modules/addresses/geocode_claim.py) before Mapbox is asked about it. An address
  claimed elsewhere is skipped, not waited for. Redis unreachable stops the run, exit 1:
  without its claim no address is asked about.
- When Mapbox is unavailable: one such answer can be about its own address (a text Mapbox
  refuses), so the run goes on to the next row. STOP_AFTER_UNAVAILABLE of them in a row are
  Mapbox itself (a refused token, no billing, a rate limit, an outage): the run stops, and
  the rest waits for the next run.
- Idempotent: an address that has its point is never asked about again. An address that kept
  nothing (not found, found in another state or ZIP, or unavailable) stays without a point,
  and each later run asks about it once more: one more billed call each time.
- Prints counts only: never an address, an id or a coordinate. The log lines carry the
  address id and the outcome.
"""

import argparse
import asyncio
import sys
from collections import Counter
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AbstractAsyncContextManager
from typing import Final, TextIO

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.integrations.mapbox import AddressGeocoder, provider_from_settings
from app.modules.addresses.geocode import AddressGeocodeService, GeocodeOutcome
from app.modules.addresses.geocode_claim import (
    GeocodeClaims,
    GeocodeClaimUnavailableError,
    RedisGeocodeClaims,
)
from app.observability import configure_logging

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]
Sleep = Callable[[float], Awaitable[None]]

_SECONDS_PER_MINUTE: Final = 60
# Answers in a row saying Mapbox is unavailable that end a run: fewer can be about the
# addresses themselves, and the next row is still worth asking about.
STOP_AFTER_UNAVAILABLE: Final = 3
# The report's lines, in order. OFF and MISSING cannot happen here: the run needs the switch
# on, and reads ids of rows that exist (an address is never deleted).
_LINES: Final = (
    (GeocodeOutcome.STORED, "Point kept"),
    (GeocodeOutcome.NO_RESULT, "Not found by Mapbox"),
    (GeocodeOutcome.MISMATCH, "Found in another state or ZIP (nothing kept)"),
    (GeocodeOutcome.CHANGED, "Changed meanwhile (nothing kept)"),
    (GeocodeOutcome.ALREADY, "Had a point by then"),
    (GeocodeOutcome.BUSY, "Claimed by the worker or another run (skipped)"),
    (GeocodeOutcome.UNAVAILABLE, "Mapbox unavailable"),
)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.backfill_address_geocodes",
        description="Give the addresses without a point theirs (Mapbox permanent geocoding).",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Ask Mapbox (one billed call per address) and keep the points, after an operator "
        "at a terminal types the number of addresses. Without it: a dry run that only counts.",
    )
    return parser.parse_args(argv)


def confirmed(pending: int, stdin: TextIO, out: TextIO) -> bool:
    """Whether an operator at a terminal typed `pending`, the number of addresses the run
    would send to Mapbox. Anything else is a no, and says so on `out`."""
    print(
        f"{pending} addresses without a point, of every request, open or not, would be sent "
        f"to Mapbox.\nPermanent geocoding is billed per address: up to {pending} billed calls.",
        file=out,
    )
    if not stdin.isatty():
        print(
            "Error: --apply needs an operator at a terminal, and standard input is not one. "
            "Nothing was asked.",
            file=out,
        )
        return False
    print(f"Type {pending} to go on (anything else stops): ", end="", file=out, flush=True)
    answer = stdin.readline()  # the end of the input reads as an empty answer
    if not answer.endswith("\n"):
        print(file=out)  # the input ended on the question's own line
    if answer.strip() != str(pending):
        print("Not confirmed. Nothing was asked.", file=out)
        return False
    return True


async def run(
    argv: Sequence[str],
    sessions: SessionFactory,
    settings: Settings,
    geocoder: AddressGeocoder,
    out: TextIO,
    sleep: Sleep = asyncio.sleep,
    *,
    claims: GeocodeClaims,
    stdin: TextIO,
) -> int:
    """0 when the run got to its end, or asked about as many addresses as were confirmed; 1
    when it was refused or not confirmed, or stopped because Mapbox or Redis was unavailable."""
    args = parse_args(argv)
    async with sessions() as session:
        pending = await _service(session, geocoder, claims).pending_count()
    if not args.apply:
        print(
            f"Dry run: {pending} addresses without a point, of every request, open or not. "
            "Mapbox was not asked. With --apply each of them is one billed call.",
            file=out,
        )
        return 0
    if not settings.geocode_on_save:
        print(
            "Error: GEOCODE_ON_SAVE is false. Set it to true (after billing is set up on "
            "the Mapbox account) before filling the existing addresses. Nothing was asked.",
            file=out,
        )
        return 1
    if settings.mapbox_access_token is None:
        print("Error: MAPBOX_ACCESS_TOKEN is not set. Nothing was asked.", file=out)
        return 1
    if pending == 0:
        print("No address without a point. Nothing was asked.", file=out)
        return 0
    if not confirmed(pending, stdin, out):
        return 1

    counts: Counter[GeocodeOutcome] = Counter()
    pause = _SECONDS_PER_MINUTE / settings.geocode_backfill_per_minute
    after = None
    asked = 0
    unavailable_in_a_row = 0
    stopped: tuple[int, str] | None = None  # the exit code, and why the run ended early
    while stopped is None:
        async with sessions() as session:
            ids = await _service(session, geocoder, claims).pending(
                after=after, limit=settings.geocode_backfill_batch_size
            )
        if not ids:
            break
        for address_id in ids:
            if asked >= pending:
                stopped = (
                    0,
                    f"Stopped: Mapbox was asked about {asked} addresses, the number confirmed, "
                    "and more are without a point by now. Run it again for the rest.",
                )
                break
            try:
                # A session per address: each geocode is its own short transactions.
                async with sessions() as session:
                    outcome = await _service(session, geocoder, claims).geocode(address_id)
            except GeocodeClaimUnavailableError:
                stopped = (
                    1,
                    "Stopped: Redis (REDIS_URL) is unreachable, so no address can be claimed. "
                    "Mapbox was not asked about this address or the rest.",
                )
                break
            counts[outcome] += 1
            if outcome is GeocodeOutcome.UNAVAILABLE:
                unavailable_in_a_row += 1
                if unavailable_in_a_row >= STOP_AFTER_UNAVAILABLE:
                    stopped = (
                        1,
                        f"Stopped: Mapbox was unavailable {STOP_AFTER_UNAVAILABLE} times in a "
                        "row. Run it again later for the rest.",
                    )
                    break
            elif outcome.asked:
                unavailable_in_a_row = 0  # Mapbox answered: the ones before were their own
            if outcome.asked:
                asked += 1
                await sleep(pause)
        after = ids[-1]

    print(f"Addresses looked at: {sum(counts.values())}", file=out)
    for outcome, label in _LINES:
        print(f"  {label}: {counts[outcome]}", file=out)
    if stopped is None:
        return 0
    code, why = stopped
    print(why, file=out)
    return code


def _service(
    session: AsyncSession, geocoder: AddressGeocoder, claims: GeocodeClaims
) -> AddressGeocodeService:
    return AddressGeocodeService(session, geocoder, claims, enabled=True)


async def _main(argv: Sequence[str]) -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings)
    # The queue's own Redis, where the worker takes its claims too.
    redis: Redis = Redis.from_url(settings.redis_url)
    try:
        return await run(
            argv,
            create_session_factory(engine),
            settings,
            provider_from_settings(settings),
            sys.stdout,
            claims=RedisGeocodeClaims.from_settings(redis, settings),
            stdin=sys.stdin,
        )
    finally:
        await redis.aclose()
        await engine.dispose()


def main() -> None:
    sys.exit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
