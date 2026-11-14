"""Send one synthetic error to Sentry, to prove the service reports there (#397).

Run as `python -m scripts.sentry_smoke` from a shell with the service's variables (`railway
ssh` into the api or the worker). Safe in any environment: it sends one event and touches
nothing else, and there is no HTTP route for it (an error route would be an abuse and noise
surface).

Sentry starts as the service starts it (app.observability.init_sentry: no PII, no local
variables, the same before_send scrubbing). The event is a RuntimeError raised two calls deep,
so its stack trace has real frames, tagged smoke=true, in the APP_ENV environment. No request,
no user, no database: the only network call is Sentry's own. Of the settings it reads only
SENTRY_DSN and APP_ENV, through init_sentry.

Prints one line: the event id, the environment and the DSN's host (the ingest host, which
names the Sentry organization's region), never the DSN or its key. Exit codes:

- 0: Sentry's client sent the event within FLUSH_TIMEOUT_SECONDS. Sentry answers a wrong key
  or project by dropping the event, which the client does not report: the proof is the issue
  `RuntimeError: sentry smoke test (safe to resolve)` appearing in Sentry.
- 1: SENTRY_DSN is not set; nothing is initialized or sent.
- 2: the event was not sent within FLUSH_TIMEOUT_SECONDS (Sentry slow or unreachable), or the
  client dropped it before sending.
"""

import sys
from typing import Final, NoReturn, TextIO
from urllib.parse import urlsplit

import sentry_sdk

from app.config import Settings, get_settings
from app.observability import init_sentry

SMOKE_MESSAGE: Final = "sentry smoke test (safe to resolve)"
SMOKE_TAG: Final = ("smoke", "true")
# The brief fixes the wait (sentry_sdk.flush(timeout=10)); no other setting is read.
FLUSH_TIMEOUT_SECONDS: Final = 10.0
# After the flush, a second one this short asks the client what is still unsent: its callback
# runs only for events still pending (sentry_sdk.flush returns nothing).
PENDING_CHECK_SECONDS: Final = 0.1
NO_DSN: Final = "SENTRY_DSN is not set: nothing sent"


def _raise_smoke_error() -> NoReturn:
    raise RuntimeError(SMOKE_MESSAGE)


def _fail_one_call_down() -> NoReturn:
    _raise_smoke_error()


def _capture_smoke_error() -> str | None:
    """The event id, or None when the client dropped the event before sending it."""
    try:
        _fail_one_call_down()
    except RuntimeError as error:
        key, value = SMOKE_TAG
        return sentry_sdk.capture_exception(error, tags={key: value})


def _sent_within(timeout: float) -> bool:
    """Waits `timeout` seconds at the most for the client to send what it holds; True when
    nothing is left unsent."""
    sentry_sdk.flush(timeout=timeout)
    pending: list[int] = []
    sentry_sdk.flush(
        timeout=PENDING_CHECK_SECONDS, callback=lambda count, _timeout: pending.append(count)
    )
    return not pending


def run(settings: Settings, out: TextIO, flush_timeout: float = FLUSH_TIMEOUT_SECONDS) -> int:
    if not settings.sentry_dsn:
        print(NO_DSN, file=out)
        return 1
    init_sentry(settings)
    event_id = _capture_smoke_error()
    where = f"environment {settings.app_env}, host {urlsplit(settings.sentry_dsn).hostname}"
    if event_id is None:
        print(f"Sentry's client dropped the smoke event before sending it ({where}).", file=out)
        return 2
    if not _sent_within(flush_timeout):
        print(f"Smoke event {event_id} not sent within {flush_timeout:g} s ({where}).", file=out)
        return 2
    print(f"Smoke event {event_id} sent ({where}).", file=out)
    return 0


def main() -> None:
    sys.exit(run(get_settings(), sys.stdout))


if __name__ == "__main__":
    main()
