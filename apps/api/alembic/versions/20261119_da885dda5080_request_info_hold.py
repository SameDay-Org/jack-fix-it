"""service_requests.info_requested_at: the BDC's hold while it waits for the customer (#82)

Expand-only: one nullable column, no default, no backfill. The API from before this revision
never reads or writes it, so it keeps serving during the pre-deploy; the re-dispatch (#478)
leaves requests with it set alone.

Revision ID: da885dda5080
Revises: e9125c0828a1
Create Date: 2026-11-19 12:38:59.977303

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "da885dda5080"
down_revision: str | Sequence[str] | None = "e9125c0828a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "service_requests",
        sa.Column("info_requested_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    # Drops the holds: requests waiting for the customer become sweepable again.
    op.drop_column("service_requests", "info_requested_at")
