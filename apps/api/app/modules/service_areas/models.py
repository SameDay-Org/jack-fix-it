from sqlalchemy import CHAR, Index, String, true
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdTimestampsMixin


class ServiceArea(IdTimestampsMixin, Base):
    """One served ZIP. Areas are data (seeded, later edited in the admin), never code literals:
    a new city or region is a new row, not a deploy."""

    __tablename__ = "service_areas"
    __table_args__ = (Index("ix_service_areas_region_city", "region", "city"),)

    region: Mapped[str] = mapped_column(String(64))
    city: Mapped[str] = mapped_column(String(128))
    state: Mapped[str] = mapped_column(CHAR(2))
    zip_code: Mapped[str] = mapped_column(String(10), unique=True)
    active: Mapped[bool] = mapped_column(server_default=true(), index=True)
