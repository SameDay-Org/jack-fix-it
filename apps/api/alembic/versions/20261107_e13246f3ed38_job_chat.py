"""job chat

Revision ID: e13246f3ed38
Revises: 1f4aa780a8d2
Create Date: 2026-11-07 04:00:00.000000

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e13246f3ed38"
down_revision: str | Sequence[str] | None = "1f4aa780a8d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column[datetime]]:
    return [
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
    # Job chat, part 1 (D14.1, #71): one thread per job, text only. The body is stored already
    # redacted (app.redaction); the original is never kept here (#72 decides).
    op.create_table(
        "job_messages",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("sender_id", sa.Uuid(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("redacted", sa.Boolean(), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "char_length(body) BETWEEN 1 AND 2000", name=op.f("ck_job_messages_body_length")
        ),
        sa.CheckConstraint("body ~ '[^[:space:]]'", name=op.f("ck_job_messages_body_not_blank")),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_job_messages_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["sender_id"], ["users.id"], name=op.f("fk_job_messages_sender_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_messages")),
    )
    # The thread newest first and the unread counts; it also serves the job_id foreign key.
    op.create_index(
        "ix_job_messages_job_id_created_at", "job_messages", ["job_id", "created_at", "id"]
    )
    op.create_index(op.f("ix_job_messages_sender_id"), "job_messages", ["sender_id"])
    # Each participant's read marker; its unique index serves the job_id foreign key.
    op.create_table(
        "job_chat_reads",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("last_read_message_id", sa.Uuid(), nullable=False),
        sa.Column("last_read_message_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_job_chat_reads_job_id_jobs")
        ),
        sa.ForeignKeyConstraint(
            ["last_read_message_id"],
            ["job_messages.id"],
            name=op.f("fk_job_chat_reads_last_read_message_id_job_messages"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_job_chat_reads_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_chat_reads")),
        sa.UniqueConstraint("job_id", "user_id", name=op.f("uq_job_chat_reads_job_id")),
    )
    op.create_index(
        op.f("ix_job_chat_reads_last_read_message_id"), "job_chat_reads", ["last_read_message_id"]
    )
    op.create_index(op.f("ix_job_chat_reads_user_id"), "job_chat_reads", ["user_id"])


def downgrade() -> None:
    # Destructive: the chats go with the tables (the code before #71 never reads them).
    # Dropping a table drops its constraints and indexes; the markers first (they reference
    # the messages).
    op.drop_table("job_chat_reads")
    op.drop_table("job_messages")
