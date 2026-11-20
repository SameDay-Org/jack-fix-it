"""refresh_tokens: an index of the live families, read by every authenticated request (#161)

Revision ID: 920fe99e6f1d
Revises: e9125c0828a1
Create Date: 2026-11-20 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "920fe99e6f1d"
down_revision: str | Sequence[str] | None = "e9125c0828a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "ix_refresh_tokens_live_family_id"


def upgrade() -> None:
    # An access token names its refresh family (`sid`), and every authenticated request checks
    # that the family still has a token not revoked (#161). A family keeps one row per rotation,
    # so ix_refresh_tokens_family_id would read every rotation the session ever made; this index
    # holds the live token of each family only. Expand only: a new index, nothing reads it
    # before this deploy, and the previous API keeps working while it is built.
    op.create_index(
        INDEX,
        "refresh_tokens",
        ["family_id"],
        unique=False,
        postgresql_where=sa.text("revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        INDEX, table_name="refresh_tokens", postgresql_where=sa.text("revoked_at IS NULL")
    )
