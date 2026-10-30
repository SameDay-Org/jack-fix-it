"""Settle a pro's unresolved Stripe account create (#39).

Run as `uv run python -m scripts.resolve_payout_account`.

When a pro's onboarding link answers 409 payouts_needs_review, an earlier create of their
Express account never answered and the lookup after it could not settle it: no account, more
than one, or a listing that stopped early. The app creates nothing more until staff decide here,
after searching the Stripe dashboard for accounts whose metadata pro_profile_id is the profile
id. Run by someone with database access and the Stripe key; there is no HTTP endpoint.

- --pro <profile id> --adopt <acct_...>: stores that account as the profile's payout account.
  Refused when the profile already has one, or when Stripe does not show the account with
  metadata pro_profile_id naming this profile (another profile's, deleted, or not this
  platform's). With several accounts, adopt one; support deletes the others in the dashboard.
- --pro <profile id> --allow-new: clears the unresolved create, so the pro's next onboarding
  link creates a new account. Use it only after confirming in the Stripe dashboard that no
  account's metadata names this profile, and once Stripe's key retention (24 hours,
  STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS) has passed since the attempt (a
  younger attempt is refused: Stripe may still answer its key with an account).

Checks first, prints what it will do, then asks to confirm (--yes skips that,
non-interactive). Goes through PayoutsService, which logs payouts_account_resolved with the
profile id and the action. Prints the profile id only: never the account id or an email.
"""

import argparse
import asyncio
import re
import sys
import uuid
from collections.abc import Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Final, NoReturn, TextIO

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.integrations.stripe_connect import StripeConnect, StripeExpressConnect
from app.modules.payouts.errors import (
    PaymentsProviderError,
    PaymentsUnavailableError,
    PayoutsRecoveryRefusedError,
)
from app.modules.payouts.service import (
    STRIPE_KEY_RETENTION_HOURS,
    PayoutsConfig,
    PayoutsService,
)
from app.modules.pros.service import ProService
from app.observability import configure_logging

_ACCOUNT_ID: Final = re.compile(r"acct_[A-Za-z0-9]+")

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass
class Io:
    """The terminal, replaceable in tests."""

    prompt: Callable[[str], str] = input
    out: TextIO = field(default_factory=lambda: sys.stdout)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # argparse echoes unknown arguments; one of them could be an account id.
        if message.startswith("unrecognized arguments"):
            message = "unrecognized arguments (not shown: one could be an account id)"
        super().error(message)


def _profile_id(raw: str) -> uuid.UUID:
    """argparse prints a type error's message, not the value: it could be an account id or an
    email pasted into the wrong flag."""
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise argparse.ArgumentTypeError("not a profile id (a UUID)") from None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = _Parser(
        prog="python -m scripts.resolve_payout_account",
        description="Resolve a pro's unresolved Stripe account create (409 "
        "payouts_needs_review): adopt the account Stripe holds, or allow a new one.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--pro", required=True, type=_profile_id, metavar="PROFILE_ID", help="The pro profile id."
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument(
        "--adopt",
        metavar="ACCOUNT_ID",
        help="Store this Stripe account (acct_...) as the profile's: it must carry metadata "
        "pro_profile_id naming the profile, and the profile must have no account.",
    )
    action.add_argument(
        "--allow-new",
        action="store_true",
        help="Clear the unresolved create so the next onboarding link creates an account. Use "
        "only after confirming in the Stripe dashboard that no account carries this profile id "
        f"in its metadata, and at least {STRIPE_KEY_RETENTION_HOURS} hours after the attempt "
        "(younger is refused).",
    )
    parser.add_argument("--yes", action="store_true", help="Non-interactive: skip the prompt.")
    return parser.parse_args(argv)


async def run(
    argv: Sequence[str],
    sessions: SessionFactory,
    settings: Settings,
    stripe: StripeConnect | None,
    io: Io,
) -> int:
    """0 when the action is done, 1 on a refusal (printed). Raises SystemExit on bad flags."""
    args = parse_args(argv)
    pro_id: uuid.UUID = args.pro
    adopt: str | None = args.adopt
    try:
        if adopt is not None and not _ACCOUNT_ID.fullmatch(adopt):
            # Not repeated: the operator may have pasted something else.
            raise PayoutsRecoveryRefusedError("--adopt takes a Stripe account id (acct_...).")
        async with sessions() as session:
            payouts = PayoutsService(
                session, ProService(session), stripe, PayoutsConfig.from_settings(settings)
            )

            async def resolve(*, apply: bool) -> None:
                if adopt is not None:
                    await payouts.adopt_account(pro_id, adopt, apply=apply)
                else:
                    await payouts.allow_new_account(pro_id, apply=apply)

            await resolve(apply=False)
            if adopt is not None:
                print(
                    f"Will store the given account as the payout account of pro profile "
                    f"{pro_id}; Stripe shows its metadata naming this profile.",
                    file=io.out,
                )
            else:
                print(
                    f"Will clear the unresolved account create of pro profile {pro_id}: the "
                    "pro's next onboarding link creates a new Stripe account. Only if the "
                    "Stripe dashboard shows no account with this profile id in its metadata.",
                    file=io.out,
                )
            # Off the event loop: the row is not locked while the operator reads, and the
            # apply below checks everything again.
            if not (args.yes or await asyncio.to_thread(_confirmed, io)):
                raise PayoutsRecoveryRefusedError("Not confirmed; nothing changed.")
            await resolve(apply=True)
        done = "now has the given account" if adopt is not None else "can create a new account"
        print(f"Pro profile {pro_id} {done}.", file=io.out)
        return 0
    except PayoutsRecoveryRefusedError as refusal:
        print(f"Error: {refusal}", file=io.out)
    except PaymentsUnavailableError:
        print(
            "Error: Stripe is not configured (STRIPE_SECRET_KEY) or not reachable right now; "
            "nothing changed.",
            file=io.out,
        )
    except PaymentsProviderError:
        print(
            "Error: Stripe refused to read that account (deleted, or not this platform's); "
            "nothing changed.",
            file=io.out,
        )
    return 1


def _confirmed(io: Io) -> bool:
    try:
        return io.prompt("Proceed? [y/N] ").strip().lower() in {"y", "yes"}
    except EOFError:  # no terminal to answer (a piped run): not confirmed
        return False


async def _main(argv: Sequence[str]) -> int:
    settings = get_settings()
    # JSON logs, and the Stripe SDK's logger (request URLs name account ids) at WARNING.
    configure_logging(settings.log_level)
    stripe = (
        None if settings.stripe_secret_key is None else StripeExpressConnect.from_settings(settings)
    )
    engine = create_engine(settings)
    try:
        return await run(argv, create_session_factory(engine), settings, stripe, Io())
    finally:
        await engine.dispose()


def main() -> None:
    sys.exit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
