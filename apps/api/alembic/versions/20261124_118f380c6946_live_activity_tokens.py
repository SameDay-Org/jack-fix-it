"""live_activity_tokens: the push token of each job's iPhone Live Activity (#596, PR 2a)

Revision ID: 118f380c6946
Revises: a9c625afde58
Create Date: 2026-11-24 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "118f380c6946"
down_revision: str | Sequence[str] | None = "a9c625afde58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "live_activity_tokens"


def upgrade() -> None:
    # Expand only: a new table. The previous API and worker (serving during Railway's
    # pre-deploy step) neither read nor write it.
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("token", sa.String(length=512), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_live_activity_tokens_job_id_jobs")
        ),
        # A device's delete (signed out, Expo's DeviceNotRegistered, an account deleted) takes
        # its tokens with it.
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name=op.f("fk_live_activity_tokens_device_id_devices"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_live_activity_tokens")),
        sa.UniqueConstraint("job_id", "device_id", name=op.f("uq_live_activity_tokens_job_id")),
    )
    op.create_index(op.f("ix_live_activity_tokens_device_id"), TABLE, ["device_id"])


def downgrade() -> None:
    # Drops the tokens only: a later upgrade starts with none, and an app sends its activity's
    # token again when it next starts one.
    op.drop_index(op.f("ix_live_activity_tokens_device_id"), table_name=TABLE)
    op.drop_table(TABLE)
