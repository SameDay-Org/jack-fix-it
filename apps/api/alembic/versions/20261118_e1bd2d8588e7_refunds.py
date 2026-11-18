"""refunds: money given back to the customer, an admin's dispute resolution (#76)

Revision ID: e1bd2d8588e7
Revises: 414f24aa64be
Create Date: 2026-11-18 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e1bd2d8588e7"
down_revision: str | Sequence[str] | None = "414f24aa64be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "refunds"


def upgrade() -> None:
    # A refund of a job's payment to the customer (#76): one per dispute (the unique
    # idempotency key names it). Expand only: Railway runs this in the pre-deploy step while the
    # previous API and worker keep serving; that version neither reads nor writes this table,
    # and no table it knows changes. Enums are varchar(32) plus one named CHECK each (ADR 0007).
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("payment_id", sa.Uuid(), nullable=False),
        sa.Column("dispute_id", sa.Uuid(), nullable=True),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("stripe_refund_id", sa.String(length=255), nullable=True),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error_code", sa.String(length=64), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("stripe_status", sa.String(length=32), nullable=True),
        sa.Column("initiated_by", sa.Uuid(), nullable=True),
        sa.Column("pro_release_cents", sa.Integer(), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
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
            "status IN ('pending', 'created', 'failed')",
            name=op.f("ck_refunds_refund_status"),
        ),
        sa.CheckConstraint(
            "status <> 'created' OR stripe_refund_id IS NOT NULL",
            name=op.f("ck_refunds_created_has_stripe_refund_id"),
        ),
        sa.CheckConstraint(
            "(status = 'created') = (stripe_status IS NOT NULL)",
            name=op.f("ck_refunds_created_has_stripe_status"),
        ),
        sa.CheckConstraint(
            "dispute_id IS NULL OR (initiated_by IS NOT NULL AND pro_release_cents IS NOT NULL"
            " AND resolution_note IS NOT NULL)",
            name=op.f("ck_refunds_dispute_refund_has_decision"),
        ),
        sa.CheckConstraint(
            "pro_release_cents IS NULL OR pro_release_cents >= 0",
            name=op.f("ck_refunds_pro_release_non_negative"),
        ),
        sa.CheckConstraint("amount_cents > 0", name=op.f("ck_refunds_amount_cents_positive")),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_refunds_attempts_non_negative")),
        sa.ForeignKeyConstraint(
            ["dispute_id"], ["disputes.id"], name=op.f("fk_refunds_dispute_id_disputes")
        ),
        sa.ForeignKeyConstraint(
            ["initiated_by"], ["users.id"], name=op.f("fk_refunds_initiated_by_users")
        ),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_refunds_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["payments.id"], name=op.f("fk_refunds_payment_id_payments")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refunds")),
        sa.UniqueConstraint("idempotency_key", name=op.f("uq_refunds_idempotency_key")),
        sa.UniqueConstraint("stripe_refund_id", name=op.f("uq_refunds_stripe_refund_id")),
    )
    op.create_index(op.f("ix_refunds_dispute_id"), TABLE, ["dispute_id"], unique=False)
    op.create_index(op.f("ix_refunds_job_id"), TABLE, ["job_id"], unique=False)
    op.create_index(op.f("ix_refunds_payment_id"), TABLE, ["payment_id"], unique=False)
    op.create_index(op.f("ix_refunds_status"), TABLE, ["status"], unique=False)


def downgrade() -> None:
    # Drops the table and every refund row in it: the record of what was given back to whom.
    # Take a backup first on any database that holds real refunds.
    op.drop_index(op.f("ix_refunds_status"), table_name=TABLE)
    op.drop_index(op.f("ix_refunds_payment_id"), table_name=TABLE)
    op.drop_index(op.f("ix_refunds_job_id"), table_name=TABLE)
    op.drop_index(op.f("ix_refunds_dispute_id"), table_name=TABLE)
    op.drop_table(TABLE)
