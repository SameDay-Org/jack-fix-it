from sqlalchemy import CheckConstraint, String, false, text, true
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin


class Category(IdTimestampsMixin, Base):
    """Categories are data (seeded and edited in the admin), never literals in code."""

    __tablename__ = "categories"
    __table_args__ = (
        # English and Spanish are required; other locales (pt) may be added without a migration.
        CheckConstraint("names ? 'en' AND names ? 'es'", name="names_en_es"),
        CheckConstraint("reference_price_cents >= 0", name="reference_price_cents_non_negative"),
    )

    slug: Mapped[str] = mapped_column(String(64), unique=True)
    # Display name per locale, e.g. {"en": ..., "es": ...}.
    names: Mapped[dict[str, str]] = mapped_column(JSONB)
    icon: Mapped[str | None] = mapped_column(String(64))
    requires_license: Mapped[bool] = mapped_column(server_default=false())
    reference_price_cents: Mapped[int | None]
    intake_questions: Mapped[list[dict[str, object]]] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb")
    )
    active: Mapped[bool] = mapped_column(server_default=true(), index=True)
