"""request_media

Revision ID: a382af4f9826
Revises: 7a3a8edfe6a4
Create Date: 2026-10-21 16:23:09.823870

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a382af4f9826"
down_revision: str | Sequence[str] | None = "7a3a8edfe6a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A photo or video attached to a service request (#42). Enum as varchar plus one named CHECK
    # (ADR 0007); the storage key is unique, so one uploaded file belongs to one request.
    op.create_table(
        "request_media",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("file_key", sa.String(length=256), nullable=False),
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
            "kind IN ('photo', 'video')", name=op.f("ck_request_media_request_media_kind")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_request_media_request_id_service_requests"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_request_media")),
        sa.UniqueConstraint("file_key", name=op.f("uq_request_media_file_key")),
    )
    op.create_index(op.f("ix_request_media_request_id"), "request_media", ["request_id"])


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes.
    op.drop_table("request_media")
