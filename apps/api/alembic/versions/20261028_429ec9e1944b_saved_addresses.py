"""saved addresses

Revision ID: 429ec9e1944b
Revises: 3827bdf727f5
Create Date: 2026-10-28 05:42:54.322162

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "429ec9e1944b"
down_revision: str | Sequence[str] | None = "3827bdf727f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The customer's address book (D8.2, #214): named addresses, one of them the default. Its
    # own table: a request's address stays the `addresses` row POST /requests snapshots, so
    # editing or deleting a saved address never changes a request. Coordinates come later
    # ("Use my location", #215).
    op.create_table(
        "saved_addresses",
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
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("label", sa.String(length=30), nullable=False),
        sa.Column("line1", sa.String(length=255), nullable=False),
        sa.Column("line2", sa.String(length=255), nullable=True),
        sa.Column("city", sa.String(length=128), nullable=False),
        sa.Column("state", sa.String(length=2), nullable=False),
        sa.Column("zip_code", sa.String(length=10), nullable=False),
        sa.Column("lat", sa.Numeric(precision=9, scale=6), nullable=True),
        sa.Column("lng", sa.Numeric(precision=9, scale=6), nullable=True),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_saved_addresses_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_saved_addresses")),
    )
    op.create_index(op.f("ix_saved_addresses_user_id"), "saved_addresses", ["user_id"])
    # At most one default per user.
    op.create_index(
        "uq_saved_addresses_user_id_default",
        "saved_addresses",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    # Labels are unique per user ignoring case.
    op.create_index(
        "uq_saved_addresses_user_id_lower_label",
        "saved_addresses",
        ["user_id", sa.literal_column("lower(label)")],
        unique=True,
    )


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes.
    op.drop_table("saved_addresses")
