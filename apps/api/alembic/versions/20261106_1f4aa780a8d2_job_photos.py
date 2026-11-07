"""job photos

Revision ID: 1f4aa780a8d2
Revises: 4b37f90005dc
Create Date: 2026-11-06 21:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1f4aa780a8d2"
down_revision: str | Sequence[str] | None = "4b37f90005dc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Job execution, part 2 (D12.2, #298): the pro's before and after photos of a job, each a
    # job_photo upload (unique: one file belongs to one job) with its privacy-safe copy (#173).
    # Enums as varchar plus one named CHECK each (ADR 0007).
    op.create_table(
        "job_photos",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("file_key", sa.String(length=256), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), nullable=False),
        sa.Column("safe_key", sa.String(length=256), nullable=True),
        sa.Column("safe_status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("safe_content_type", sa.String(length=64), nullable=True),
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
            "kind IN ('before', 'after')", name=op.f("ck_job_photos_job_photo_kind")
        ),
        sa.CheckConstraint(
            "safe_status IN ('pending', 'ready', 'failed')",
            name=op.f("ck_job_photos_media_safe_status"),
        ),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_job_photos_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["uploaded_by"], ["users.id"], name=op.f("fk_job_photos_uploaded_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_job_photos")),
        sa.UniqueConstraint("file_key", name=op.f("uq_job_photos_file_key")),
        sa.UniqueConstraint("safe_key", name=op.f("uq_job_photos_safe_key")),
    )
    op.create_index(op.f("ix_job_photos_job_id"), "job_photos", ["job_id"])
    op.create_index(op.f("ix_job_photos_uploaded_by"), "job_photos", ["uploaded_by"])


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes. The originals and safe copies stay
    # in storage (the code before #298 has its orphan sweep skip job photos).
    op.drop_table("job_photos")
