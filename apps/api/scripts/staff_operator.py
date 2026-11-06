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
"""

import argparse
import logging
from typing import TextIO

from sqlalchemy.ext.asyncio import AsyncSession

from app.db_errors import summary_of
from app.modules.audit.service import AuditService
from app.modules.audit.types import REASON_MAX_LENGTH, Operator, OperatorNotAdminError

NOT_AN_ADMIN = (
    "--operator must be the email of an active admin account (scripts.create_staff_user); "
    "nothing changed."
)

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


def report_failure(error: Exception, out: TextIO, *, entity: str) -> None:
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
