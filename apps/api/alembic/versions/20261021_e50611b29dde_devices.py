"""devices

Revision ID: e50611b29dde
Revises: 2167b98c0780
Create Date: 2026-10-21 23:24:41.284965

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e50611b29dde"
down_revision: str | Sequence[str] | None = "2167b98c0780"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The phones that receive pushes (#54): one row per Expo push token, which belongs to one
    # user at a time. Enum as varchar plus one named CHECK (ADR 0007).
    op.create_table(
        "devices",
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
        sa.Column("expo_push_token", sa.String(length=255), nullable=False),
        sa.Column("platform", sa.String(length=32), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "platform IN ('ios', 'android')", name=op.f("ck_devices_device_platform")
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_devices_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_devices")),
        sa.UniqueConstraint("expo_push_token", name=op.f("uq_devices_expo_push_token")),
    )
    op.create_index(op.f("ix_devices_user_id"), "devices", ["user_id"])


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes.
    op.drop_table("devices")
