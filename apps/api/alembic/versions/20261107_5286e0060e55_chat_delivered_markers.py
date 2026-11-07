"""chat delivered markers

Revision ID: 5286e0060e55
Revises: fbd56dcbd642
Create Date: 2026-11-07 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5286e0060e55"
down_revision: str | Sequence[str] | None = "fbd56dcbd642"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "job_chat_deliveries"


def upgrade() -> None:
    # #331: each participant's delivered marker, in a table of its own. Expand only: Railway
    # runs this in the pre-deploy step while the previous API keeps serving (and keeps serving
    # if the new one fails), and that version knows only job_chat_reads, left as it was. No
    # backfill: a read message counts as delivered from the read marker.
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("last_delivered_message_id", sa.Uuid(), nullable=False),
        sa.Column("last_delivered_message_at", sa.DateTime(timezone=True), nullable=False),
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
            ["job_id"], ["jobs.id"], name=op.f("fk_job_chat_deliveries_job_id_jobs")
        ),
        sa.ForeignKeyConstraint(
            ["last_delivered_message_id"],
            ["job_messages.id"],
            name=op.f("fk_job_chat_deliveries_last_delivered_message_id_job_messages"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_job_chat_deliveries_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_chat_deliveries")),
        # Also serves the job_id foreign key.
        sa.UniqueConstraint("job_id", "user_id", name=op.f("uq_job_chat_deliveries_job_id")),
    )
    op.create_index(
        op.f("ix_job_chat_deliveries_last_delivered_message_id"),
        TABLE,
        ["last_delivered_message_id"],
    )
    op.create_index(op.f("ix_job_chat_deliveries_user_id"), TABLE, ["user_id"])


def downgrade() -> None:
    # Destructive: the delivered markers go with the table (the code before #331 never reads
    # it); receipts start over from the read markers, which stay. Its constraints and indexes
    # go with it.
    op.drop_table(TABLE)
