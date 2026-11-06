"""The operator of a staff script that changes money (#58, Vault round 1 B2; app.modules.audit).

scripts/resolve_payment_intent.py and scripts/resolve_payout_account.py take a required
--operator (the email of an active admin account) and an optional --reason. The operator is
resolved before anything else; anyone else is refused and nothing changes. Each applied action
writes one audit_log row naming the operator, in the same transaction as the change. Neither
the email nor the reason is ever printed or logged: only the operator's user id is logged.

Any other failure (a database error, such as the audit insert refused, or anything unexpected)
stops at the script's boundary (Vault round 2 B3): `report_failure` prints and logs a summary
only, from app.db_errors, and the script exits 1. A database error's text holds the SQL and its
parameters (the reason, Stripe ids), and any exception's message can quote a value.

`run_to_exit` is the process boundary around the whole run, the rollback and the engine's
disposal included (Gatekeeper round 4 B3): Ctrl-C at any point prints `report_interrupted`'s
one line and exits 130, and any other escaping BaseException but SystemExit (argparse's exits)
goes through `report_failure`. No exception is left to Python's traceback, which prints the
chained database error with PostgreSQL's row detail (hide_parameters does not hide that).
"""

import argparse
import asyncio
import contextlib
import logging
import signal
import sys
import threading
from collections.abc import Callable, Coroutine
from typing import Any, Final, TextIO

from sqlalchemy.ext.asyncio import AsyncSession

from app.db_errors import summary_of
from app.modules.audit.service import AuditService
from app.modules.audit.types import REASON_MAX_LENGTH, Operator, OperatorNotAdminError

NOT_AN_ADMIN = (
    "--operator must be the email of an active admin account (scripts.create_staff_user); "
    "nothing changed."
)

INTERRUPTED: Final = 130  # the shell's 128 + SIGINT

logger = logging.getLogger(__name__)


def _reason(raw: str) -> str | None:
    """argparse prints a type error's message, not the value."""
    reason = raw.strip()
    if len(reason) > REASON_MAX_LENGTH:
        raise argparse.ArgumentTypeError(f"at most {REASON_MAX_LENGTH} characters")
    return reason or None


def add_operator_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--operator",
        required=True,
        metavar="ADMIN_EMAIL",
        help="The email of the admin running this; recorded in audit_log by user id.",
    )
    parser.add_argument(
        "--reason",
        type=_reason,
        help="Why, recorded in audit_log (optional): a ticket or a short note, with no names, "
        "emails, phones or addresses.",
    )


async def operator_of(session: AsyncSession, args: argparse.Namespace) -> Operator:
    """The audited operator named by --operator and --reason; OperatorNotAdminError unless an
    active admin. Checked again when the action is recorded."""
    operator: str = args.operator
    user_id = await AuditService(session).admin_operator(operator)
    if user_id is None:
        raise OperatorNotAdminError
    reason: str | None = args.reason
    return Operator(user_id=user_id, reason=reason)


def report_failure(error: BaseException, out: TextIO, *, entity: str) -> None:
    """Prints and logs (staff_script_failed) what may be shown of an unexpected failure: the
    summary of a database error (its class, SQLSTATE, constraint and table names), else the
    error's class alone. Never its message, statement, parameters or traceback. The change and
    its audit row commit together or not at all, and a failure while committing leaves no way
    to tell which: the operator checks the `entity` before running again."""
    summary = summary_of(error)
    fields = summary.as_extra() if summary is not None else {"error_class": type(error).__name__}
    logger.error("staff_script_failed", extra={"entity": entity, **fields})
    detail = " ".join(f"{name}={value}" for name, value in fields.items())
    print(
        f"Error: the run failed ({detail}). The change and its audit row are saved together or "
        f"not at all: check the {entity} before running this again.",
        file=out,
    )


def report_interrupted(out: TextIO, *, entity: str) -> None:
    """Prints and logs (staff_script_interrupted) that the run was interrupted, with no
    exception at all: the one pending may chain a database error. The outcome is not known
    (Ctrl-C may land while committing), so the operator checks the `entity`."""
    logger.warning("staff_script_interrupted", extra={"entity": entity})
    print(
        "Interrupted: the run stopped before it finished. The change and its audit row are "
        f"saved together or not at all: check the {entity} before running this again.",
        file=out,
    )


def run_to_exit(
    main: Callable[[], Coroutine[Any, Any, int]], *, entity: str, out: TextIO | None = None
) -> int:
    """Runs a staff script's `main` to its exit code: 130 when interrupted, 1 when anything
    but SystemExit escapes it, each printed as one safe line. asyncio.run turns Ctrl-C into a
    cancellation of `main`, so the session's rollback and the engine's disposal still run; an
    open transaction left by a second Ctrl-C ends with the process and its connections."""
    stream = sys.stdout if out is None else out
    escaped: BaseException | None = None
    try:
        return asyncio.run(main())
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001 - the boundary: a summary only, below
        escaped = error
    # Outside the handler, so nothing raised from here chains the escaped error.
    if isinstance(escaped, KeyboardInterrupt):
        # A further Ctrl-C would cut the line short with a traceback of its own; ignored only
        # while it prints, so the process can still be interrupted afterwards.
        previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            report_interrupted(stream, entity=entity)
        finally:
            signal.signal(signal.SIGINT, previous)
        return INTERRUPTED
    report_failure(escaped, stream, entity=entity)
    return 1


async def confirm_off_loop(ask: Callable[[], bool]) -> bool:
    """The operator's answer to `ask` (the confirmation prompt), read on a daemon thread off
    the event loop: no row is locked while the operator reads. Not asyncio.to_thread: after
    Ctrl-C at the prompt, asyncio.run's shutdown and then the interpreter's exit would wait
    for that executor thread, still blocked in input(), and the run would hang there."""
    loop = asyncio.get_running_loop()
    answer: asyncio.Future[bool] = loop.create_future()

    def settle(result: bool | None, error: BaseException | None) -> None:
        if answer.done():  # cancelled by Ctrl-C
            return
        if error is not None:
            answer.set_exception(error)
        else:
            answer.set_result(bool(result))

    def read() -> None:
        result: bool | None = None
        error: BaseException | None = None
        try:
            result = ask()
        except BaseException as raised:  # noqa: BLE001 - handed to the awaiting run
            error = raised
        # RuntimeError: the run already ended (interrupted) and closed its loop.
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(settle, result, error)

    threading.Thread(target=read, name="staff-confirm", daemon=True).start()
    return await answer
