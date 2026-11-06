"""user card fields

Revision ID: b3e5a9c17d42
Revises: ff6a71f4a729
Create Date: 2026-11-05 12:00:00.000000

"""

import secrets
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3e5a9c17d42"
down_revision: str | Sequence[str] | None = "ff6a71f4a729"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The ID card's public code (#250, app.modules.users.public_codes): 8 characters of Crockford
# base32 (0-9, A-Z without I, L, O, U), drawn with the CSPRNG, unique, never derived from the
# id. The alphabet, the pattern and the state codes are repeated here on purpose: a migration
# must not change when the app does (tests/test_schema_user_card_fields.py keeps them equal).
PUBLIC_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PUBLIC_CODE_LENGTH = 8
PUBLIC_CODE_PATTERN = "^[0-9A-HJKMNP-TV-Z]{8}$"
# The 50 states and the District of Columbia (app.modules.users.locations.US_STATE_CODES).
US_STATE_CODES = (
    "AK", "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "IA", "ID",
    "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC",
    "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
    "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY",
)  # fmt: skip

users = sa.table("users", sa.column("id", sa.Uuid()), sa.column("public_code", sa.String()))


def upgrade() -> None:
    # Nullable first: the rows that exist get their codes below, then the column tightens.
    op.add_column("users", sa.Column("public_code", sa.String(length=8), nullable=True))
    # The card's city and state (both or neither), and the ID photo's upload key.
    op.add_column("users", sa.Column("home_city", sa.String(length=80), nullable=True))
    op.add_column("users", sa.Column("home_state", sa.String(length=2), nullable=True))
    op.add_column("users", sa.Column("photo_key", sa.String(length=512), nullable=True))
    _backfill_public_codes()
    op.alter_column("users", "public_code", existing_type=sa.String(length=8), nullable=False)
    op.create_unique_constraint(op.f("uq_users_public_code"), "users", ["public_code"])
    op.create_check_constraint(
        op.f("ck_users_public_code_crockford"), "users", f"public_code ~ '{PUBLIC_CODE_PATTERN}'"
    )
    codes = ", ".join(f"'{code}'" for code in US_STATE_CODES)
    op.create_check_constraint(
        op.f("ck_users_home_state_us"), "users", f"home_state IS NULL OR home_state IN ({codes})"
    )
    op.create_check_constraint(
        op.f("ck_users_home_together"), "users", "(home_city IS NULL) = (home_state IS NULL)"
    )


def downgrade() -> None:
    # Destructive: the public codes, the home cities and states and the ID photo keys are
    # lost. A later upgrade draws new codes, so a card shown with an old one no longer matches,
    # and the photos' uploads become orphans for the sweep (#191).
    op.drop_constraint(op.f("ck_users_home_together"), "users", type_="check")
    op.drop_constraint(op.f("ck_users_home_state_us"), "users", type_="check")
    op.drop_constraint(op.f("ck_users_public_code_crockford"), "users", type_="check")
    op.drop_constraint(op.f("uq_users_public_code"), "users", type_="unique")
    op.drop_column("users", "photo_key")
    op.drop_column("users", "home_state")
    op.drop_column("users", "home_city")
    op.drop_column("users", "public_code")


def _backfill_public_codes() -> None:
    """A fresh random code for every user without one, distinct among themselves (the unique
    constraint created right after is the proof)."""
    connection = op.get_bind()
    statement = sa.select(users.c.id).where(users.c.public_code.is_(None))
    user_ids = connection.execute(statement).scalars().all()
    if not user_ids:
        return
    codes: set[str] = set()
    while len(codes) < len(user_ids):
        codes.add("".join(secrets.choice(PUBLIC_CODE_ALPHABET) for _ in range(PUBLIC_CODE_LENGTH)))
    connection.execute(
        users.update()
        .where(users.c.id == sa.bindparam("user_id", type_=sa.Uuid()))
        .values(public_code=sa.bindparam("code")),
        [{"user_id": user_id, "code": code} for user_id, code in zip(user_ids, codes, strict=True)],
    )
