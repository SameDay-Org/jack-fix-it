"""audit_log (#58, Vault round 1 B2): append-only rows written by AuditService.record, and the
staff operator lookup. The scripts' own audit tests are in test_resolve_payment_intent.py and
test_resolve_payout_account.py."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    AuditAction,
    AuditEntity,
    AuditEntityType,
    AuditValue,
    Operator,
    OperatorNotAdminError,
)
from app.modules.users.types import UserRole, UserStatus
from tests.audit_helpers import OPERATOR_DOMAIN, OPERATOR_EMAIL, AuditRow, audit_rows, make_staff

ENTITY = AuditEntity(AuditEntityType.PAYMENT, uuid.UUID("3f0c6a2e-1111-4222-8333-444455556666"))
BEFORE: dict[str, AuditValue] = {"payment_intent_requested_at": "2026-11-05T10:00:00+00:00"}
AFTER: dict[str, AuditValue] = {"payment_intent_requested_at": None}


async def test_record_adds_one_row_in_the_callers_transaction(db_session: AsyncSession) -> None:
    admin = await make_staff(db_session)

    await AuditService(db_session).record(
        Operator(admin, "Ticket 1"), AuditAction.PAYMENT_INTENT_ALLOW_NEW, ENTITY, BEFORE, AFTER
    )

    assert await audit_rows(db_session) == [
        AuditRow(admin, "payment.allow_new_intent", "payment", ENTITY.id, BEFORE, AFTER, "Ticket 1")
    ]


@pytest.mark.parametrize("who", ["unknown", "agent", "suspended admin"])
async def test_record_refuses_an_operator_who_is_no_longer_an_active_admin(
    db_session: AsyncSession, who: str
) -> None:
    """Checked again at the write: an admin demoted or suspended since the script's check."""
    if who == "unknown":
        user_id = uuid.uuid4()
    elif who == "agent":
        user_id = await make_staff(db_session, role=UserRole.AGENT)
    else:
        user_id = await make_staff(db_session, status=UserStatus.SUSPENDED)

    with pytest.raises(OperatorNotAdminError):
        await AuditService(db_session).record(
            Operator(user_id), AuditAction.PAYMENT_INTENT_ALLOW_NEW, ENTITY, BEFORE, AFTER
        )

    assert await audit_rows(db_session) == []


@pytest.mark.parametrize(
    "statement",
    ["UPDATE audit_log SET reason = 'edited'", "DELETE FROM audit_log", "TRUNCATE audit_log"],
)
async def test_rows_are_append_only(db_session: AsyncSession, statement: str) -> None:
    admin = await make_staff(db_session)
    await AuditService(db_session).record(
        Operator(admin),
        AuditAction.PAYOUT_ACCOUNT_ADOPT,
        AuditEntity(AuditEntityType.PRO_PROFILE, uuid.uuid4()),
        {"stripe_account_id": None},
        {"stripe_account_id": "acct_auditfixture"},
    )
    before = await audit_rows(db_session)

    with pytest.raises(DBAPIError, match="audit_log is append-only") as error:
        async with db_session.begin_nested():
            await db_session.execute(text(statement))

    assert getattr(error.value.orig, "sqlstate", None) == "42501"
    assert await audit_rows(db_session) == before


async def test_admin_operator_is_an_active_admin_only(db_session: AsyncSession) -> None:
    admin = await make_staff(db_session)
    await make_staff(db_session, email=f"agent{OPERATOR_DOMAIN}", role=UserRole.AGENT)
    await make_staff(db_session, email=f"off{OPERATOR_DOMAIN}", status=UserStatus.SUSPENDED)
    audit = AuditService(db_session)

    assert await audit.admin_operator(f"  {OPERATOR_EMAIL.upper()}") == admin
    for other in ("agent", "off", "nobody"):
        assert await audit.admin_operator(f"{other}{OPERATOR_DOMAIN}") is None
