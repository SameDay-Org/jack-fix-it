"""chat originals and offender flags

Revision ID: fbd56dcbd642
Revises: e13246f3ed38
Create Date: 2026-11-07 06:37:54.256114

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "fbd56dcbd642"
down_revision: str | Sequence[str] | None = "e13246f3ed38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The column check constraints on job_messages, by name.
_MESSAGE_CHECKS: tuple[tuple[str, str], ...] = (
    (
        "original_complete",
        "(original_ciphertext IS NULL) = (original_key_id IS NULL) "
        "AND (original_key_id IS NULL) = (original_expires_at IS NULL)",
    ),
    ("original_only_redacted", "original_ciphertext IS NULL OR redacted"),
    ("original_ciphertext_length", "octet_length(original_ciphertext) > 28"),
    ("original_key_id_length", "char_length(original_key_id) BETWEEN 1 AND 32"),
)


def upgrade() -> None:
    # #72: the original of a redacted chat message, encrypted for staff (app.crypto: nonce +
    # ciphertext + tag, so more than 12 + 16 bytes), with its key id and when the worker clears
    # it. Nullable: messages written before, unredacted ones and purged ones have none.
    op.add_column("job_messages", sa.Column("original_ciphertext", sa.LargeBinary(), nullable=True))
    op.add_column("job_messages", sa.Column("original_key_id", sa.String(length=32), nullable=True))
    op.add_column(
        "job_messages",
        sa.Column("original_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    for name, condition in _MESSAGE_CHECKS:
        op.create_check_constraint(op.f(f"ck_job_messages_{name}"), "job_messages", condition)
    # The purge reads the originals due; most rows have none.
    op.create_index(
        "ix_job_messages_original_expires_at",
        "job_messages",
        ["original_expires_at"],
        postgresql_where=sa.text("original_expires_at IS NOT NULL"),
    )
    # #72: repeat offenders for the BDC, ids and counts only. One open flag per user.
    op.create_table(
        "chat_offender_flags",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("window_count", sa.Integer(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint(
            "window_count >= 1", name=op.f("ck_chat_offender_flags_window_count_positive")
        ),
        sa.CheckConstraint(
            "resolved_at IS NULL OR resolved_at >= created_at",
            name=op.f("ck_chat_offender_flags_resolved_after_created"),
        ),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_chat_offender_flags_job_id_jobs")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_chat_offender_flags_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_offender_flags")),
    )
    op.create_index(op.f("ix_chat_offender_flags_user_id"), "chat_offender_flags", ["user_id"])
    op.create_index(op.f("ix_chat_offender_flags_job_id"), "chat_offender_flags", ["job_id"])
    op.create_index(
        "uq_chat_offender_flags_open_user_id",
        "chat_offender_flags",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("resolved_at IS NULL"),
    )
    op.create_index(
        "ix_chat_offender_flags_created_at", "chat_offender_flags", ["created_at", "id"]
    )


def downgrade() -> None:
    # Drops the originals (encrypted, staff only) with their columns: a downgrade ends their
    # retention early, which the 90-day rule allows.
    op.drop_table("chat_offender_flags")
    op.drop_index("ix_job_messages_original_expires_at", table_name="job_messages")
    for name, _ in _MESSAGE_CHECKS:
        op.drop_constraint(op.f(f"ck_job_messages_{name}"), "job_messages", type_="check")
    op.drop_column("job_messages", "original_expires_at")
    op.drop_column("job_messages", "original_key_id")
    op.drop_column("job_messages", "original_ciphertext")
