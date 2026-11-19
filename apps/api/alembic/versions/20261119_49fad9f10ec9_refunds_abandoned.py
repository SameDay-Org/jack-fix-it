"""refunds: a dispute's refund staff abandoned once Stripe shows none (#434); transfers: the
initiation boundary and the reversal flag (#450 round 4)

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
TRANSFERS = "transfers"
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
    # Whether the last attempt's failure was Stripe's definitive answer to the create (a 4xx
    # error with a Stripe code: the same key gets the same refusal back, so that create can
    # never make a refund): only such a refund may be abandoned (#450 round 1). The previous
    # code never writes it; false by default.
    op.add_column(
        TABLE,
        sa.Column("last_error_definitive", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    # When a signed refund event showed a refund Stripe made, or still holds, for the dispute
    # while this row was abandoned or failed (#450 round 2): the job's payout stays held until
    # staff reconcile it. NULL for every existing row; the previous code never reads or writes it.
    op.add_column(
        TABLE, sa.Column("late_refund_seen_at", sa.DateTime(timezone=True), nullable=True)
    )
    # One refund per dispute that is not abandoned: the one the dispute's decision carries out.
    op.create_index(
        op.f(CURRENT_INDEX),
        TABLE,
        ["dispute_id"],
        unique=True,
        postgresql_where=sa.text("dispute_id IS NOT NULL AND status <> 'abandoned'"),
    )
    # The transfer's initiation boundary (#450 round 4): when the current attempt passed its
    # last hold check, under the job's lock, right before the transfer create (NULL: not yet);
    # and when a late refund found a transfer that may already be issued (staff reverse it by
    # hand, docs/stripe-money.md; never cleared by the code). NULL for every existing row; the
    # previous code never reads or writes them.
    op.add_column(
        TRANSFERS, sa.Column("create_started_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        TRANSFERS, sa.Column("needs_reversal_at", sa.DateTime(timezone=True), nullable=True)
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
    # Dropping a reconciliation hold would release the payout it holds.
    held = bind.execute(
        sa.text("SELECT count(*) FROM refunds WHERE late_refund_seen_at IS NOT NULL")
    ).scalar_one()
    if held:
        raise RuntimeError(
            f"{held} refund rows hold a payout for reconciliation: reconcile and clear them "
            "(docs/stripe-money.md) before downgrading."
        )
    # Dropping the marker would lose the record of a payout staff must reverse.
    flagged = bind.execute(
        sa.text("SELECT count(*) FROM transfers WHERE needs_reversal_at IS NOT NULL")
    ).scalar_one()
    if flagged:
        raise RuntimeError(
            f"{flagged} transfers are flagged for reversal: reverse them in Stripe and clear the "
            "flag (docs/stripe-money.md) before downgrading."
        )
    op.drop_column(TRANSFERS, "needs_reversal_at")
    op.drop_column(TRANSFERS, "create_started_at")
    op.drop_index(op.f(CURRENT_INDEX), table_name=TABLE)
    op.drop_column(TABLE, "late_refund_seen_at")
    op.drop_column(TABLE, "last_error_definitive")
    op.drop_constraint(op.f(STRIPE_STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(STRIPE_STATUS_CHECK), TABLE, "(status = 'created') = (stripe_status IS NOT NULL)"
    )
    op.drop_constraint(op.f(STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(STATUS_CHECK), TABLE, "status IN ('pending', 'created', 'failed')"
    )
