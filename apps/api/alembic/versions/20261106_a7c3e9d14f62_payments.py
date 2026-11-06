"""payments

Revision ID: a7c3e9d14f62
Revises: b3e5a9c17d42
Create Date: 2026-11-06 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7c3e9d14f62"
down_revision: str | Sequence[str] | None = "b3e5a9c17d42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The customer's Stripe Customer (D11.1, #58): created at the first payment, reused after.
    op.add_column("users", sa.Column("stripe_customer_id", sa.String(length=255), nullable=True))
    op.create_unique_constraint(
        op.f("uq_users_stripe_customer_id"), "users", ["stripe_customer_id"]
    )
    # One payment per accepted quote, its amounts frozen at creation: the split of the amount
    # at the stored take rate (app.money.split_amount; the platform absorbs the card fee, so the
    # payout and the fee add up to the amount) and the customer's total, amount plus tax. Enum
    # as varchar plus one named CHECK (ADR 0007).
    op.create_table(
        "payments",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
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
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("quote_id", sa.Uuid(), nullable=False),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("tax_cents", sa.Integer(), nullable=False),
        sa.Column("customer_total_cents", sa.Integer(), nullable=False),
        sa.Column("platform_fee_cents", sa.Integer(), nullable=False),
        sa.Column("pro_payout_cents", sa.Integer(), nullable=False),
        sa.Column("take_rate_bps", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column(
            "status", sa.String(length=32), server_default="requires_payment", nullable=False
        ),
        sa.Column("stripe_payment_intent_id", sa.String(length=255), nullable=True),
        sa.CheckConstraint("amount_cents > 0", name=op.f("ck_payments_amount_cents_positive")),
        sa.CheckConstraint("tax_cents >= 0", name=op.f("ck_payments_tax_cents_non_negative")),
        sa.CheckConstraint(
            "platform_fee_cents >= 0", name=op.f("ck_payments_platform_fee_cents_non_negative")
        ),
        sa.CheckConstraint(
            "pro_payout_cents >= 0", name=op.f("ck_payments_pro_payout_cents_non_negative")
        ),
        sa.CheckConstraint(
            "customer_total_cents = amount_cents + tax_cents",
            name=op.f("ck_payments_customer_total_adds_up"),
        ),
        sa.CheckConstraint(
            "pro_payout_cents + platform_fee_cents = amount_cents",
            name=op.f("ck_payments_split_adds_up"),
        ),
        sa.CheckConstraint(
            "take_rate_bps >= 0 AND take_rate_bps <= 10000",
            name=op.f("ck_payments_take_rate_bps_range"),
        ),
        sa.CheckConstraint(
            "status IN ('requires_payment', 'processing', 'succeeded', 'failed', 'canceled')",
            name=op.f("ck_payments_payment_status"),
        ),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["users.id"], name=op.f("fk_payments_customer_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["quote_id"], ["quotes.id"], name=op.f("fk_payments_quote_id_quotes")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_payments_request_id_service_requests"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payments")),
        sa.UniqueConstraint("quote_id", name=op.f("uq_payments_quote_id")),
        sa.UniqueConstraint(
            "stripe_payment_intent_id", name=op.f("uq_payments_stripe_payment_intent_id")
        ),
    )
    op.create_index(op.f("ix_payments_customer_id"), "payments", ["customer_id"], unique=False)
    op.create_index(op.f("ix_payments_request_id"), "payments", ["request_id"], unique=False)
    op.create_index(op.f("ix_payments_status"), "payments", ["status"], unique=False)


def downgrade() -> None:
    # Destructive: the payments (their frozen amounts and PaymentIntent ids) and the users'
    # Stripe Customer ids are lost; after a later upgrade, the next payment of each customer
    # creates a new Customer in Stripe, and a PaymentIntent created before has no row.
    op.drop_index(op.f("ix_payments_status"), table_name="payments")
    op.drop_index(op.f("ix_payments_request_id"), table_name="payments")
    op.drop_index(op.f("ix_payments_customer_id"), table_name="payments")
    # Dropping the table drops its constraints.
    op.drop_table("payments")
    op.drop_constraint(op.f("uq_users_stripe_customer_id"), "users", type_="unique")
    op.drop_column("users", "stripe_customer_id")
