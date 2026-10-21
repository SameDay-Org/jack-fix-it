"""SQLAlchemy 2 async: declarative Base, engine and session factories, session dependency."""

import importlib
import importlib.util
import pkgutil
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, Enum, MetaData, func, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from starlette.requests import Request

from app.config import Settings

# Deterministic constraint names so Alembic autogenerate and downgrades stay stable.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# Varchar length of every enum column, so a longer value later only replaces the CHECK.
ENUM_LENGTH = 32


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class IdTimestampsMixin:
    """UUID primary key and created_at/updated_at, all set by Postgres (ADR 0007)."""

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


def str_enum(enum_class: type[StrEnum], name: str) -> Enum:
    """Enum stored as varchar plus a CHECK named ck_<table>_<name>, not a native PG enum."""
    return Enum(
        enum_class,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=ENUM_LENGTH,
        values_callable=lambda members: [member.value for member in members],
    )


def import_models() -> None:
    """Import app/modules/<domain>/models.py so Base.metadata holds every table."""
    import app.modules

    for module in pkgutil.iter_modules(app.modules.__path__):
        name = f"app.modules.{module.name}.models"
        if importlib.util.find_spec(name) is not None:
            importlib.import_module(name)


def create_engine(settings: Settings) -> AsyncEngine:
    # hide_parameters: database errors are logged, and their bound values can be PII or secrets.
    return create_async_engine(settings.database_url, pool_pre_ping=True, hide_parameters=True)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request. Services own commit/rollback."""
    session_factory: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with session_factory() as session:
        yield session
