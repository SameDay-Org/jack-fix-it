"""payments: the card that paid and when the receipt email went out (#62)

Revision ID: 65e7971f089a
Revises: d128d274eb0a
Create Date: 2026-11-20 00:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "65e7971f089a"
down_revision: str | Sequence[str] | None = "d128d274eb0a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "payments"
LAST4_CHECK = "ck_payments_card_last4_four_digits"


def upgrade() -> None:
    # Expand only: four nullable columns and a CHECK that holds for NULL, so every existing row
    # stays valid, and the previous API and worker (serving during Railway's pre-deploy step)
    # keep inserting and updating payments without knowing the columns.
    op.add_column(TABLE, sa.Column("card_brand", sa.String(length=32), nullable=True))
    op.add_column(TABLE, sa.Column("card_last4", sa.CHAR(length=4), nullable=True))
    op.add_column(TABLE, sa.Column("wallet", sa.String(length=32), nullable=True))
    op.add_column(TABLE, sa.Column("receipt_emailed_at", sa.DateTime(timezone=True), nullable=True))
    # op.f: the name is final, so the naming convention adds no second prefix.
    op.create_check_constraint(op.f(LAST4_CHECK), TABLE, "card_last4 ~ '^[0-9]{4}$'")


def downgrade() -> None:
    # Drops what the receipt knew of each payment's card, and when each receipt email went out
    # (a later upgrade sends none again: the worker sends only for a payment that just
    # succeeded). Nothing about the money itself.
    op.drop_constraint(op.f(LAST4_CHECK), TABLE, type_="check")
    op.drop_column(TABLE, "receipt_emailed_at")
    op.drop_column(TABLE, "wallet")
    op.drop_column(TABLE, "card_last4")
    op.drop_column(TABLE, "card_brand")
