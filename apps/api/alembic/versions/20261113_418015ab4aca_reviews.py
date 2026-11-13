"""reviews

Revision ID: 418015ab4aca
Revises: f0de579f4b29
Create Date: 2026-11-13 06:58:31.396749

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "418015ab4aca"
down_revision: str | Sequence[str] | None = "f0de579f4b29"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "reviews"
RATINGS = ("overall", "communication", "quality", "punctuality", "value")


def upgrade() -> None:
    # Two-sided reviews (#77): one review per side per job, written once the job is confirmed.
    # Expand only: Railway runs this in the pre-deploy step while the previous API keeps
    # serving (and keeps serving if the new one fails). That version neither reads nor writes
    # this table, and no table it knows changes. Enums are varchar(32) plus one named CHECK
    # (ADR 0007).
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("author_role", sa.String(length=32), nullable=False),
        sa.Column("overall", sa.SmallInteger(), nullable=False),
        sa.Column("communication", sa.SmallInteger(), nullable=True),
        sa.Column("quality", sa.SmallInteger(), nullable=True),
        sa.Column("punctuality", sa.SmallInteger(), nullable=True),
        sa.Column("value", sa.SmallInteger(), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
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
            "author_role IN ('customer', 'pro')", name=op.f("ck_reviews_author_role")
        ),
        *(
            sa.CheckConstraint(f"{column} BETWEEN 1 AND 5", name=op.f(f"ck_reviews_{column}_range"))
            for column in RATINGS
        ),
        sa.CheckConstraint(
            "char_length(comment) BETWEEN 1 AND 1000", name=op.f("ck_reviews_comment_length")
        ),
        sa.CheckConstraint("author_id <> target_id", name=op.f("ck_reviews_author_is_not_target")),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], name=op.f("fk_reviews_job_id_jobs")),
        sa.ForeignKeyConstraint(
            ["author_id"], ["users.id"], name=op.f("fk_reviews_author_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["users.id"], name=op.f("fk_reviews_target_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reviews")),
        # One review per side per job; also serves the job_id foreign key.
        sa.UniqueConstraint("job_id", "author_id", name=op.f("uq_reviews_job_id")),
    )
    op.create_index(op.f("ix_reviews_author_id"), TABLE, ["author_id"])
    # A user's rating and their reviews newest first; also serves the target_id foreign key.
    op.create_index(
        "ix_reviews_target_id_created_at",
        TABLE,
        ["target_id", sa.literal_column("created_at DESC")],
    )


def downgrade() -> None:
    # Destructive: the reviews go with the table (the code before #77 never reads it). Its
    # constraints and indexes go with it.
    op.drop_table(TABLE)
