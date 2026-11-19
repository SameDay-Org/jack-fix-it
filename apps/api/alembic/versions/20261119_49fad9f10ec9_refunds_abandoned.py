"""refunds: a dispute's refund staff abandoned once Stripe shows none (#434)

Revision ID: 49fad9f10ec9
Revises: e1bd2d8588e7
Create Date: 2026-11-19 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "49fad9f10ec9"
down_revision: str | Sequence[str] | None = "e1bd2d8588e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "refunds"
# Final names (op.f): the metadata's naming convention must not prefix them again.
STATUS_CHECK = "ck_refunds_refund_status"
STRIPE_STATUS_CHECK = "ck_refunds_created_has_stripe_status"
CURRENT_INDEX = "uq_refunds_current_dispute_refund"


def upgrade() -> None:
    # A refund Stripe refused for good (or failed, or never made) that staff abandoned with
    # scripts/resolve_dispute_refund.py, so an admin can decide the dispute again (#434).
    # Expand only: Railway runs this in the pre-deploy step while the previous API and worker
    # keep serving. They write pending, created and failed only, which both new CHECKs still
    # accept, and they hold one refund per dispute, which the new unique index requires.
    op.drop_constraint(op.f(STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(STATUS_CHECK), TABLE, "status IN ('pending', 'created', 'failed', 'abandoned')"
    )
    # Stripe's status is stored with its refund: a created row has one, a pending or failed row
    # none; an abandoned row keeps whatever it had.
    op.drop_constraint(op.f(STRIPE_STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(STRIPE_STATUS_CHECK),
        TABLE,
        "status = 'abandoned' OR (status = 'created') = (stripe_status IS NOT NULL)",
    )
    # One refund per dispute that is not abandoned: the one the dispute's decision carries out.
    op.create_index(
        op.f(CURRENT_INDEX),
        TABLE,
        ["dispute_id"],
        unique=True,
        postgresql_where=sa.text("dispute_id IS NOT NULL AND status <> 'abandoned'"),
    )


def downgrade() -> None:
    # The previous schema has no abandoned refund; turning one back into an attempt would make
    # its dispute's decision fixed again behind staff's back. Refused while any exists.
    bind = op.get_bind()
    abandoned = bind.execute(
        sa.text("SELECT count(*) FROM refunds WHERE status = 'abandoned'")
    ).scalar_one()
    if abandoned:
        raise RuntimeError(
            f"{abandoned} abandoned refund rows exist: the previous schema cannot hold them. "
            "Take a backup and settle them by hand before downgrading."
        )
    op.drop_index(op.f(CURRENT_INDEX), table_name=TABLE)
    op.drop_constraint(op.f(STRIPE_STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(STRIPE_STATUS_CHECK), TABLE, "(status = 'created') = (stripe_status IS NOT NULL)"
    )
    op.drop_constraint(op.f(STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(STATUS_CHECK), TABLE, "status IN ('pending', 'created', 'failed')"
    )
