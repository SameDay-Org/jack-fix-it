"""Settle a payment's unresolved Stripe PaymentIntent create (#58).

Run as `uv run python -m scripts.resolve_payment_intent`.

When a customer's payment call answers 409 payment_needs_review, an earlier PaymentIntent create
for that payment never answered, long enough ago that Stripe may have forgotten its idempotency
key, and the search after it could not settle it: no intent, more than one, one that does not
match the payment, or a search that stopped early. The app creates nothing more until staff
decide here, after searching the Stripe dashboard for PaymentIntents whose metadata payment_id
is the payment id. Run by someone with database access and the Stripe key; there is no HTTP
endpoint.

- --payment <payment id> --adopt <pi_...>: stores that PaymentIntent as the payment's. Refused
  when the payment already has one, or when Stripe does not show the intent with metadata
  payment_id naming this payment and the payment's amount, currency and customer (another
  payment's, or not this platform's). With several intents, adopt one; support cancels the
  others in the dashboard.
- --payment <payment id> --allow-new: clears the unresolved create, so the customer's next
  payment call creates a PaymentIntent. Use it only after confirming in the Stripe dashboard
  that no PaymentIntent's metadata names this payment, and once Stripe's key retention (24
  hours, STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS) has passed since the attempt (a younger
  attempt is refused: Stripe may still answer its key with an intent).

Checks first, prints what it will do, then asks to confirm (--yes skips that,
non-interactive). Goes through PaymentService, which logs payment_intent_resolved with the
payment's ids and the action. Prints the payment id only: never a PaymentIntent id, a customer
id or a secret.
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
from app.integrations.stripe_payments import StripePayments, StripePaymentsClient
from app.modules.payments.errors import PaymentRecoveryRefusedError, PaymentsNotConfiguredError
from app.modules.payments.service import (
    STRIPE_KEY_RETENTION_HOURS,
    PaymentsConfig,
    PaymentService,
)
from app.modules.payouts.errors import PaymentsProviderError, PaymentsUnavailableError
from app.observability import configure_logging

_INTENT_ID: Final = re.compile(r"pi_[A-Za-z0-9]+")

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


def _payment_id(raw: str) -> uuid.UUID:
    """argparse prints a type error's message, not the value: it could be a PaymentIntent id or
    a client secret pasted into the wrong flag."""
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise argparse.ArgumentTypeError("not a payment id (a UUID)") from None


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = _Parser(
        prog="python -m scripts.resolve_payment_intent",
        description="Resolve a payment's unresolved PaymentIntent create (409 "
        "payment_needs_review): adopt the intent Stripe holds, or allow a new one.",
        allow_abbrev=False,
    )
    parser.add_argument(
        "--payment", required=True, type=_payment_id, metavar="PAYMENT_ID", help="The payment id."
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument(
        "--adopt",
        metavar="PAYMENT_INTENT_ID",
        help="Store this PaymentIntent (pi_...) as the payment's: its metadata payment_id must "
        "name the payment, its amount, currency and customer must be the payment's, and the "
        "payment must have no intent.",
    )
    action.add_argument(
        "--allow-new",
        action="store_true",
        help="Clear the unresolved create so the next payment call creates an intent. Use only "
        "after confirming in the Stripe dashboard that no PaymentIntent carries this payment id "
        f"in its metadata, and at least {STRIPE_KEY_RETENTION_HOURS} hours after the attempt "
        "(younger is refused).",
    )
    parser.add_argument("--yes", action="store_true", help="Non-interactive: skip the prompt.")
    return parser.parse_args(argv)


async def run(
    argv: Sequence[str],
    sessions: SessionFactory,
    settings: Settings,
    stripe: StripePayments | None,
    io: Io,
) -> int:
    """0 when the action is done, 1 on a refusal (printed). Raises SystemExit on bad flags."""
    args = parse_args(argv)
    payment_id: uuid.UUID = args.payment
    adopt: str | None = args.adopt
    try:
        if adopt is not None and not _INTENT_ID.fullmatch(adopt):
            # Not repeated: the operator may have pasted something else, such as a secret.
            raise PaymentRecoveryRefusedError("--adopt takes a PaymentIntent id (pi_...).")
        async with sessions() as session:
            payments = PaymentService(session, stripe, PaymentsConfig.from_settings(settings))

            async def resolve(*, apply: bool) -> None:
                if adopt is not None:
                    await payments.adopt_intent(payment_id, adopt, apply=apply)
                else:
                    await payments.allow_new_intent(payment_id, apply=apply)

            await resolve(apply=False)
            if adopt is not None:
                print(
                    f"Will store the given PaymentIntent as the intent of payment {payment_id}; "
                    "Stripe shows its metadata naming this payment, with its amount, currency "
                    "and customer.",
                    file=io.out,
                )
            else:
                print(
                    f"Will clear the unresolved PaymentIntent create of payment {payment_id}: "
                    "the customer's next payment call creates a new PaymentIntent. Only if the "
                    "Stripe dashboard shows no PaymentIntent with this payment id in its "
                    "metadata.",
                    file=io.out,
                )
            # Off the event loop: the row is not locked while the operator reads, and the
            # apply below checks everything again.
            if not (args.yes or await asyncio.to_thread(_confirmed, io)):
                raise PaymentRecoveryRefusedError("Not confirmed; nothing changed.")
            await resolve(apply=True)
        done = "now has the given PaymentIntent" if adopt is not None else "can create a new one"
        print(f"Payment {payment_id} {done}.", file=io.out)
        return 0
    except PaymentRecoveryRefusedError as refusal:
        print(f"Error: {refusal}", file=io.out)
    except (PaymentsNotConfiguredError, PaymentsUnavailableError):
        print(
            "Error: Stripe is not configured (STRIPE_SECRET_KEY) or not reachable right now; "
            "nothing changed.",
            file=io.out,
        )
    except PaymentsProviderError:
        print(
            "Error: Stripe refused to read that PaymentIntent (not found, or not this "
            "platform's); nothing changed.",
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
    # JSON logs, and the Stripe SDK's logger (request URLs name PaymentIntent ids) at WARNING.
    configure_logging(settings.log_level)
    stripe = (
        None if settings.stripe_secret_key is None else StripePaymentsClient.from_settings(settings)
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
