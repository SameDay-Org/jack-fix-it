import importlib
from collections.abc import Iterator
from types import ModuleType

import pytest

from app.config import get_settings


@pytest.fixture
def worker_module(monkeypatch: pytest.MonkeyPatch) -> Iterator[ModuleType]:
    # WorkerSettings reads REDIS_URL at import time, like the real `arq` process does.
    monkeypatch.setenv("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    get_settings.cache_clear()
    import app.worker

    yield importlib.reload(app.worker)
    get_settings.cache_clear()


def test_worker_registers_at_least_one_function(worker_module: ModuleType) -> None:
    # ARQ refuses to start with zero functions.
    assert worker_module.WorkerSettings.functions


async def test_ping_task_answers_pong(worker_module: ModuleType) -> None:
    assert await worker_module.ping({}) == "pong"
