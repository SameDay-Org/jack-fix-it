"""pro_categories_service_areas

Revision ID: 2167b98c0780
Revises: 9b4694b6c884
Create Date: 2026-10-21 23:40:12.512305

"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2167b98c0780"
down_revision: str | Sequence[str] | None = "9b4694b6c884"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _id_and_timestamps() -> list[sa.Column[Any]]:
    return [
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
    ]


def upgrade() -> None:
    # What a pro does and where (#36, N:N). Each pair once; an index on every foreign key
    # (ADR 0007).
    op.create_table(
        "pro_categories",
        *_id_and_timestamps(),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_pro_categories_pro_id_pro_profiles")
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_pro_categories_category_id_categories"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pro_categories")),
        sa.UniqueConstraint("pro_id", "category_id", name=op.f("uq_pro_categories_pro_id")),
    )
    op.create_index(op.f("ix_pro_categories_pro_id"), "pro_categories", ["pro_id"])
    op.create_index(op.f("ix_pro_categories_category_id"), "pro_categories", ["category_id"])
    op.create_table(
        "pro_service_areas",
        *_id_and_timestamps(),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("service_area_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_pro_service_areas_pro_id_pro_profiles")
        ),
        sa.ForeignKeyConstraint(
            ["service_area_id"],
            ["service_areas.id"],
            name=op.f("fk_pro_service_areas_service_area_id_service_areas"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pro_service_areas")),
        sa.UniqueConstraint("pro_id", "service_area_id", name=op.f("uq_pro_service_areas_pro_id")),
    )
    op.create_index(op.f("ix_pro_service_areas_pro_id"), "pro_service_areas", ["pro_id"])
    op.create_index(
        op.f("ix_pro_service_areas_service_area_id"), "pro_service_areas", ["service_area_id"]
    )

    op.add_column("pro_profiles", sa.Column("years_of_experience", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f("ck_pro_profiles_years_of_experience_range"),
        "pro_profiles",
        "years_of_experience BETWEEN 0 AND 80",
    )


def downgrade() -> None:
    # Dropping a table drops its constraints and indexes; the column drop takes its CHECK.
    op.drop_column("pro_profiles", "years_of_experience")
    op.drop_table("pro_service_areas")
    op.drop_table("pro_categories")
