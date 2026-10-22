"""Seed the served areas: `uv run python -m scripts.seed_service_areas` from apps/api.

Idempotent: inserts the ZIPs of app/modules/service_areas/seed_data.json that are missing and
never changes an existing row, so it is safe to run on every deploy. The file holds South
Florida, with Broward active (#9); scripts/build_service_area_seed.py rebuilds it.
"""

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import create_engine, create_session_factory
from app.modules.service_areas.service import (
    SEED_DATA_PATH,
    SeedResult,
    ServiceAreaService,
    load_seed_data,
)


async def seed(
    session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]],
    path: Path = SEED_DATA_PATH,
) -> SeedResult:
    # Validated before the database is touched: an invalid file writes nothing.
    entries = load_seed_data(path)
    async with session_factory() as session:
        return await ServiceAreaService(session).seed(entries)


async def _run() -> SeedResult:
    engine = create_engine(get_settings())
    try:
        return await seed(create_session_factory(engine))
    finally:
        await engine.dispose()


def main() -> None:
    result = asyncio.run(_run())
    print(f"Service areas seeded: {result.inserted} inserted, {result.skipped} already present")


if __name__ == "__main__":
    main()
