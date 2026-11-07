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

TABLE = "job_chat_reads"
# The column check constraints on job_chat_reads, by name.
_CHECKS: tuple[tuple[str, str], ...] = (
    ("read_complete", "(last_read_message_id IS NULL) = (last_read_message_at IS NULL)"),
    (
        "delivered_covers_read",
        "last_read_message_at IS NULL OR (last_delivered_message_at, last_delivered_message_id) "
        ">= (last_read_message_at, last_read_message_id)",
    ),
)


def upgrade() -> None:
    # #331: the delivered marker, next to the read marker. A row now exists from the first time
    # a participant lists the thread (delivered only, read still NULL); reading moves both.
    op.add_column(TABLE, sa.Column("last_delivered_message_id", sa.Uuid(), nullable=True))
    op.add_column(
        TABLE,
        sa.Column("last_delivered_message_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Reading implies delivered: every existing row is delivered up to where it was read.
    op.execute(
        sa.text(
            "UPDATE job_chat_reads SET last_delivered_message_id = last_read_message_id, "
            "last_delivered_message_at = last_read_message_at"
        )
    )
    op.alter_column(TABLE, "last_delivered_message_id", nullable=False)
    op.alter_column(TABLE, "last_delivered_message_at", nullable=False)
    op.create_foreign_key(
        op.f("fk_job_chat_reads_last_delivered_message_id_job_messages"),
        TABLE,
        "job_messages",
        ["last_delivered_message_id"],
        ["id"],
    )
    op.create_index(
        op.f("ix_job_chat_reads_last_delivered_message_id"), TABLE, ["last_delivered_message_id"]
    )
    op.alter_column(TABLE, "last_read_message_id", nullable=True)
    op.alter_column(TABLE, "last_read_message_at", nullable=True)
    for name, condition in _CHECKS:
        op.create_check_constraint(op.f(f"ck_job_chat_reads_{name}"), TABLE, condition)


def downgrade() -> None:
    for name, _ in _CHECKS:
        op.drop_constraint(op.f(f"ck_job_chat_reads_{name}"), TABLE, type_="check")
    # Rows with a delivered marker only had no row before this revision: deleting them leaves
    # those participants with no read marker, which is what they had (everything unread).
    op.execute(sa.text("DELETE FROM job_chat_reads WHERE last_read_message_id IS NULL"))
    op.alter_column(TABLE, "last_read_message_id", nullable=False)
    op.alter_column(TABLE, "last_read_message_at", nullable=False)
    op.drop_index(op.f("ix_job_chat_reads_last_delivered_message_id"), table_name=TABLE)
    op.drop_constraint(
        op.f("fk_job_chat_reads_last_delivered_message_id_job_messages"),
        TABLE,
        type_="foreignkey",
    )
    op.drop_column(TABLE, "last_delivered_message_at")
    op.drop_column(TABLE, "last_delivered_message_id")
