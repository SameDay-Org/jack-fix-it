"""stripe account requested at

Revision ID: ff6a71f4a729
Revises: cc08e27b820d
Create Date: 2026-10-30 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "ff6a71f4a729"
down_revision: str | Sequence[str] | None = "cc08e27b820d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # When the profile's first Stripe Express account create was attempted (#39), committed
    # before the call. Nullable and not backfilled: a profile that never asked has NULL.
    op.add_column(
        "pro_profiles",
        sa.Column("stripe_account_requested_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    # Destructive: the attempt times are lost, so a profile whose create answer was lost
    # retries with its key again instead of looking the account up first.
    op.drop_column("pro_profiles", "stripe_account_requested_at")
