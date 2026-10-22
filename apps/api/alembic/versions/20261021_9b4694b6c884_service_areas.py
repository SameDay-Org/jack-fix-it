"""service_areas

Revision ID: 9b4694b6c884
Revises: a382af4f9826
Create Date: 2026-10-21 22:26:39.286898

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9b4694b6c884"
down_revision: str | Sequence[str] | None = "a382af4f9826"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Where Jack Fix It works (#36): one row per served ZIP, grouped by region and city. Data,
    # never code: the launch list arrives through the seed (#9).
    op.create_table(
        "service_areas",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("region", sa.String(length=64), nullable=False),
        sa.Column("city", sa.String(length=128), nullable=False),
        sa.Column("state", sa.CHAR(length=2), nullable=False),
        sa.Column("zip_code", sa.String(length=10), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_service_areas")),
        sa.UniqueConstraint("zip_code", name=op.f("uq_service_areas_zip_code")),
    )
    op.create_index(op.f("ix_service_areas_active"), "service_areas", ["active"])
    op.create_index("ix_service_areas_region_city", "service_areas", ["region", "city"])


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes.
    op.drop_table("service_areas")
