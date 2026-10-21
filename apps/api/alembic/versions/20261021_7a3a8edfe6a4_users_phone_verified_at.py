"""users phone_verified_at

Revision ID: 7a3a8edfe6a4
Revises: b910321e424b
Create Date: 2026-10-21 06:18:25.857247

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7a3a8edfe6a4"
down_revision: str | Sequence[str] | None = "b910321e424b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # When the phone was verified by SMS code (#26); NULL while unverified. Additive, nullable.
    op.add_column(
        "users", sa.Column("phone_verified_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "phone_verified_at")
