"""launch_interest

Revision ID: 2f18303b6287
Revises: e9125c0828a1
Create Date: 2026-11-20 05:58:52.790066

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2f18303b6287"
down_revision: str | Sequence[str] | None = "e9125c0828a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The app-launch interest list (#409): an email only, one row per email (lower case), with
    # the consent's version and time. Expand-only: a new table, nothing else touched. Enum as
    # varchar plus one named CHECK (ADR 0007).
    op.create_table(
        "launch_interest",
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
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("locale", sa.String(length=8), server_default="en", nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("consent_version", sa.String(length=64), nullable=False),
        sa.Column(
            "consented_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source IN ('showcase')", name=op.f("ck_launch_interest_interest_source")
        ),
        sa.CheckConstraint("email = lower(email)", name=op.f("ck_launch_interest_email_lowercase")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_launch_interest")),
        sa.UniqueConstraint("email", name=op.f("uq_launch_interest_email")),
    )


def downgrade() -> None:
    # Drops the list, and with it every email on it.
    op.drop_table("launch_interest")
