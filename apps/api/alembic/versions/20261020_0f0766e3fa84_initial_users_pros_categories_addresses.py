"""initial users, pro_profiles, categories and addresses

Revision ID: 0f0766e3fa84
Revises:
Create Date: 2026-10-20 22:01:42.948694

"""

import uuid
from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0f0766e3fa84"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


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


def upgrade() -> None:
    # Enum columns are varchar plus one named CHECK (ADR 0007), not sa.Enum: with the
    # naming convention, sa.Enum here would add a second, duplicate CHECK.
    op.create_table(
        "users",
        _id(),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("phone", sa.String(length=20), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("locale", sa.String(length=8), server_default="en", nullable=False),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "role IN ('customer', 'pro', 'agent', 'admin')", name=op.f("ck_users_user_role")
        ),
        sa.CheckConstraint("status IN ('active', 'suspended')", name=op.f("ck_users_user_status")),
        sa.CheckConstraint("email = lower(email)", name=op.f("ck_users_email_lowercase")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
        sa.UniqueConstraint("phone", name=op.f("uq_users_phone")),
    )
    op.create_index(op.f("ix_users_role"), "users", ["role"])
    op.create_index(op.f("ix_users_status"), "users", ["status"])

    op.create_table(
        "pro_profiles",
        _id(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("bio", sa.Text(), nullable=True),
        sa.Column("photo_key", sa.String(length=512), nullable=True),
        sa.Column(
            "verification_status", sa.String(length=32), server_default="pending", nullable=False
        ),
        sa.Column("stripe_account_id", sa.String(length=255), nullable=True),
        sa.Column("payouts_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("rating_avg", sa.Numeric(precision=3, scale=2), nullable=True),
        sa.Column("jobs_count", sa.Integer(), server_default="0", nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "verification_status IN ('pending', 'approved', 'rejected')",
            name=op.f("ck_pro_profiles_pro_verification_status"),
        ),
        sa.CheckConstraint("jobs_count >= 0", name=op.f("ck_pro_profiles_jobs_count_non_negative")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_pro_profiles_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pro_profiles")),
        sa.UniqueConstraint("user_id", name=op.f("uq_pro_profiles_user_id")),
        sa.UniqueConstraint("stripe_account_id", name=op.f("uq_pro_profiles_stripe_account_id")),
    )
    op.create_index(
        op.f("ix_pro_profiles_verification_status"), "pro_profiles", ["verification_status"]
    )

    op.create_table(
        "categories",
        _id(),
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("names", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("icon", sa.String(length=64), nullable=True),
        sa.Column("requires_license", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("reference_price_cents", sa.Integer(), nullable=True),
        sa.Column(
            "intake_questions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        *_timestamps(),
        sa.CheckConstraint("names ? 'en' AND names ? 'es'", name=op.f("ck_categories_names_en_es")),
        sa.CheckConstraint(
            "reference_price_cents >= 0",
            name=op.f("ck_categories_reference_price_cents_non_negative"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_categories")),
        sa.UniqueConstraint("slug", name=op.f("uq_categories_slug")),
    )
    op.create_index(op.f("ix_categories_active"), "categories", ["active"])

    op.create_table(
        "addresses",
        _id(),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("line1", sa.String(length=255), nullable=False),
        sa.Column("line2", sa.String(length=255), nullable=True),
        sa.Column("city", sa.String(length=128), nullable=False),
        sa.Column("state", sa.String(length=2), nullable=False),
        sa.Column("zip_code", sa.String(length=10), nullable=False),
        sa.Column("lat", sa.Numeric(precision=9, scale=6), nullable=True),
        sa.Column("lng", sa.Numeric(precision=9, scale=6), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_addresses_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_addresses")),
    )
    op.create_index(op.f("ix_addresses_user_id"), "addresses", ["user_id"])
    op.create_index(op.f("ix_addresses_zip_code"), "addresses", ["zip_code"])


def downgrade() -> None:
    # Dropping a table drops its constraints and indexes.
    op.drop_table("addresses")
    op.drop_table("categories")
    op.drop_table("pro_profiles")
    op.drop_table("users")
