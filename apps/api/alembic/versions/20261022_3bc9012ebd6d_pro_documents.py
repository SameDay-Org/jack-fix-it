"""pro_documents

Revision ID: 3bc9012ebd6d
Revises: 9072864e3137
Create Date: 2026-10-22 00:12:42.864569

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3bc9012ebd6d"
down_revision: str | Sequence[str] | None = "9072864e3137"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A pro's verification documents (#37): ID, license, insurance, reviewed by an admin (#41).
    # Enums as varchar plus one named CHECK each (ADR 0007); an index on every foreign key; one
    # uploaded file is one document (unique key).
    op.create_table(
        "pro_documents",
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
        sa.Column("pro_id", sa.Uuid(), nullable=False),
        sa.Column("doc_type", sa.String(length=32), nullable=False),
        sa.Column("file_key", sa.String(length=256), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("expires_on", sa.Date(), nullable=True),
        sa.Column("reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "doc_type IN ('id', 'license', 'insurance')",
            name=op.f("ck_pro_documents_pro_document_type"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'superseded')",
            name=op.f("ck_pro_documents_pro_document_status"),
        ),
        sa.ForeignKeyConstraint(
            ["pro_id"], ["pro_profiles.id"], name=op.f("fk_pro_documents_pro_id_pro_profiles")
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by"], ["users.id"], name=op.f("fk_pro_documents_reviewed_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pro_documents")),
        sa.UniqueConstraint("file_key", name=op.f("uq_pro_documents_file_key")),
    )
    op.create_index(op.f("ix_pro_documents_pro_id"), "pro_documents", ["pro_id"])
    op.create_index(op.f("ix_pro_documents_reviewed_by"), "pro_documents", ["reviewed_by"])
    op.create_index(op.f("ix_pro_documents_status"), "pro_documents", ["status"])
    op.create_index("ix_pro_documents_pro_id_doc_type", "pro_documents", ["pro_id", "doc_type"])


def downgrade() -> None:
    # Dropping the table drops its constraints and indexes.
    op.drop_table("pro_documents")
