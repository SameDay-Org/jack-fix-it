"""pro_profiles: the order of the Stripe account reads (#524)

Revision ID: a9c625afde58
Revises: 9d282a60960f
Create Date: 2026-11-23 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a9c625afde58"
down_revision: str | Sequence[str] | None = "9d282a60960f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "pro_profiles"
# app.modules.pros.models.PAYOUTS_READ_SEQUENCE, spelled out: a migration never imports the app.
READ_SEQUENCE = "pro_payouts_read_seq"


def upgrade() -> None:
    # Expand only: a sequence and a nullable column. The previous API and worker (serving during
    # Railway's pre-deploy step) keep writing payouts_enabled without knowing either; a row they
    # write keeps its old read number, and the next read's higher number is stored over it.
    op.execute(sa.schema.CreateSequence(sa.Sequence(READ_SEQUENCE)))
    op.add_column(TABLE, sa.Column("payouts_read_seq", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    # Drops only the read order; payouts_enabled stays as stored. The next read after a later
    # upgrade starts a new order, stored over the NULLs.
    op.drop_column(TABLE, "payouts_read_seq")
    op.execute(sa.schema.DropSequence(sa.Sequence(READ_SEQUENCE)))
