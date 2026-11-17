"""transfers

Revision ID: 52bb3f92f12b
Revises: 6fedce2078df
Create Date: 2026-11-15 23:30:05.127977

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "52bb3f92f12b"
down_revision: str | Sequence[str] | None = "6fedce2078df"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "transfers"


def upgrade() -> None:
    # The transfer to the pro once their job is confirmed (D13.3, #68): at most one per job
    # (the unique job_id is the guard against paying a job twice). Expand only: Railway runs
    # this in the pre-deploy step while the previous API and worker keep serving (and keep
    # serving if the new ones fail). That version neither reads nor writes this table, and no
    # table it knows changes. Enums are varchar(32) plus one named CHECK each (ADR 0007).
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("payment_id", sa.Uuid(), nullable=False),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("stripe_transfer_id", sa.String(length=255), nullable=True),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error_code", sa.String(length=64), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=True),
        # The read of a stored transfer from Stripe, for a reversal: when one last started, and
        # when one last succeeded (NULL: still needed; the recovery cron reads it, #416 r2).
        sa.Column("reversal_check_tried_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversal_checked_at", sa.DateTime(timezone=True), nullable=True),
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
            "status IN ('pending', 'created', 'failed', 'reversed')",
            name=op.f("ck_transfers_transfer_status"),
        ),
        sa.CheckConstraint(
            "status NOT IN ('created', 'reversed') OR stripe_transfer_id IS NOT NULL",
            name=op.f("ck_transfers_made_has_stripe_transfer_id"),
        ),
        sa.CheckConstraint("amount_cents > 0", name=op.f("ck_transfers_amount_cents_positive")),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_transfers_attempts_non_negative")),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_transfers_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["payment_id"], ["payments.id"], name=op.f("fk_transfers_payment_id_payments")
        ),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_transfers_pro_id_pro_profiles")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_transfers")),
        sa.UniqueConstraint("idempotency_key", name=op.f("uq_transfers_idempotency_key")),
        sa.UniqueConstraint("job_id", name=op.f("uq_transfers_job_id")),
        sa.UniqueConstraint("stripe_transfer_id", name=op.f("uq_transfers_stripe_transfer_id")),
    )
    op.create_index(op.f("ix_transfers_payment_id"), TABLE, ["payment_id"], unique=False)
    op.create_index(op.f("ix_transfers_pro_id"), TABLE, ["pro_id"], unique=False)
    op.create_index(op.f("ix_transfers_status"), TABLE, ["status"], unique=False)


def downgrade() -> None:
    # Drops the table and every transfer row in it: the record of what was paid to whom. Take
    # a backup first on any database that holds real transfers.
    op.drop_index(op.f("ix_transfers_status"), table_name=TABLE)
    op.drop_index(op.f("ix_transfers_pro_id"), table_name=TABLE)
    op.drop_index(op.f("ix_transfers_payment_id"), table_name=TABLE)
    op.drop_table(TABLE)
