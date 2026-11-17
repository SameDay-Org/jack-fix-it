"""disputes: a problem the customer reports with a completed job, and its photos (#75)

Revision ID: 414f24aa64be
Revises: 52bb3f92f12b
Create Date: 2026-11-17 20:03:06.815922

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "414f24aa64be"
down_revision: str | Sequence[str] | None = "52bb3f92f12b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

IDEMPOTENCY_KEY_INDEX = "uq_disputes_opened_by_idempotency_key"


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
    # Two new tables, one dispute per job (uq_disputes_job_id). Expand only: Railway runs this in
    # the pre-deploy step while the previous API and worker keep serving; that version neither
    # reads nor writes these tables, and no table it knows changes. Enums are varchar(32) plus
    # one named CHECK each (ADR 0007). The resolution columns stay NULL until #76.
    op.create_table(
        "disputes",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("opened_by", sa.Uuid(), nullable=False),
        sa.Column("reason_code", sa.String(length=32), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="open", nullable=False),
        sa.Column("pro_reply", sa.Text(), nullable=True),
        sa.Column("pro_replied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolution", sa.String(length=32), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("resolved_by", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pro_release_cents", sa.Integer(), nullable=True),
        sa.Column("customer_refund_cents", sa.Integer(), nullable=True),
        sa.Column("idempotency_key", sa.Uuid(), nullable=True),
        sa.Column("idempotency_fingerprint", sa.String(length=64), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "reason_code IN ('work_incomplete', 'poor_quality', 'no_show', 'damage', 'other')",
            name=op.f("ck_disputes_dispute_reason"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'resolved')", name=op.f("ck_disputes_dispute_status")
        ),
        sa.CheckConstraint(
            "resolution IN ('released', 'partial_release', 'refunded')",
            name=op.f("ck_disputes_dispute_resolution"),
        ),
        sa.CheckConstraint(
            "char_length(description) BETWEEN 1 AND 2000",
            name=op.f("ck_disputes_description_length"),
        ),
        sa.CheckConstraint(
            "pro_reply IS NULL OR char_length(pro_reply) BETWEEN 1 AND 2000",
            name=op.f("ck_disputes_pro_reply_length"),
        ),
        sa.CheckConstraint(
            "(pro_reply IS NULL) = (pro_replied_at IS NULL)",
            name=op.f("ck_disputes_pro_reply_has_time"),
        ),
        sa.CheckConstraint(
            "(status = 'open' AND resolution IS NULL AND resolved_by IS NULL"
            " AND resolved_at IS NULL)"
            " OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_by IS NOT NULL"
            " AND resolved_at IS NOT NULL)",
            name=op.f("ck_disputes_resolution_matches_status"),
        ),
        sa.CheckConstraint(
            "pro_release_cents IS NULL OR pro_release_cents >= 0",
            name=op.f("ck_disputes_pro_release_non_negative"),
        ),
        sa.CheckConstraint(
            "customer_refund_cents IS NULL OR customer_refund_cents >= 0",
            name=op.f("ck_disputes_customer_refund_non_negative"),
        ),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_disputes_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["opened_by"], ["users.id"], name=op.f("fk_disputes_opened_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["resolved_by"], ["users.id"], name=op.f("fk_disputes_resolved_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_disputes")),
        sa.UniqueConstraint("job_id", name=op.f("uq_disputes_job_id")),
    )
    op.create_index(op.f("ix_disputes_opened_by"), "disputes", ["opened_by"], unique=False)
    op.create_index(op.f("ix_disputes_status"), "disputes", ["status"], unique=False)
    op.create_index(
        IDEMPOTENCY_KEY_INDEX,
        "disputes",
        ["opened_by", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )
    op.create_table(
        "dispute_photos",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("dispute_id", sa.Uuid(), nullable=False),
        sa.Column("file_key", sa.String(length=256), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), nullable=False),
        sa.Column("safe_key", sa.String(length=256), nullable=True),
        sa.Column("safe_status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("safe_content_type", sa.String(length=64), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "safe_status IN ('pending', 'ready', 'failed')",
            name=op.f("ck_dispute_photos_media_safe_status"),
        ),
        sa.ForeignKeyConstraint(
            ["dispute_id"], ["disputes.id"], name=op.f("fk_dispute_photos_dispute_id_disputes")
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by"], ["users.id"], name=op.f("fk_dispute_photos_uploaded_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dispute_photos")),
        sa.UniqueConstraint("file_key", name=op.f("uq_dispute_photos_file_key")),
        sa.UniqueConstraint("safe_key", name=op.f("uq_dispute_photos_safe_key")),
    )
    op.create_index(
        op.f("ix_dispute_photos_dispute_id"), "dispute_photos", ["dispute_id"], unique=False
    )
    op.create_index(
        op.f("ix_dispute_photos_uploaded_by"), "dispute_photos", ["uploaded_by"], unique=False
    )


def downgrade() -> None:
    # Drops both tables and every dispute in them: the record of who reported what. Take a backup
    # first on any database that holds real disputes.
    op.drop_index(op.f("ix_dispute_photos_uploaded_by"), table_name="dispute_photos")
    op.drop_index(op.f("ix_dispute_photos_dispute_id"), table_name="dispute_photos")
    op.drop_table("dispute_photos")
    op.drop_index(IDEMPOTENCY_KEY_INDEX, table_name="disputes")
    op.drop_index(op.f("ix_disputes_status"), table_name="disputes")
    op.drop_index(op.f("ix_disputes_opened_by"), table_name="disputes")
    op.drop_table("disputes")
