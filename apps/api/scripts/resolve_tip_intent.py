"""Clear a tip's lost PaymentIntent create that Stripe never made (#273, #510 self-review).

Run as `uv run python -m scripts.resolve_tip_intent`.

When a customer's tip choice answers 409 tip_needs_review, the PaymentIntent create of the
tip's current attempt never answered, long enough ago that Stripe may have forgotten its key,
and Stripe's search on the tip's metadata found no intent of that attempt (tip_intent_unresolved,
an ERROR with the tip's ids). The app creates nothing more and the customer can choose nothing
(not even "No tip") until staff decide here, after searching the Stripe dashboard for
PaymentIntents whose metadata tip_id is the tip id. Run by someone with database access; there
is no HTTP endpoint.

- --tip <tip id> --allow-new: clears the unresolved create, so the customer's next choice
  creates a PaymentIntent (or chooses "No tip" or another amount). Use it only after confirming
  in the Stripe dashboard that no PaymentIntent's metadata names this tip, and once Stripe's key
  retention (24 hours) has passed since the attempt (a younger attempt is refused: Stripe may
  still answer its key with an intent). An intent the dashboard does show is the app's to find:
  its payment_intent.* event adopts it (tips/webhooks.py).

--operator <admin email> is required: an active admin account, else refused before anything
else. The applied action writes one audit_log row (operator, action, before and after, the
optional --reason) in the same transaction as the change; a refusal or an unconfirmed run writes
nothing. Checks first, prints what it will do, then asks to confirm (--yes skips that,
non-interactive). Prints the tip id only: never a PaymentIntent id, a customer id or a secret.
"""

import argparse
import sys
import uuid
from collections.abc import Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import NoReturn, TextIO

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.modules.audit.types import OperatorNotAdminError
from app.modules.payments.service import STRIPE_KEY_RETENTION_HOURS
from app.modules.tips.errors import TipRecoveryRefusedError
from app.modules.tips.service import TipConfig, TipService
from app.observability import configure_logging
from scripts.staff_operator import (
    NOT_AN_ADMIN,
    add_operator_arguments,
    confirm_off_loop,
    operator_of,
    report_failure,
    run_to_exit,
)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass
class Io:
    """The terminal, replaceable in tests."""

    prompt: Callable[[str], str] = input
    out: TextIO = field(default_factory=lambda: sys.stdout)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        # argparse echoes unknown arguments; one of them could be a PaymentIntent id.
        if message.startswith("unrecognized arguments"):
            message = "unrecognized arguments (not shown: one could be a PaymentIntent id)"
        super().error(message)


def _tip_id(raw: str) -> uuid.UUID:
    """argparse prints a type error's message, not the value: it could be a PaymentIntent id
    pasted into the wrong flag."""
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise argparse.ArgumentTypeError("not a tip id (a UUID)") from None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = _Parser(
        prog="python -m scripts.resolve_tip_intent",
        description="Clear a tip's lost PaymentIntent create (409 tip_needs_review) that Stripe "
        "never made.",
        allow_abbrev=False,
    )
    parser.add_argument("--tip", required=True, type=_tip_id, metavar="TIP_ID", help="The tip id.")
    parser.add_argument(
        "--allow-new",
        required=True,
        action="store_true",
        help="Clear the unresolved create so the customer's next choice goes on. Use only after "
        "confirming in the Stripe dashboard that no PaymentIntent carries this tip id in its "
        f"metadata, and at least {STRIPE_KEY_RETENTION_HOURS} hours after the attempt (younger "
        "is refused).",
    )
    add_operator_arguments(parser)
    parser.add_argument("--yes", action="store_true", help="Non-interactive: skip the prompt.")
    return parser.parse_args(argv)


async def run(argv: Sequence[str], sessions: SessionFactory, settings: Settings, io: Io) -> int:
    """0 when the action is done, 1 on a refusal or a failure (printed). Raises SystemExit on
    bad flags."""
    args = parse_args(argv)
    tip_id: uuid.UUID = args.tip
    try:
        async with sessions() as session:
            # Before anything else: an unknown or non-admin operator changes nothing.
            try:
                operator = await operator_of(session, args)
            finally:
                await session.rollback()
            # No Stripe call is made: the dashboard search is the operator's.
            tips = TipService(session, None, TipConfig.from_settings(settings))
            await tips.allow_new_attempt(tip_id, operator, apply=False)
            print(
                f"Will clear the unresolved PaymentIntent create of tip {tip_id}: the customer's "
                "next choice goes on. Only if the Stripe dashboard shows no PaymentIntent with "
                "this tip id in its metadata.",
                file=io.out,
            )
            # Off the event loop: the row is not locked while the operator reads, and the
            # apply below checks everything again.
            if not (args.yes or await confirm_off_loop(lambda: _confirmed(io))):
                raise TipRecoveryRefusedError("Not confirmed; nothing changed.")
            await tips.allow_new_attempt(tip_id, operator, apply=True)
        print(f"Tip {tip_id} can take a new choice.", file=io.out)
        return 0
    except TipRecoveryRefusedError as refusal:
        print(f"Error: {refusal}", file=io.out)
    except OperatorNotAdminError:
        # Before any change, or (demoted or suspended during the prompt) rolled back with it.
        print(f"Error: {NOT_AN_ADMIN}", file=io.out)
    except Exception as error:  # noqa: BLE001 - the boundary: a summary only (report_failure)
        report_failure(error, io.out, entity="tip")
    return 1


def _confirmed(io: Io) -> bool:
    try:
        return io.prompt("Proceed? [y/N] ").strip().lower() in {"y", "yes"}
    except EOFError:  # no terminal to answer (a piped run): not confirmed
        return False


async def _main(argv: Sequence[str]) -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings)
    try:
        return await run(argv, create_session_factory(engine), settings, Io())
    finally:
        await engine.dispose()


def main() -> None:
    sys.exit(run_to_exit(lambda: _main(sys.argv[1:]), entity="tip"))


if __name__ == "__main__":
    main()
