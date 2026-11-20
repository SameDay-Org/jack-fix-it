"""Seed the demo database for the end-to-end video (docs/demo-video.md).

    cd apps/api
    uv run python ../../scripts/demo/seed_demo.py --reset     # a clean demo database
    uv run python ../../scripts/demo/seed_demo.py             # again: nothing changes
    uv run python ../../scripts/demo/seed_demo.py --fresh     # one more request in "New"

It refuses to run unless DATABASE_URL names a local `jackdemo*` database (demo_seed/guard.py),
then drives the real API in this process (demo_seed/world.py): accounts, a 30-day history
(deterministic: --seed, --days) and the scenes the video needs (demo_seed/scenes.py). The API
and the worker do not need to be running, and should not be while `--reset` drops the
database.

Every demo account shares one password. It is generated on the first run and kept in an
untracked file (--password-file, default scripts/demo/.demo-password), printed once.
"""

import argparse
import asyncio
import os
import secrets
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

DEMO_DIR: Final = Path(__file__).resolve().parent
API_DIR: Final = DEMO_DIR.parents[1] / "apps" / "api"
# The API's own packages (`app`, `scripts`), and the settings' .env, live in apps/api.
sys.path.insert(0, str(API_DIR))
# Where the command was typed: a relative --password-file is read from there.
INVOKED_FROM: Final = Path.cwd()
if __name__ == "__main__":
    # The settings read apps/api/.env from the current directory, and app.worker (imported
    # below) loads them as it is imported: the directory changes before that.
    os.chdir(API_DIR)

from pydantic import JsonValue  # noqa: E402

from app.config import Settings, get_settings  # noqa: E402
from app.integrations.storage import S3Storage, Storage, StorageNotConfiguredError  # noqa: E402
from app.integrations.stripe_connect import StripeExpressConnect  # noqa: E402
from demo_seed import cast, flows, guard, scenes, stripe_test  # noqa: E402
from demo_seed.bucket import BucketState, ensure_local_bucket  # noqa: E402
from demo_seed.stripe_standins import (  # noqa: E402
    StandInAccounts,
    StandInPayments,
    StandInRefunds,
    StandInTransfers,
)
from demo_seed.world import Gateways, SeedError, open_world  # noqa: E402
from scripts import seed_categories, seed_service_areas  # noqa: E402

DEFAULT_SEED: Final = 20261119
DEFAULT_DAYS: Final = 30
PASSWORD_FILE: Final = DEMO_DIR / ".demo-password"
PRO_ACCOUNT_ENV: Final = "DEMO_PRO_STRIPE_ACCOUNT"
_WORDS: Final = (
    "Maple",
    "Harbor",
    "Cedar",
    "Summit",
    "Willow",
    "Canyon",
    "Meadow",
    "Juniper",
    "Copper",
    "Lantern",
    "Orchard",
    "Pebble",
    "Ridge",
    "Saffron",
    "Timber",
    "Violet",
)


@dataclass(frozen=True)
class Run:
    """One call of the seed: what to do, and where the demo password is kept."""

    seed: int
    days: int
    fresh: bool
    password_file: Path
    pro_account: str | None = None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="seed_demo.py",
        description="Seed a local jackdemo* database for the demo video.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--reset", action="store_true", help="Drop and recreate the demo database first."
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="On a seeded database: add one new request nobody holds (the queue's New tab).",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="The history's seed.")
    parser.add_argument(
        "--days", type=int, default=DEFAULT_DAYS, help="Days of history before today."
    )
    parser.add_argument(
        "--password-file",
        type=Path,
        default=PASSWORD_FILE,
        help="Where the demo password is kept (created when missing; never committed).",
    )
    parser.add_argument(
        "--stand-in-stripe",
        action="store_true",
        help="Never call Stripe, even with a TEST key: every payment is a stand-in.",
    )
    args = parser.parse_args(argv)
    if args.reset and args.fresh:
        parser.error("--reset and --fresh do not go together")
    if not 1 <= args.days <= 365:
        parser.error("--days must be between 1 and 365")
    return args


def demo_password(path: Path, minimum_length: int) -> tuple[str, bool]:
    """The demo password from `path`, generated and written when the file is missing;
    (password, created)."""
    if path.exists():
        password = path.read_text(encoding="utf-8").strip()
        if len(password) < minimum_length:
            raise SeedError(f"the password in {path} is shorter than PASSWORD_MIN_LENGTH")
        return password, False
    # Easy to type on a phone keyboard, and long enough for the API's policy. A few million
    # values: enough for accounts that only ever exist on this machine.
    words = f"{secrets.choice(_WORDS)}-{secrets.choice(_WORDS)}"
    password = f"Jack-{words}-{secrets.randbelow(9000) + 1000}"
    password += "x" * max(0, minimum_length - len(password))
    path.write_text(password + "\n", encoding="utf-8")
    return password, True


def stripe_for(
    settings: Settings, *, stand_ins_only: bool, pro_account: str | None
) -> scenes.Stripe:
    """The stand-ins, and the TEST gateway when the settings hold a TEST key."""
    payments = StandInPayments()
    stand_ins = Gateways(payments, StandInTransfers(), StandInRefunds())
    if stand_ins_only or not stripe_test.has_test_key(settings):
        return scenes.Stripe(stand_ins, payments, StandInAccounts())
    return scenes.Stripe(
        stand_ins,
        payments,
        StandInAccounts(),
        test=stripe_test.test_gateways(settings),
        test_checkout=stripe_test.CardCheckout(settings),
        test_accounts=StripeExpressConnect.from_settings(settings) if pro_account else None,
    )


async def seed(settings: Settings, storage: Storage, stripe: scenes.Stripe, run: Run) -> list[str]:
    """Seeds the migrated demo database, or adds a fresh request, or (already seeded) changes
    nothing; the lines to print. The guard is checked first, whatever the caller did. The demo
    password is read, or made, only when accounts are about to be created: a database that is
    seeded already keeps the password it was seeded with."""
    guard.check_settings(settings)
    async with open_world(settings, storage, stripe.stand_ins) as world:
        marker = await scenes.read_marker(world)
        if run.fresh:
            if marker is None:
                raise SeedError("nothing is seeded yet: run without --fresh first")
            people = await scenes.people_of(world)
            code = await scenes.fresh_request(
                world,
                await flows.read_catalog(world),
                people,
                secrets.randbelow(len(people.customers)),
                scenes.fresh_name(datetime.now(UTC)),
            )
            return [f"New request {code}: in the queue's New tab until its first-contact time."]
        if marker is not None:
            lines = ["Already seeded: nothing changed. Use --reset to start over."]
            return lines + summary_lines(marker, run.password_file, None)
        if await scenes.has_accounts(world):
            raise SeedError("the database holds a partial seed: run with --reset")
        password, created = demo_password(run.password_file, settings.password_min_length)
        await seed_categories.seed(world.sessions)
        await seed_service_areas.seed(world.sessions)
        options = scenes.Options(
            seed=run.seed, days=run.days, password=password, pro_account=run.pro_account
        )
        summary = await scenes.build(world, options, stripe)
        return summary_lines(
            summary.marker(options), run.password_file, password if created else None
        )


def summary_lines(
    marker: dict[str, JsonValue], password_file: Path, new_password: str | None
) -> list[str]:
    """Accounts, codes and where to sign in. The password itself only when it was just made."""
    lines = [
        "",
        "Demo database ready.",
        f"  History: {marker.get('requests')} requests over {marker.get('days')} days "
        f"(seed {marker.get('seed')}); Stripe: {marker.get('stripe')}.",
        "  Panel (web /admin/login):",
        f"    admin  {cast.ADMIN_EMAIL}",
        f"    agent  {cast.AGENT_EMAIL}",
        "  App:",
        f"    customer  {cast.JAMIE.email}   (Jamie)",
        f"    pro       {cast.DAN.email}     (Dan, approved, payouts enabled)",
        f"    pro       {cast.MARIA.email}   (Maria, waiting for approval)",
        f"  Jamie's confirmed job: {marker.get('confirmed_code')}; her open problem: "
        f"{marker.get('dispute_code')}; her quotes to compare: {marker.get('quotes_code')}.",
    ]
    if password_file.exists():
        lines.append(f"  Password of every demo account: in {password_file}")
    else:
        lines.append(
            f"  The password file ({password_file}) is missing: the accounts keep the password "
            "they were seeded with. Run --reset to make a new one."
        )
    if new_password is not None:
        lines.append(f"    (new, shown once) {new_password}")
    notes = marker.get("notes")
    if isinstance(notes, list):
        lines += [f"  Note: {note}" for note in notes]
    return lines


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    settings = get_settings()
    try:
        url = guard.check_settings(settings)
        if asyncio.run(guard.recreate_database(url, drop=args.reset)):
            print(f"Database {url.database}: created.")
        guard.migrate(url)
        try:
            storage = S3Storage.from_settings(settings)
        except StorageNotConfiguredError:
            raise SeedError(
                "S3_* settings are missing: the demo needs a storage (documents, photos)"
            ) from None
        bucket = ensure_local_bucket(settings)
        if bucket is not BucketState.READY:
            raise SeedError(f"the storage's bucket is {bucket.value.replace('_', ' ')}")
        pro_account = os.environ.get(PRO_ACCOUNT_ENV) or None
        run = Run(
            seed=args.seed,
            days=args.days,
            fresh=args.fresh,
            password_file=INVOKED_FROM / args.password_file,
            pro_account=pro_account,
        )
        stripe = stripe_for(settings, stand_ins_only=args.stand_in_stripe, pro_account=pro_account)
        print("\n".join(asyncio.run(seed(settings, storage, stripe, run))))
    except (guard.DemoGuardError, SeedError) as refusal:
        print(f"seed_demo: {refusal}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
