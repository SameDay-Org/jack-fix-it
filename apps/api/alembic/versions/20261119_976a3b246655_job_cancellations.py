"""job_cancellations: a job cancelled by its customer or its pro, with its split (#69)

Revision ID: 976a3b246655
Revises: 49fad9f10ec9
Create Date: 2026-11-19 18:00:00.000000

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "976a3b246655"
down_revision: str | Sequence[str] | None = "49fad9f10ec9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "job_cancellations"
IDEMPOTENCY_KEY_INDEX = "uq_job_cancellations_cancelled_by_idempotency_key"


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
    # One new table, one cancellation per job (uq_job_cancellations_job_id). Expand only:
    # Railway runs this in the pre-deploy step while the previous API and worker keep serving;
    # that version neither reads nor writes it, and no table it knows changes. A cancelled job's
    # refund is a refunds row (no dispute, key cancel:<job id>:refund), which the existing
    # columns and CHECKs already hold. Enums are varchar(32) plus one named CHECK each (ADR 0007).
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("cancelled_by", sa.Uuid(), nullable=False),
        sa.Column("party", sa.String(length=32), nullable=False),
        sa.Column("reason_code", sa.String(length=32), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("from_status", sa.String(length=32), nullable=False),
        sa.Column("fee_bps", sa.Integer(), nullable=False),
        sa.Column("fee_cents", sa.Integer(), nullable=False),
        sa.Column("refund_cents", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(), nullable=True),
        sa.Column("idempotency_fingerprint", sa.String(length=64), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "party IN ('customer', 'pro')", name=op.f("ck_job_cancellations_cancel_party")
        ),
        sa.CheckConstraint(
            "reason_code IN ('changed_my_mind', 'found_another_pro', 'pro_late', 'other',"
            " 'cannot_make_it', 'customer_unreachable', 'scope_changed')",
            name=op.f("ck_job_cancellations_cancel_reason"),
        ),
        sa.CheckConstraint(
            "from_status IN ('scheduled', 'on_the_way')",
            name=op.f("ck_job_cancellations_cancelled_from"),
        ),
        sa.CheckConstraint(
            "note IS NULL OR char_length(note) BETWEEN 1 AND 500",
            name=op.f("ck_job_cancellations_note_length"),
        ),
        sa.CheckConstraint(
            "(party = 'customer' AND reason_code IN"
            " ('changed_my_mind', 'found_another_pro', 'other', 'pro_late'))"
            " OR (party = 'pro' AND reason_code IN"
            " ('cannot_make_it', 'customer_unreachable', 'other', 'scope_changed'))",
            name=op.f("ck_job_cancellations_reason_of_party"),
        ),
        sa.CheckConstraint(
            "fee_bps BETWEEN 0 AND 10000", name=op.f("ck_job_cancellations_fee_bps_range")
        ),
        sa.CheckConstraint(
            "fee_cents >= 0", name=op.f("ck_job_cancellations_fee_cents_non_negative")
        ),
        sa.CheckConstraint(
            "refund_cents >= 0", name=op.f("ck_job_cancellations_refund_cents_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_job_cancellations_job_id_jobs")
        ),
        sa.ForeignKeyConstraint(
            ["cancelled_by"], ["users.id"], name=op.f("fk_job_cancellations_cancelled_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_cancellations")),
        sa.UniqueConstraint("job_id", name=op.f("uq_job_cancellations_job_id")),
    )
    op.create_index(
        op.f("ix_job_cancellations_cancelled_by"), TABLE, ["cancelled_by"], unique=False
    )
    op.create_index(
        IDEMPOTENCY_KEY_INDEX,
        TABLE,
        ["cancelled_by", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )


def downgrade() -> None:
    # The table goes with its rows: the jobs stay cancelled, and their refunds stay in refunds.
    op.drop_index(IDEMPOTENCY_KEY_INDEX, table_name=TABLE)
    op.drop_index(op.f("ix_job_cancellations_cancelled_by"), table_name=TABLE)
    op.drop_table(TABLE)
