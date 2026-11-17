"""pro profile review

Revision ID: 6fedce2078df
Revises: 3f4b8f6a2cd8
Create Date: 2026-11-15 13:42:40.389180

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "6fedce2078df"
down_revision: str | Sequence[str] | None = "3f4b8f6a2cd8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Staff's decision on a pro profile (#41): why it was rejected, who decided last and when.
    # Expand-only: three nullable columns, not backfilled. The API still serving while Railway
    # migrates never names them, so its reads and writes of pro_profiles are unchanged.
    op.add_column("pro_profiles", sa.Column("rejection_reason", sa.Text(), nullable=True))
    op.add_column("pro_profiles", sa.Column("reviewed_by", sa.Uuid(), nullable=True))
    op.add_column(
        "pro_profiles", sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_foreign_key(
        op.f("fk_pro_profiles_reviewed_by_users"), "pro_profiles", "users", ["reviewed_by"], ["id"]
    )
    op.create_index(op.f("ix_pro_profiles_reviewed_by"), "pro_profiles", ["reviewed_by"])


def downgrade() -> None:
    # Destructive: the rejection reasons and who reviewed each profile are lost. The decisions
    # themselves stay in audit_log, and verification_status is untouched.
    op.drop_index(op.f("ix_pro_profiles_reviewed_by"), table_name="pro_profiles")
    op.drop_constraint(
        op.f("fk_pro_profiles_reviewed_by_users"), "pro_profiles", type_="foreignkey"
    )
    op.drop_column("pro_profiles", "reviewed_at")
    op.drop_column("pro_profiles", "reviewed_by")
    op.drop_column("pro_profiles", "rejection_reason")
