"""Give up a dispute's refund Stripe refused for good, so an admin can decide again (#434).

Run as `uv run python -m scripts.resolve_dispute_refund`.

When an admin's refund (or partial release) of a dispute cannot go through, the dispute's
decision stays fixed: a resolve with another decision answers 409 refund_already_attempted, and
the same one 502 (Stripe refuses it again, e.g. charge_disputed or charge_already_refunded),
409 refund_failed (Stripe failed or canceled the refund) or 409 dispute_needs_review (Stripe's
records cannot be matched with the row). Nobody is paid and the dispute stays open. After
looking at the payment's refunds in the Stripe dashboard (and canceling any that should not
stand), staff run this to abandon the refund; an admin then decides the dispute again from the
panel. A refund decided then takes a new row and key. Run by someone with database access and
the Stripe key; there is no HTTP endpoint.

- --dispute <dispute id> --abandon: refused (nothing changes) when the dispute is resolved or
  has no refund to abandon, while an attempt is under way, when Stripe holds the refund and has
  not failed or canceled it, or when Stripe's list of the payment's refunds shows one for this
  dispute that is not failed or canceled (app.modules.disputes.refund_repair).

--operator <admin email> is required: an active admin account, else refused before anything
else. The applied action writes one audit_log row (operator, the refund's state before and
after, the optional --reason) in the same transaction as the change (scripts/staff_operator.py,
app.modules.audit); a refusal or an unconfirmed run writes nothing.

Checks first, prints what it will do, then asks to confirm (--yes skips that,
non-interactive). Logs dispute_refund_abandoned with ids. Prints the dispute id only: never a
Stripe id, a name or a note.
"""

import argparse
import sys
import uuid
from collections.abc import Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import NoReturn, TextIO

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import create_engine, create_session_factory
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_refunds import StripeRefunds, StripeRefundsClient
from app.modules.audit.types import OperatorNotAdminError
from app.modules.disputes.errors import RefundRepairRefusedError
from app.modules.disputes.refund_repair import DisputeRefundRepair
from app.modules.payments.errors import PaymentsNotConfiguredError
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
        # argparse echoes unknown arguments; one of them could be a Stripe id or a note.
        if message.startswith("unrecognized arguments"):
            message = "unrecognized arguments (not shown: one could be a Stripe id)"
        super().error(message)


def _dispute_id(raw: str) -> uuid.UUID:
    """argparse prints a type error's message, not the value."""
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise argparse.ArgumentTypeError("not a dispute id (a UUID)") from None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = _Parser(
        prog="python -m scripts.resolve_dispute_refund",
        description="Abandon a dispute's refund Stripe refused for good (or failed, or cannot "
        "be matched), once Stripe shows none for the dispute that could still move money, so "
        "an admin can decide the dispute again.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--dispute", required=True, type=_dispute_id, metavar="DISPUTE_ID", help="The dispute id."
    )
    parser.add_argument(
        "--abandon",
        action="store_true",
        required=True,
        help="Give the dispute's refund up. Look at the payment's refunds in the Stripe "
        "dashboard first, and cancel any that should not stand.",
    )
    add_operator_arguments(parser)
    parser.add_argument("--yes", action="store_true", help="Non-interactive: skip the prompt.")
    return parser.parse_args(argv)


async def run(
    argv: Sequence[str],
    sessions: SessionFactory,
    settings: Settings,
    stripe: StripeRefunds | None,
    io: Io,
) -> int:
    """0 when the refund is abandoned, 1 on a refusal or a failure (printed). Raises SystemExit
    on bad flags."""
    args = parse_args(argv)
    dispute_id: uuid.UUID = args.dispute
    try:
        async with sessions() as session:
            # Before anything else: an unknown or non-admin operator changes nothing.
            try:
                operator = await operator_of(session, args)
            finally:
                await session.rollback()
            repair = DisputeRefundRepair(
                session, stripe, timedelta(minutes=settings.refund_stuck_pending_minutes)
            )
            await repair.abandon(dispute_id, operator, apply=False)
            print(
                f"Will abandon the refund of dispute {dispute_id}: Stripe shows none for it that "
                "could still move money. An admin can then decide the dispute again; a refund "
                "decided then is a new one.",
                file=io.out,
            )
            # Off the event loop: nothing is locked while the operator reads, and the apply
            # below reads Stripe and checks everything again.
            if not (args.yes or await confirm_off_loop(lambda: _confirmed(io))):
                raise RefundRepairRefusedError("Not confirmed; nothing changed.")
            await repair.abandon(dispute_id, operator, apply=True)
        print(f"The refund of dispute {dispute_id} is abandoned.", file=io.out)
        return 0
    except RefundRepairRefusedError as refusal:
        print(f"Error: {refusal}", file=io.out)
    except OperatorNotAdminError:
        # Before any change, or (demoted or suspended during the prompt) rolled back with it.
        print(f"Error: {NOT_AN_ADMIN}", file=io.out)
    except (PaymentsNotConfiguredError, StripeUnavailableError):
        print(
            "Error: Stripe is not configured (STRIPE_SECRET_KEY) or not reachable right now; "
            "nothing changed.",
            file=io.out,
        )
    except StripeRejectedError:
        print("Error: Stripe refused to list the payment's refunds; nothing changed.", file=io.out)
    except Exception as error:  # noqa: BLE001 - the boundary: a summary only (report_failure)
        report_failure(error, io.out, entity="dispute")
    return 1


def _confirmed(io: Io) -> bool:
    try:
        return io.prompt("Proceed? [y/N] ").strip().lower() in {"y", "yes"}
    except EOFError:  # no terminal to answer (a piped run): not confirmed
        return False


async def _main(argv: Sequence[str]) -> int:
    settings = get_settings()
    # JSON logs, and the Stripe SDK's logger (request URLs name Stripe ids) at WARNING.
    configure_logging(settings.log_level)
    stripe = (
        None if settings.stripe_secret_key is None else StripeRefundsClient.from_settings(settings)
    )
    engine = create_engine(settings)
    try:
        return await run(argv, create_session_factory(engine), settings, stripe, Io())
    finally:
        await engine.dispose()


def main() -> None:
    sys.exit(run_to_exit(lambda: _main(sys.argv[1:]), entity="dispute"))


if __name__ == "__main__":
    main()
