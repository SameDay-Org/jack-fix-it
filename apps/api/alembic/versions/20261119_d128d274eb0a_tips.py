"""tips: the customer's tip for the pro on a confirmed job (#273)

Revision ID: d128d274eb0a
Revises: 920fe99e6f1d
Create Date: 2026-11-19 17:00:00.000000

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d128d274eb0a"
down_revision: str | Sequence[str] | None = "920fe99e6f1d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "tips"
REQUESTS = "tip_requests"
UNPAID_WHERE = "status IN ('requires_payment', 'failed') AND stripe_payment_intent_id IS NOT NULL"


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
    # One new table, one tip per job (uq_tips_job_id). Expand only: Railway runs this in the
    # pre-deploy step while the previous API and worker keep serving; that version neither
    # reads nor writes it, and no table it knows changes. Enums are varchar(32) plus one named
    # CHECK each (ADR 0007). The card, transfer and receipt columns are filled by #62 and the
    # tip transfer (#273 PR A2), which add no migration of their own for them.
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("choice", sa.String(length=32), nullable=False),
        sa.Column("percent", sa.SmallInteger(), nullable=True),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("stripe_payment_intent_id", sa.String(length=255), nullable=True),
        sa.Column("attempt", sa.Integer(), server_default="0", nullable=False),
        sa.Column("payment_intent_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("card_brand", sa.String(length=32), nullable=True),
        sa.Column("card_last4", sa.CHAR(length=4), nullable=True),
        sa.Column("wallet", sa.String(length=32), nullable=True),
        sa.Column("succeeded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("transfer_status", sa.String(length=32), server_default="none", nullable=False),
        sa.Column("stripe_transfer_id", sa.String(length=255), nullable=True),
        sa.Column("transfer_idempotency_key", sa.String(length=255), nullable=True),
        sa.Column("transfer_attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("transfer_last_error_code", sa.String(length=64), nullable=True),
        sa.Column("transfer_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("receipt_emailed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("create_refused_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("late_success_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "choice IN ('none', 'percent', 'custom')", name=op.f("ck_tips_tip_choice")
        ),
        sa.CheckConstraint(
            "status IN ('declined', 'requires_payment', 'processing', 'succeeded', 'failed', "
            "'canceled')",
            name=op.f("ck_tips_tip_status"),
        ),
        sa.CheckConstraint(
            "transfer_status IN ('none', 'pending', 'created', 'paid', 'failed', 'held')",
            name=op.f("ck_tips_tip_transfer_status"),
        ),
        sa.CheckConstraint("amount_cents >= 0", name=op.f("ck_tips_amount_cents_non_negative")),
        sa.CheckConstraint(
            "(choice = 'none') = (amount_cents = 0)", name=op.f("ck_tips_amount_matches_choice")
        ),
        sa.CheckConstraint(
            "(choice = 'none') = (status = 'declined')", name=op.f("ck_tips_status_matches_choice")
        ),
        sa.CheckConstraint(
            "(choice = 'percent') = (percent IS NOT NULL)",
            name=op.f("ck_tips_percent_matches_choice"),
        ),
        sa.CheckConstraint("percent IS NULL OR percent > 0", name=op.f("ck_tips_percent_positive")),
        sa.CheckConstraint("attempt >= 0", name=op.f("ck_tips_attempt_non_negative")),
        sa.CheckConstraint(
            "(status = 'succeeded') = (succeeded_at IS NOT NULL)",
            name=op.f("ck_tips_succeeded_has_time"),
        ),
        sa.CheckConstraint(
            "card_last4 ~ '^[0-9]{4}$'", name=op.f("ck_tips_card_last4_four_digits")
        ),
        sa.CheckConstraint(
            "transfer_attempts >= 0", name=op.f("ck_tips_transfer_attempts_non_negative")
        ),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_tips_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_tips_request_id_service_requests"),
        ),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["users.id"], name=op.f("fk_tips_customer_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_tips_pro_id_pro_profiles")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tips")),
        sa.UniqueConstraint("job_id", name=op.f("uq_tips_job_id")),
        sa.UniqueConstraint(
            "stripe_payment_intent_id", name=op.f("uq_tips_stripe_payment_intent_id")
        ),
        sa.UniqueConstraint("stripe_transfer_id", name=op.f("uq_tips_stripe_transfer_id")),
        sa.UniqueConstraint(
            "transfer_idempotency_key", name=op.f("uq_tips_transfer_idempotency_key")
        ),
    )
    op.create_index(op.f("ix_tips_request_id"), TABLE, ["request_id"], unique=False)
    op.create_index(op.f("ix_tips_customer_id"), TABLE, ["customer_id"], unique=False)
    op.create_index(op.f("ix_tips_pro_id"), TABLE, ["pro_id"], unique=False)
    # The unpaid sweep's read: the tips still unpaid, by their current attempt's age.
    op.create_index(
        "ix_tips_unpaid_requested_at",
        TABLE,
        ["payment_intent_requested_at"],
        unique=False,
        postgresql_where=sa.text(UNPAID_WHERE),
    )

    # A choice made with an Idempotency-Key (#510 round 1): a replay answers it again.
    op.create_table(
        REQUESTS,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_tip_requests_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["users.id"], name=op.f("fk_tip_requests_customer_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tip_requests")),
    )
    op.create_index(op.f("ix_tip_requests_job_id"), REQUESTS, ["job_id"], unique=False)
    op.create_index(
        "uq_tip_requests_customer_id_idempotency_key",
        REQUESTS,
        ["customer_id", "idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    # Drops the tables and every tip in them, paid ones included (their money stays in
    # Stripe). Take a backup first on any database that holds real ones.
    op.drop_index("uq_tip_requests_customer_id_idempotency_key", table_name=REQUESTS)
    op.drop_index(op.f("ix_tip_requests_job_id"), table_name=REQUESTS)
    op.drop_table(REQUESTS)
    op.drop_index(
        "ix_tips_unpaid_requested_at", table_name=TABLE, postgresql_where=sa.text(UNPAID_WHERE)
    )
    op.drop_index(op.f("ix_tips_pro_id"), table_name=TABLE)
    op.drop_index(op.f("ix_tips_customer_id"), table_name=TABLE)
    op.drop_index(op.f("ix_tips_request_id"), table_name=TABLE)
    op.drop_table(TABLE)
