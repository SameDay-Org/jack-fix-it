"""settings and request_dispatches

Revision ID: cc5f5e3a9bbf
Revises: 9072864e3137
Create Date: 2026-10-22 03:13:40.027313

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "cc5f5e3a9bbf"
down_revision: str | Sequence[str] | None = "9072864e3137"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DISPATCH_STATUSES = ("sent", "viewed", "declined", "quoted", "expired")


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
    # Runtime settings (#48): a JSON value per key, edited later in the admin (#41).
    settings = op.create_table(
        "settings",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["updated_by"], ["users.id"], name=op.f("fk_settings_updated_by_users")
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_settings")),
    )
    op.create_index(op.f("ix_settings_updated_by"), "settings", ["updated_by"])
    # Launch values are data: dispatch sends each request to up to 5 pros (context doc §5), and
    # a quote expires 48 hours after it is sent (Cesar, 2026-10-22, #50). No code default.
    op.bulk_insert(
        settings,
        [
            {"key": "dispatch_max_pros", "value": 5},
            {"key": "quote_ttl_hours", "value": 48},
        ],
    )

    # A request sent to one pro (#48). Enum as varchar plus one named CHECK (ADR 0007); one row
    # per request and pro, so a re-run of dispatch never sends twice.
    op.create_table(
        "request_dispatches",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="sent", nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        # First opened by the pro (#49).
        sa.Column("viewed_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            f"status IN ({', '.join(repr(status) for status in DISPATCH_STATUSES)})",
            name=op.f("ck_request_dispatches_dispatch_status"),
        ),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_request_dispatches_pro_id_pro_profiles")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_request_dispatches_request_id_service_requests"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_request_dispatches")),
        sa.UniqueConstraint("request_id", "pro_id", name=op.f("uq_request_dispatches_request_id")),
    )
    op.create_index(op.f("ix_request_dispatches_pro_id"), "request_dispatches", ["pro_id"])
    op.create_index(op.f("ix_request_dispatches_request_id"), "request_dispatches", ["request_id"])


def downgrade() -> None:
    # Dropping a table drops its constraints, indexes and rows (the seeded setting too).
    op.drop_table("request_dispatches")
    op.drop_table("settings")
