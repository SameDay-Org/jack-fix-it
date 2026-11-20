"""Where the demo seed may run: a local, throwaway `jackdemo*` database and nothing else.

The seed writes fixture accounts with a known password, uploads a few hundred demo files and,
on `--reset`, drops the database. So the checks come before anything connects: the database is
on this machine and its name starts with `jackdemo`, the storage is on this machine too, the
environment is not staging or production, and a Stripe key, when one is set, is a TEST key. A
refusal changes nothing.

The database is judged by where the driver would really connect, not by how the URL reads:
SQLAlchemy lets a URL's query string override its host and database
(`...@localhost/jackdemo?host=elsewhere`), so a URL with any parameter is refused, and the
connection arguments the dialect builds are checked as well.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

from alembic import command
from alembic.config import Config
from sqlalchemy import URL, make_url, pool, text
from sqlalchemy.dialects.postgresql.asyncpg import dialect as asyncpg_dialect
from sqlalchemy.exc import ArgumentError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.config import Settings

LOCAL_HOSTS: Final = frozenset({"localhost", "127.0.0.1", "::1"})
DATABASE_PREFIX: Final = "jackdemo"
DEPLOYED_ENVIRONMENTS: Final = frozenset({"staging", "production"})
STRIPE_TEST_PREFIX: Final = "sk_test_"
API_DIR: Final = Path(__file__).resolve().parents[3] / "apps" / "api"


class DemoGuardError(Exception):
    """The seed refused to run here. The message never holds a credential."""


def demo_database_url(database_url: str | URL) -> URL:
    """`database_url` parsed, when a connection made from it reaches a local `jackdemo*`
    database; else a refusal."""
    try:
        url = make_url(database_url)
    except ArgumentError:
        raise DemoGuardError("refusing: DATABASE_URL is not a database URL") from None
    if url.query:
        raise DemoGuardError(
            "refusing: DATABASE_URL has parameters (after '?'), which can point the "
            "connection elsewhere; a demo URL is host, port and database only"
        )
    # What the driver would be given, whatever the URL's parts say.
    connect = _connect_arguments(url)
    if url.host not in LOCAL_HOSTS or connect.get("host") not in LOCAL_HOSTS:
        raise DemoGuardError(
            "refusing: DATABASE_URL's host is not this machine (localhost or 127.0.0.1)"
        )
    for name in (url.database, connect.get("database")):
        if not isinstance(name, str) or not name.startswith(DATABASE_PREFIX):
            raise DemoGuardError(
                f"refusing: the database's name must start with '{DATABASE_PREFIX}' "
                "(a throwaway demo database)"
            )
    return url


def _connect_arguments(url: URL) -> dict[str, object]:
    """What the API's driver dialect would hand asyncpg for `url`. No connection is made."""
    # SQLAlchemy does not annotate its dialect classes' constructor or this method: the two
    # calls below are the only untyped ones, and their result is read as plain objects.
    dialect = asyncpg_dialect()  # type: ignore[no-untyped-call]
    _, arguments = dialect.create_connect_args(url)  # type: ignore[no-untyped-call]
    return dict(arguments)


def check_settings(settings: Settings) -> URL:
    """Every guard on the loaded settings; the demo database's URL when they all pass."""
    url = demo_database_url(settings.database_url)
    if settings.app_env in DEPLOYED_ENVIRONMENTS:
        raise DemoGuardError(f"refusing: APP_ENV is {settings.app_env}")
    key = settings.stripe_secret_key
    if key is not None and not key.get_secret_value().startswith(STRIPE_TEST_PREFIX):
        raise DemoGuardError("refusing: STRIPE_SECRET_KEY is not a TEST key (sk_test_...)")
    storage = settings.s3_endpoint_url
    if storage is not None and urlsplit(storage).hostname not in LOCAL_HOSTS:
        raise DemoGuardError(
            "refusing: S3_ENDPOINT_URL is not on this machine (the seed uploads demo files)"
        )
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
    """A connection to the server's `postgres` database, for a `url` that passes the guard
    (checked again here: these statements never trust their caller). CREATE and DROP DATABASE
    cannot run inside a transaction, hence AUTOCOMMIT."""
    demo_database_url(url)
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
    demo_database_url(url)
    # No ini file, so alembic/env.py does not reconfigure logging.
    config = Config()
    config.set_main_option("script_location", str(API_DIR / "alembic"))
    config.attributes["database_url"] = url.render_as_string(hide_password=False)
    command.upgrade(config, "head")
