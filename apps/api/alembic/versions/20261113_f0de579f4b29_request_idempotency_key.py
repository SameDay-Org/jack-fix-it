"""request idempotency key

Revision ID: f0de579f4b29
Revises: 73c9a4e17b60
Create Date: 2026-11-13 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f0de579f4b29"
down_revision: str | Sequence[str] | None = "73c9a4e17b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "uq_service_requests_customer_id_idempotency_key"


def upgrade() -> None:
    # The create's Idempotency-Key and its body's fingerprint (#264). Expand-only: both columns
    # are nullable and not backfilled, and the unique index covers only rows with a key. The
    # API still serving while Railway migrates never writes a key, so its inserts can never
    # break the index, and its ORM selects name only the columns it knows. The status guard's
    # triggers (#163) watch status and stay as they are.
    op.add_column("service_requests", sa.Column("idempotency_key", sa.Uuid(), nullable=True))
    op.add_column(
        "service_requests", sa.Column("idempotency_fingerprint", sa.String(64), nullable=True)
    )
    op.create_index(
        INDEX,
        "service_requests",
        ["customer_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    # Destructive: the keys and fingerprints stored since the upgrade are lost, so a retry of
    # a create made before the downgrade is no longer recognized.
    op.drop_index(INDEX, table_name="service_requests")
    op.drop_column("service_requests", "idempotency_fingerprint")
    op.drop_column("service_requests", "idempotency_key")
