"""Child process of tests/test_sentry_smoke.py: scripts.sentry_smoke's main() in a process of its
own, as `python -m scripts.sentry_smoke` runs it, with Sentry's send held (never answered) and
the bound shortened to FLUSH_SECONDS. No network: the transport is in memory.

Writes to the file named by argv[1] how many seconds the interpreter took to exit once main()
had ended, read by an exit handler that runs after the SDK's own (registered first: exit
handlers run last in, first out, and the SDK registers its handler when Sentry starts).
"""

import atexit
import functools
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import sentry_sdk

from scripts import sentry_smoke
from tests.conftest import make_settings
from tests.test_sentry_smoke import DSN, WorkerTransport

FLUSH_SECONDS = 0.2
_main_ended: list[float] = []


def _write_exit_seconds() -> None:
    seconds = time.monotonic() - _main_ended[0]
    Path(sys.argv[1]).write_text(f"{seconds:.3f}", encoding="utf-8")


def _run() -> None:
    transport = WorkerTransport()  # never answered: kill() leaves the send held
    real_init = sentry_sdk.init

    def init_to_memory(*args: Any, **kwargs: Any) -> object:
        return real_init(*args, transport=transport, **kwargs)

    with (
        patch.object(sentry_sdk, "init", init_to_memory),
        patch.object(sentry_smoke, "get_settings", lambda: make_settings(sentry_dsn=DSN)),
        patch.object(
            sentry_smoke,
            "run",
            functools.partial(sentry_smoke.run, flush_timeout=FLUSH_SECONDS),
        ),
    ):
        try:
            sentry_smoke.main()
        finally:
            _main_ended.append(time.monotonic())


if __name__ == "__main__":
    atexit.register(_write_exit_seconds)
    _run()
