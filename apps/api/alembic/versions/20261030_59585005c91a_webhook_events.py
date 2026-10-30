"""webhook events

Revision ID: 59585005c91a
Revises: 7675e571942e
Create Date: 2026-10-30 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "59585005c91a"
down_revision: str | Sequence[str] | None = "7675e571942e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Stripe events (D7.3, #40): one row per event id, so a redelivery is never handled twice.
    # The payload is kept only while the event may still be handled (pending or failed). Enum
    # as varchar plus one named CHECK (ADR 0007).
    op.create_table(
        "webhook_events",
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
        sa.Column("stripe_event_id", sa.String(length=255), nullable=False),
        sa.Column("event_type", sa.String(length=255), nullable=False),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("stripe_created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.String(length=255), nullable=True),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'processed', 'ignored', 'failed')",
            name=op.f("ck_webhook_events_webhook_event_status"),
        ),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_webhook_events_attempts_non_negative")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_webhook_events")),
        sa.UniqueConstraint("stripe_event_id", name=op.f("uq_webhook_events_stripe_event_id")),
    )


def downgrade() -> None:
    # Dropping the table drops its constraints.
    op.drop_table("webhook_events")
