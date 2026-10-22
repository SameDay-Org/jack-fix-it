"""user names

Revision ID: 2c68b44ae557
Revises: 4eb1fd67455e
Create Date: 2026-10-22 06:21:40.640663

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2c68b44ae557"
down_revision: str | Sequence[str] | None = "4eb1fd67455e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # #165: first and last names, PII. NULL for existing accounts; set together by the API.
    op.add_column("users", sa.Column("first_name", sa.String(length=60), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(length=60), nullable=True))


def downgrade() -> None:
    # Drops the stored names: a downgrade loses them.
    op.drop_column("users", "last_name")
    op.drop_column("users", "first_name")
