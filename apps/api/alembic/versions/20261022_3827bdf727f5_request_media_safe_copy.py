"""request media safe copy

Revision ID: 3827bdf727f5
Revises: 2c68b44ae557
Create Date: 2026-10-22 13:45:20.357893

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3827bdf727f5"
down_revision: str | Sequence[str] | None = "2c68b44ae557"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # #173: the privacy-safe copy of each request photo and video, made by the worker. Existing
    # rows become pending (the server default); nothing backfills them in this change.
    op.add_column("request_media", sa.Column("safe_key", sa.String(length=256), nullable=True))
    op.add_column(
        "request_media",
        sa.Column("safe_status", sa.String(length=32), server_default="pending", nullable=False),
    )
    op.add_column(
        "request_media", sa.Column("safe_content_type", sa.String(length=64), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_request_media_media_safe_status"),
        "request_media",
        "safe_status IN ('pending', 'ready', 'failed')",
    )
    op.create_unique_constraint(op.f("uq_request_media_safe_key"), "request_media", ["safe_key"])
    op.create_index(op.f("ix_request_media_safe_status"), "request_media", ["safe_status"])


def downgrade() -> None:
    # Drops the safe copies' keys and states (the copies stay in storage, unreferenced).
    # Dropping the columns drops their constraint and index.
    op.drop_column("request_media", "safe_content_type")
    op.drop_column("request_media", "safe_status")
    op.drop_column("request_media", "safe_key")
