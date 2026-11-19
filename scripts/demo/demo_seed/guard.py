"""Where the demo seed may run: a local, throwaway `jackdemo*` database and nothing else.

The seed writes fixture accounts with a known password and, on `--reset`, drops the database.
So the checks come before anything connects: the host is this machine, the database's name
starts with `jackdemo`, the environment is not staging or production, and a Stripe key, when
one is set, is a TEST key. A refusal changes nothing.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Final

from alembic import command
from alembic.config import Config
from sqlalchemy import URL, make_url, pool, text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.config import Settings

LOCAL_HOSTS: Final = frozenset({"localhost", "127.0.0.1", "::1"})
DATABASE_PREFIX: Final = "jackdemo"
DEPLOYED_ENVIRONMENTS: Final = frozenset({"staging", "production"})
STRIPE_TEST_PREFIX: Final = "sk_test_"
API_DIR: Final = Path(__file__).resolve().parents[3] / "apps" / "api"


class DemoGuardError(Exception):
    """The seed refused to run here. The message never holds a credential."""


def demo_database_url(database_url: str) -> URL:
    """`database_url` parsed, when it names a local `jackdemo*` database; else a refusal."""
    url = make_url(database_url)
    if url.host not in LOCAL_HOSTS:
        raise DemoGuardError(
            "refusing: DATABASE_URL's host is not this machine (localhost or 127.0.0.1)"
        )
    name = url.database or ""
    if not name.startswith(DATABASE_PREFIX):
        raise DemoGuardError(
            f"refusing: the database's name must start with '{DATABASE_PREFIX}' "
            "(a throwaway demo database)"
        )
    return url


def check_settings(settings: Settings) -> URL:
    """Every guard on the loaded settings; the demo database's URL when they all pass."""
    url = demo_database_url(settings.database_url)
    if settings.app_env in DEPLOYED_ENVIRONMENTS:
        raise DemoGuardError(f"refusing: APP_ENV is {settings.app_env}")
    key = settings.stripe_secret_key
    if key is not None and not key.get_secret_value().startswith(STRIPE_TEST_PREFIX):
        raise DemoGuardError("refusing: STRIPE_SECRET_KEY is not a TEST key (sk_test_...)")
    return url


async def recreate_database(url: URL, *, drop: bool) -> bool:
    """Creates the demo database when it is missing; with `drop`, drops it first. True when a
    database was created."""
    if drop:
        await drop_database(url)
    async with _maintenance(url) as connection:
        exists = await connection.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": url.database}
        )
        if exists:
            return False
        name = connection.dialect.identifier_preparer.quote(str(url.database))
        await connection.execute(text(f"CREATE DATABASE {name}"))
        return True


async def drop_database(url: URL) -> None:
    """Drops the demo database, ending its connections. Nothing when it does not exist."""
    async with _maintenance(url) as connection:
        name = connection.dialect.identifier_preparer.quote(str(url.database))
        await connection.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))


@asynccontextmanager
async def _maintenance(url: URL) -> AsyncIterator[AsyncConnection]:
    """A connection to the server's `postgres` database, for a `url` that passes the guard.
    CREATE and DROP DATABASE cannot run inside a transaction, hence AUTOCOMMIT."""
    demo_database_url(url.render_as_string(hide_password=False))
    engine = create_async_engine(
        url.set(database="postgres"), isolation_level="AUTOCOMMIT", poolclass=pool.NullPool
    )
    try:
        async with engine.connect() as connection:
            yield connection
    finally:
        await engine.dispose()


def migrate(url: URL) -> None:
    """`alembic upgrade head` on the demo database. Sync: alembic's env runs its own loop."""
    # No ini file, so alembic/env.py does not reconfigure logging.
    config = Config()
    config.set_main_option("script_location", str(API_DIR / "alembic"))
    config.attributes["database_url"] = url.render_as_string(hide_password=False)
    command.upgrade(config, "head")
