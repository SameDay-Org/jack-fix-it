"""support ticket idempotency key

Revision ID: 3f4b8f6a2cd8
Revises: 418015ab4aca
Create Date: 2026-11-13 20:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3f4b8f6a2cd8"
down_revision: str | Sequence[str] | None = "418015ab4aca"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "uq_support_tickets_user_id_idempotency_key"


def upgrade() -> None:
    # The create's Idempotency-Key and the SHA-256 of its body (#380). Expand-only: both
    # columns are nullable and not backfilled, and the unique index covers only rows with a
    # key. The API still serving while Railway migrates never writes a key, so its inserts can
    # never break the index, and its ORM statements name only the columns it knows.
    op.add_column("support_tickets", sa.Column("idempotency_key", sa.Uuid(), nullable=True))
    op.add_column(
        "support_tickets", sa.Column("idempotency_fingerprint", sa.String(64), nullable=True)
    )
    op.create_index(
        INDEX,
        "support_tickets",
        ["user_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    # Destructive: the keys and fingerprints stored since the upgrade are lost, so a retry of
    # a ticket written before the downgrade is no longer recognized.
    op.drop_index(INDEX, table_name="support_tickets")
    op.drop_column("support_tickets", "idempotency_fingerprint")
    op.drop_column("support_tickets", "idempotency_key")
