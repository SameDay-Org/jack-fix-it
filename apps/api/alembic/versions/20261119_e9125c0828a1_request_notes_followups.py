"""request_notes and request_followups: the BDC's internal notes and follow-ups (#82)

Revision ID: e9125c0828a1
Revises: 976a3b246655
Create Date: 2026-11-19 14:00:00.000000

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e9125c0828a1"
down_revision: str | Sequence[str] | None = "976a3b246655"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column[datetime]]:
    return [
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
    ]


def upgrade() -> None:
    # Expand only: two new tables, which the previous API and worker (serving during Railway's
    # pre-deploy step) neither read nor write. Nothing on service_requests changes: marking a
    # request contacted writes its existing first_contact_at, and the audit row says who.
    # A staff member's internal note on a request (#82): plain text, staff only, never shown to
    # the customer or the pro. Appended only: the app has no path that changes or deletes one.
    op.create_table(
        "request_notes",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "char_length(body) BETWEEN 1 AND 2000", name=op.f("ck_request_notes_body_length")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_request_notes_request_id_service_requests"),
        ),
        sa.ForeignKeyConstraint(
            ["author_id"], ["users.id"], name=op.f("fk_request_notes_author_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_request_notes")),
    )
    op.create_index(
        op.f("ix_request_notes_request_id_created_at"),
        "request_notes",
        ["request_id", "created_at"],
        unique=False,
    )
    # A follow-up a staff member is to do on a request by a time (#82); done once.
    op.create_table(
        "request_followups",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("assigned_to", sa.Uuid(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("done_by", sa.Uuid(), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "char_length(note) BETWEEN 1 AND 500", name=op.f("ck_request_followups_note_length")
        ),
        sa.CheckConstraint(
            "(done_at IS NULL) = (done_by IS NULL)", name=op.f("ck_request_followups_done_by_whom")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_request_followups_request_id_service_requests"),
        ),
        sa.ForeignKeyConstraint(
            ["assigned_to"], ["users.id"], name=op.f("fk_request_followups_assigned_to_users")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_request_followups_created_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["done_by"], ["users.id"], name=op.f("fk_request_followups_done_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_request_followups")),
    )
    op.create_index(
        op.f("ix_request_followups_request_id"), "request_followups", ["request_id"], unique=False
    )
    # "Mine, due by the end of today": a staff member's open follow-ups by due time.
    op.create_index(
        op.f("ix_request_followups_open_assignee_due"),
        "request_followups",
        ["assigned_to", "due_at", "id"],
        unique=False,
        postgresql_where=sa.text("done_at IS NULL"),
    )


def downgrade() -> None:
    # Drops both tables and every note and follow-up in them. Take a backup first on any
    # database that holds real ones.
    op.drop_index(op.f("ix_request_followups_open_assignee_due"), table_name="request_followups")
    op.drop_index(op.f("ix_request_followups_request_id"), table_name="request_followups")
    op.drop_table("request_followups")
    op.drop_index(op.f("ix_request_notes_request_id_created_at"), table_name="request_notes")
    op.drop_table("request_notes")
