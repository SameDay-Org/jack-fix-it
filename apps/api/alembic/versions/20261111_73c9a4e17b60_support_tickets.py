"""support tickets

Revision ID: 73c9a4e17b60
Revises: 5286e0060e55
Create Date: 2026-11-11 13:42:42.840506

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "73c9a4e17b60"
down_revision: str | Sequence[str] | None = "5286e0060e55"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "support_tickets"


def upgrade() -> None:
    # "Talk to Jack" (#274): one message from a customer or a pro to the team. Expand only:
    # Railway runs this in the pre-deploy step while the previous API keeps serving (and keeps
    # serving if the new one fails). That version neither reads nor writes this table, and no
    # table it knows changes. Enums are varchar(32) plus one named CHECK each (ADR 0007).
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("topic", sa.String(length=32), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="open", nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("app_version", sa.String(length=32), nullable=True),
        sa.Column("platform", sa.String(length=32), nullable=True),
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
        sa.CheckConstraint("role IN ('customer', 'pro')", name=op.f("ck_support_tickets_role")),
        sa.CheckConstraint(
            "topic IN ('account', 'payment', 'job', 'safety', 'app_problem', 'other')",
            name=op.f("ck_support_tickets_topic"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'in_progress', 'closed')", name=op.f("ck_support_tickets_status")
        ),
        sa.CheckConstraint(
            "platform IN ('ios', 'android')", name=op.f("ck_support_tickets_platform")
        ),
        sa.CheckConstraint(
            "char_length(message) BETWEEN 1 AND 2000",
            name=op.f("ck_support_tickets_message_length"),
        ),
        sa.CheckConstraint(
            "message ~ '[^[:space:]]'", name=op.f("ck_support_tickets_message_not_blank")
        ),
        sa.CheckConstraint(
            "(status = 'closed') = (closed_at IS NOT NULL)",
            name=op.f("ck_support_tickets_closed_at_matches_status"),
        ),
        sa.CheckConstraint(
            "char_length(app_version) BETWEEN 1 AND 32",
            name=op.f("ck_support_tickets_app_version_length"),
        ),
        sa.ForeignKeyConstraint(
            ["job_id"], ["jobs.id"], name=op.f("fk_support_tickets_job_id_jobs")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_support_tickets_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_tickets")),
    )
    # The writer's own list, newest first; also serves the user_id foreign key.
    op.create_index("ix_support_tickets_user_id_created_at", TABLE, ["user_id", "created_at", "id"])
    # The staff list, newest first: one status, or all of them.
    op.create_index("ix_support_tickets_status_created_at", TABLE, ["status", "created_at", "id"])
    op.create_index("ix_support_tickets_created_at", TABLE, ["created_at", "id"])
    op.create_index(op.f("ix_support_tickets_job_id"), TABLE, ["job_id"])


def downgrade() -> None:
    # Destructive: the tickets go with the table (the code before #274 never reads it). The
    # audit_log rows of their status changes stay (append-only; they name the ticket by id, not
    # by a foreign key). The table's constraints and indexes go with it.
    op.drop_table(TABLE)
