"""notification preferences

Revision ID: d0bc3353ce35
Revises: 429ec9e1944b
Create Date: 2026-10-28 20:13:01.060426

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d0bc3353ce35"
down_revision: str | Sequence[str] | None = "429ec9e1944b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Per-user notification choices (D13, #217): only the pairs a user changed. Defaults and
    # locks live in code (notifications.preferences), so group and channel are plain text and
    # a new group needs no migration. A deleted user takes their choices along.
    op.create_table(
        "notification_preferences",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("group", sa.Text(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
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
            ["user_id"],
            ["users.id"],
            name=op.f("fk_notification_preferences_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "group", "channel", name=op.f("pk_notification_preferences")
        ),
    )


def downgrade() -> None:
    # Dropping the table drops its constraints.
    op.drop_table("notification_preferences")
