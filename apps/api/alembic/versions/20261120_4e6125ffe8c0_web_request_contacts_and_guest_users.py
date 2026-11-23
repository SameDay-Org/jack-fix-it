"""web request contacts and guest users

Revision ID: 4e6125ffe8c0
Revises: 2f18303b6287
Create Date: 2026-11-20 20:37:09.795392

#86: a request made on the web without an account. Expand-only:
- users.status takes 'guest' (the CHECK widened; #97's 'deleted' widens it again after this
  one and keeps 'guest');
- web_request_contacts: the request's contact, staff only, one row per request, with the
  Idempotency-Key's unique index.

The downgrade drops the contacts and narrows the CHECK back. It refuses while a guest exists:
their requests would have to be removed first, by hand, which this migration never does.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4e6125ffe8c0"
down_revision: str | Sequence[str] | None = "2f18303b6287"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CHECK = "ck_users_user_status"


def upgrade() -> None:
    op.drop_constraint(op.f(STATUS_CHECK), "users", type_="check")
    op.create_check_constraint(
        op.f(STATUS_CHECK), "users", "status IN ('active', 'suspended', 'guest')"
    )
    op.create_table(
        "web_request_contacts",
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("first_name", sa.String(length=60), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("phone", sa.String(length=20), nullable=False),
        sa.Column("consent_version", sa.String(length=64), nullable=False),
        sa.Column(
            "consented_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.Uuid(), nullable=False),
        sa.Column("idempotency_fingerprint", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "email = lower(email)", name=op.f("ck_web_request_contacts_email_lowercase")
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["service_requests.id"],
            name=op.f("fk_web_request_contacts_request_id_service_requests"),
        ),
        sa.PrimaryKeyConstraint("request_id", name=op.f("pk_web_request_contacts")),
        sa.UniqueConstraint(
            "idempotency_key", name=op.f("uq_web_request_contacts_idempotency_key")
        ),
    )


def downgrade() -> None:
    guests = op.get_bind().execute(sa.text("SELECT count(*) FROM users WHERE status = 'guest'"))
    if guests.scalar_one():
        raise RuntimeError(
            "guest users exist (web requests, #86): remove their requests before downgrading"
        )
    op.drop_table("web_request_contacts")
    op.drop_constraint(op.f(STATUS_CHECK), "users", type_="check")
    op.create_check_constraint(op.f(STATUS_CHECK), "users", "status IN ('active', 'suspended')")
