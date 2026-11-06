"""The operator of a staff script that changes money (#58, Vault round 1 B2; app.modules.audit).

scripts/resolve_payment_intent.py and scripts/resolve_payout_account.py take a required
--operator (the email of an active admin account) and an optional --reason. The operator is
resolved before anything else; anyone else is refused and nothing changes. Each applied action
writes one audit_log row naming the operator, in the same transaction as the change. Neither
the email nor the reason is ever printed or logged: only the operator's user id is logged.
"""

import argparse

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.service import AuditService
from app.modules.audit.types import REASON_MAX_LENGTH, Operator, OperatorNotAdminError

NOT_AN_ADMIN = (
    "--operator must be the email of an active admin account (scripts.create_staff_user); "
    "nothing changed."
)


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
