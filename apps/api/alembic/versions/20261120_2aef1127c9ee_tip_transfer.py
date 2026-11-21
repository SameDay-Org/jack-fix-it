"""tips: the tip's transfer to the pro, its reversal and its reversal check (#273 PR A2)

Revision ID: 2aef1127c9ee
Revises: 65e7971f089a
Create Date: 2026-11-20 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2aef1127c9ee"
down_revision: str | Sequence[str] | None = "65e7971f089a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "tips"
STATUS_CHECK = "ck_tips_tip_transfer_status"
MADE_HAS_ID = "ck_tips_transfer_made_has_id"
ONLY_SUCCEEDED = "ck_tips_transfer_only_when_succeeded"
STATUSES_BEFORE = "transfer_status IN ('none', 'pending', 'created', 'paid', 'failed', 'held')"
STATUSES = "transfer_status IN ('none', 'pending', 'created', 'paid', 'failed', 'held', 'reversed')"


def upgrade() -> None:
    # Expand only: two nullable columns, one more allowed status, and two CHECKs every existing
    # row meets (no tip has a transfer yet: all are 'none'), so the previous API and worker
    # (serving during Railway's pre-deploy step) keep writing tips without knowing any of it.
    op.add_column(
        TABLE,
        sa.Column("transfer_reversal_check_tried_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        TABLE,
        sa.Column("transfer_reversal_checked_at", sa.DateTime(timezone=True), nullable=True),
    )
    # op.f: the names are final, so the naming convention adds no second prefix.
    op.drop_constraint(op.f(STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(op.f(STATUS_CHECK), TABLE, STATUSES)
    op.create_check_constraint(
        op.f(MADE_HAS_ID),
        TABLE,
        "transfer_status NOT IN ('created', 'reversed') OR stripe_transfer_id IS NOT NULL",
    )
    op.create_check_constraint(
        op.f(ONLY_SUCCEEDED), TABLE, "transfer_status = 'none' OR status = 'succeeded'"
    )


def downgrade() -> None:
    # A reversed tip transfer has no status before this revision: it is left held for staff with
    # the reason in its error code (its Stripe id stays). The reversal checks' times are dropped
    # (a later upgrade reads no transfer again until the sweep's next check).
    op.drop_constraint(op.f(ONLY_SUCCEEDED), TABLE, type_="check")
    op.drop_constraint(op.f(MADE_HAS_ID), TABLE, type_="check")
    op.execute(
        "UPDATE tips SET transfer_status = 'held', transfer_last_error_code = 'transfer_reversed'"
        " WHERE transfer_status = 'reversed'"
    )
    op.drop_constraint(op.f(STATUS_CHECK), TABLE, type_="check")
    op.create_check_constraint(op.f(STATUS_CHECK), TABLE, STATUSES_BEFORE)
    op.drop_column(TABLE, "transfer_reversal_checked_at")
    op.drop_column(TABLE, "transfer_reversal_check_tried_at")
