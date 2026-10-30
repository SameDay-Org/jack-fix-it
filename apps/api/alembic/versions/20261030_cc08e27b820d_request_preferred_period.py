"""request preferred period

Revision ID: cc08e27b820d
Revises: 59585005c91a
Create Date: 2026-10-30 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "cc08e27b820d"
down_revision: str | Sequence[str] | None = "59585005c91a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # When in the preferred date the customer would like the visit (#237). Nullable and not
    # backfilled: existing requests keep NULL, which reads as flexible. Only this column is
    # added; the status guard's triggers (#163) watch status and stay as they are.
    op.add_column("service_requests", sa.Column("preferred_period", sa.String(32), nullable=True))
    op.create_check_constraint(
        op.f("ck_service_requests_preferred_period"),
        "service_requests",
        "preferred_period IN ('morning', 'afternoon', 'evening', 'flexible')",
    )
    op.create_check_constraint(
        op.f("ck_service_requests_preferred_period_needs_date"),
        "service_requests",
        "preferred_period IS NULL OR preferred_date IS NOT NULL",
    )


def downgrade() -> None:
    # Destructive: the periods stored since the upgrade are lost. Dropping the column drops
    # both CHECKs with it.
    op.drop_column("service_requests", "preferred_period")
