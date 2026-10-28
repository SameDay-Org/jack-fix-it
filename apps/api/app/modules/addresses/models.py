import uuid
from decimal import Decimal

from sqlalchemy import ForeignKey, Index, Numeric, String, false, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin


class Address(IdTimestampsMixin, Base):
    __tablename__ = "addresses"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    line1: Mapped[str] = mapped_column(String(255))
    line2: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str] = mapped_column(String(128))
    state: Mapped[str] = mapped_column(String(2))
    zip_code: Mapped[str] = mapped_column(String(10), index=True)
    # Filled by geocoding later.
    lat: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))


class SavedAddress(IdTimestampsMixin, Base):
    """A customer's address book entry (D8.2, #214): a few named addresses, one of them the
    default. Never a request's address: POST /requests snapshots its own `addresses` row, so
    editing or deleting a saved address changes no request and nothing a pro sees."""

    __tablename__ = "saved_addresses"
    __table_args__ = (
        # At most one default per user, enforced here and not only by the service's lock.
        Index(
            "uq_saved_addresses_user_id_default",
            "user_id",
            unique=True,
            postgresql_where=text("is_default"),
        ),
        # Labels are unique per user ignoring case: "Home" and "home" are the same entry.
        Index(
            "uq_saved_addresses_user_id_lower_label",
            "user_id",
            text("lower(label)"),
            unique=True,
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    # The owner's own text ("Home", "Casa 2"). The BDC panel shows it later, so no contacts
    # (schemas.AddressLabel).
    label: Mapped[str] = mapped_column(String(30))
    line1: Mapped[str] = mapped_column(String(255))
    line2: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str] = mapped_column(String(128))
    state: Mapped[str] = mapped_column(String(2))
    zip_code: Mapped[str] = mapped_column(String(10))
    # Set by the app ("Use my location", #215); NULL until then.
    lat: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    is_default: Mapped[bool] = mapped_column(server_default=false())
