"""service_requests, quotes, jobs and job_events

Revision ID: b910321e424b
Revises: 08e0129310f4
Create Date: 2026-10-21 04:51:15.617541

"""

import uuid
from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "b910321e424b"
down_revision: str | Sequence[str] | None = "08e0129310f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Internal states, decided 2026-10-21 (docs/glossary.md). Frozen here, as migrations must be.
REQUEST_STATUSES = (
    "received",
    "reviewing",
    "finding_pro",
    "quote_ready",
    "accepted",
    "expired",
    "cancelled",
)
REQUEST_ORIGINS = ("app", "web", "phone")
QUOTE_STATUSES = ("pending", "accepted", "rejected", "expired", "withdrawn")
JOB_STATUSES = (
    "scheduled",
    "on_the_way",
    "in_progress",
    "completed",
    "confirmed",
    "paid_out",
    "disputed",
    "refunded",
    "cancelled",
)
JOB_MONEY_COLUMNS = ("customer_price_cents", "pro_payout_cents", "platform_fee_cents", "tax_cents")

PUBLIC_CODE_SEQUENCE = "service_request_code_seq"
# At most 13 digits, so "JF-" plus the number always fits varchar(16).
PUBLIC_CODE_MAX = 9_999_999_999_999


def _id() -> sa.Column[uuid.UUID]:
    return sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def _timestamps() -> list[sa.Column[datetime]]:
    return [
        sa.Column(
            name,
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        )
        for name in ("created_at", "updated_at")
    ]


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


def upgrade() -> None:
    # Enum columns are varchar plus one named CHECK (ADR 0007), as in the initial migration.
    op.execute(
        sa.schema.CreateSequence(sa.Sequence(PUBLIC_CODE_SEQUENCE, maxvalue=PUBLIC_CODE_MAX))
    )
    op.create_table(
        "service_requests",
        _id(),
        # JF- plus at least 6 digits. to_char, not lpad: lpad truncates 1234567 to 123456.
        sa.Column(
            "public_code",
            sa.String(length=16),
            server_default=sa.text(
                f"'JF-' || to_char(nextval('{PUBLIC_CODE_SEQUENCE}'::regclass), 'FM9999999000000')"
            ),
            nullable=False,
        ),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("address_id", sa.Uuid(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column(
            "intake_answers",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("urgency", sa.String(length=32), nullable=True),
        sa.Column("preferred_contact", sa.String(length=32), nullable=True),
        sa.Column("preferred_date", sa.Date(), nullable=True),
        sa.Column("language", sa.String(length=8), server_default="en", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="received", nullable=False),
        sa.Column("assigned_agent_id", sa.Uuid(), nullable=True),
        sa.Column("next_action", sa.Text(), nullable=True),
        sa.Column("first_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_contact_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("origin", sa.String(length=32), nullable=False),
        sa.Column("utm", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            _in("status", REQUEST_STATUSES), name=op.f("ck_service_requests_request_status")
        ),
        sa.CheckConstraint(
            _in("origin", REQUEST_ORIGINS), name=op.f("ck_service_requests_request_origin")
        ),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["users.id"], name=op.f("fk_service_requests_customer_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_service_requests_category_id_categories"),
        ),
        sa.ForeignKeyConstraint(
            ["address_id"], ["addresses.id"], name=op.f("fk_service_requests_address_id_addresses")
        ),
        sa.ForeignKeyConstraint(
            ["assigned_agent_id"],
            ["users.id"],
            name=op.f("fk_service_requests_assigned_agent_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_service_requests")),
        sa.UniqueConstraint("public_code", name=op.f("uq_service_requests_public_code")),
    )
    for column in ("customer_id", "category_id", "address_id", "assigned_agent_id", "status"):
        op.create_index(op.f(f"ix_service_requests_{column}"), "service_requests", [column])

    op.create_table(
        "quotes",
        _id(),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("duration_minutes", sa.Integer(), nullable=False),
        sa.Column("proposed_start_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        *_timestamps(),
        sa.CheckConstraint(_in("status", QUOTE_STATUSES), name=op.f("ck_quotes_quote_status")),
        sa.CheckConstraint("amount_cents > 0", name=op.f("ck_quotes_amount_cents_positive")),
        sa.CheckConstraint(
            "duration_minutes > 0", name=op.f("ck_quotes_duration_minutes_positive")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_quotes_request_id_service_requests"),
        ),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_quotes_pro_id_pro_profiles")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quotes")),
        # One quote per pro per request; led by request_id, it also indexes that foreign key.
        sa.UniqueConstraint("request_id", "pro_id", name=op.f("uq_quotes_request_id")),
    )
    op.create_index(op.f("ix_quotes_pro_id"), "quotes", ["pro_id"])
    op.create_index(op.f("ix_quotes_status"), "quotes", ["status"])

    op.create_table(
        "jobs",
        _id(),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("quote_id", sa.Uuid(), nullable=False),
        sa.Column("customer_id", sa.Uuid(), nullable=False),
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="scheduled", nullable=False),
        *(sa.Column(column, sa.Integer(), nullable=False) for column in JOB_MONEY_COLUMNS),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(_in("status", JOB_STATUSES), name=op.f("ck_jobs_job_status")),
        # Each amount non-negative; none tied to the others while #2 (Stripe fees) is open.
        *(
            sa.CheckConstraint(f"{column} >= 0", name=op.f(f"ck_jobs_{column}_non_negative"))
            for column in JOB_MONEY_COLUMNS
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_jobs_request_id_service_requests"),
        ),
        sa.ForeignKeyConstraint(["quote_id"], ["quotes.id"], name=op.f("fk_jobs_quote_id_quotes")),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["users.id"], name=op.f("fk_jobs_customer_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_jobs_pro_id_pro_profiles")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
        sa.UniqueConstraint("request_id", name=op.f("uq_jobs_request_id")),
        sa.UniqueConstraint("quote_id", name=op.f("uq_jobs_quote_id")),
    )
    for column in ("customer_id", "pro_id", "status"):
        op.create_index(op.f(f"ix_jobs_{column}"), "jobs", [column])

    op.create_table(
        "job_events",
        _id(),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("from_status", sa.String(length=32), nullable=True),
        sa.Column("to_status", sa.String(length=32), nullable=True),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("lat", sa.Numeric(precision=9, scale=6), nullable=True),
        sa.Column("lng", sa.Numeric(precision=9, scale=6), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            _in("from_status", JOB_STATUSES), name=op.f("ck_job_events_from_job_status")
        ),
        sa.CheckConstraint(
            _in("to_status", JOB_STATUSES), name=op.f("ck_job_events_to_job_status")
        ),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_job_events_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["actor_id"], ["users.id"], name=op.f("fk_job_events_actor_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_events")),
    )
    op.create_index(op.f("ix_job_events_job_id"), "job_events", ["job_id"])
    op.create_index(op.f("ix_job_events_actor_id"), "job_events", ["actor_id"])


def downgrade() -> None:
    # Dropping a table drops its constraints and indexes; the sequence goes last, after the
    # default that uses it.
    op.drop_table("job_events")
    op.drop_table("jobs")
    op.drop_table("quotes")
    op.drop_table("service_requests")
    op.execute(sa.schema.DropSequence(sa.Sequence(PUBLIC_CODE_SEQUENCE)))
