"""quote approach

Revision ID: 7675e571942e
Revises: d0bc3353ce35
Create Date: 2026-10-29 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7675e571942e"
down_revision: str | Sequence[str] | None = "d0bc3353ce35"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The pro's optional "How I'll do the job" note (#246), apart from the scope. Nullable, so
    # existing quotes need no backfill. The take rate is not seeded: the code default (1500)
    # applies until an admin stores a row.
    op.add_column("quotes", sa.Column("approach", sa.Text(), nullable=True))


def downgrade() -> None:
    # Destructive: the notes written since the upgrade are lost.
    op.drop_column("quotes", "approach")
