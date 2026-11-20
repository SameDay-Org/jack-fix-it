"""account deletion (users.deleted_at, the deleted status, account_deletions) and the legal
documents' acceptances (terms_acceptances), #97

Revision ID: 9d282a60960f
Revises: 920fe99e6f1d
Create Date: 2026-11-20 12:10:06.900896

"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "9d282a60960f"
down_revision: str | Sequence[str] | None = "920fe99e6f1d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CHECK = "ck_users_user_status"
DELETED_CHECK = "ck_users_deleted_at_status"
PENDING = "storage_deleted_at IS NULL OR cards_detached_at IS NULL"


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
    # Expand only: Railway runs this in the pre-deploy step while the previous API and worker
    # keep serving. They write the statuses active and suspended only, which the new CHECK
    # still accepts, never deleted_at (NULL on every row, as the second CHECK wants), and they
    # neither read nor write the two new tables.
    op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_constraint(op.f(STATUS_CHECK), "users", type_="check")
    op.create_check_constraint(
        op.f(STATUS_CHECK), "users", "status IN ('active', 'suspended', 'deleted')"
    )
    op.create_check_constraint(
        op.f(DELETED_CHECK), "users", "(status = 'deleted') = (deleted_at IS NOT NULL)"
    )
    # The worker's cleanup of a deleted account: its cards in Stripe, its files in storage.
    op.create_table(
        "account_deletions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("storage_keys", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("storage_settled_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column("storage_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cards_detached_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(length=64), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "attempts >= 0", name=op.f("ck_account_deletions_attempts_not_negative")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_account_deletions_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_account_deletions")),
        sa.UniqueConstraint("user_id", name=op.f("uq_account_deletions_user_id")),
    )
    op.create_index(
        "ix_account_deletions_pending",
        "account_deletions",
        ["last_attempt_at"],
        unique=False,
        postgresql_where=sa.text(PENDING),
    )
    # Which version of each legal document an account accepted, and when.
    op.create_table(
        "terms_acceptances",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        *_timestamps(),
        sa.CheckConstraint(
            "kind IN ('terms', 'privacy', 'pro_agreement')",
            name=op.f("ck_terms_acceptances_terms_kind"),
        ),
        sa.CheckConstraint(
            "version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'",
            name=op.f("ck_terms_acceptances_version_id"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_terms_acceptances_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_terms_acceptances")),
        sa.UniqueConstraint(
            "user_id", "kind", "version", name=op.f("uq_terms_acceptances_user_id")
        ),
    )
    op.create_index(
        op.f("ix_terms_acceptances_user_id"), "terms_acceptances", ["user_id"], unique=False
    )


def downgrade() -> None:
    # Fails while a deleted account exists: its status has no place in the old CHECK, and such
    # an account cannot become active again (it is anonymised).
    op.drop_index(op.f("ix_terms_acceptances_user_id"), table_name="terms_acceptances")
    op.drop_table("terms_acceptances")
    op.drop_index(
        "ix_account_deletions_pending",
        table_name="account_deletions",
        postgresql_where=sa.text(PENDING),
    )
    op.drop_table("account_deletions")
    op.drop_constraint(op.f(DELETED_CHECK), "users", type_="check")
    op.drop_constraint(op.f(STATUS_CHECK), "users", type_="check")
    op.create_check_constraint(op.f(STATUS_CHECK), "users", "status IN ('active', 'suspended')")
    op.drop_column("users", "deleted_at")
