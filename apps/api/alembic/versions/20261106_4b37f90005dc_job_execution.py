"""job execution

Revision ID: 4b37f90005dc
Revises: a7c3e9d14f62
Create Date: 2026-11-06 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4b37f90005dc"
down_revision: str | Sequence[str] | None = "a7c3e9d14f62"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Job execution, part 1 (D12.2, #63): "On my way" sets the ETA and issues the 4-digit
    # arrival code; the check-in (Arrived) takes that code, with a limited number of wrong
    # tries before it locks. All nullable or defaulted: existing jobs are untouched.
    op.add_column("jobs", sa.Column("eta_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("jobs", sa.Column("arrival_code", sa.CHAR(length=4), nullable=True))
    op.add_column(
        "jobs",
        sa.Column("arrival_code_attempts", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "jobs", sa.Column("arrival_code_locked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("jobs", sa.Column("checked_in_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_jobs_arrival_code_four_digits"), "jobs", "arrival_code ~ '^[0-9]{4}$'"
    )
    op.create_check_constraint(
        op.f("ck_jobs_arrival_code_attempts_non_negative"), "jobs", "arrival_code_attempts >= 0"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_jobs_arrival_code_attempts_non_negative"), "jobs", type_="check")
    op.drop_constraint(op.f("ck_jobs_arrival_code_four_digits"), "jobs", type_="check")
    op.drop_column("jobs", "checked_in_at")
    op.drop_column("jobs", "arrival_code_locked_at")
    op.drop_column("jobs", "arrival_code_attempts")
    op.drop_column("jobs", "arrival_code")
    op.drop_column("jobs", "eta_at")
