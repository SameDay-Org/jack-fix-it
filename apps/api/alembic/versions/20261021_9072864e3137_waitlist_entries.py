"""waitlist_entries

Revision ID: 9072864e3137
Revises: e50611b29dde
Create Date: 2026-10-21 23:44:58.666794

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9072864e3137"
down_revision: str | Sequence[str] | None = "e50611b29dde"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # People outside the served area who want to hear when it opens (#46). A minimal contact,
    # kept only for that notice; one entry per contact per ZIP (the two partial unique indexes).
    # Enum as varchar plus one named CHECK (ADR 0007).
    op.create_table(
        "waitlist_entries",
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
        sa.Column("zip_code", sa.String(length=10), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("phone", sa.String(length=20), nullable=True),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("locale", sa.String(length=8), server_default="en", nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "source IN ('app', 'web')", name=op.f("ck_waitlist_entries_waitlist_source")
        ),
        sa.CheckConstraint(
            "email = lower(email)", name=op.f("ck_waitlist_entries_email_lowercase")
        ),
        sa.CheckConstraint(
            "email IS NOT NULL OR phone IS NOT NULL",
            name=op.f("ck_waitlist_entries_email_or_phone"),
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_waitlist_entries_category_id_categories"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_waitlist_entries_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_waitlist_entries")),
    )
    op.create_index(op.f("ix_waitlist_entries_zip_code"), "waitlist_entries", ["zip_code"])
    op.create_index(op.f("ix_waitlist_entries_category_id"), "waitlist_entries", ["category_id"])
    op.create_index(op.f("ix_waitlist_entries_user_id"), "waitlist_entries", ["user_id"])
    op.create_index(
        "uq_waitlist_entries_zip_code_email",
        "waitlist_entries",
        ["zip_code", "email"],
        unique=True,
        postgresql_where=sa.text("email IS NOT NULL"),
    )
    op.create_index(
        "uq_waitlist_entries_zip_code_phone",
        "waitlist_entries",
        ["zip_code", "phone"],
        unique=True,
        postgresql_where=sa.text("phone IS NOT NULL"),
    )


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes.
    op.drop_table("waitlist_entries")
