"""Send one synthetic error to Sentry, to prove the service reports there (#397).

Run as `python -m scripts.sentry_smoke` from a shell with the service's variables (`railway
ssh` into the api or the worker). Safe in any environment: it sends one event and touches
nothing else, and there is no HTTP route for it (an error route would be an abuse and noise
surface).

Sentry starts as the service starts it (app.observability.init_sentry: no PII, no local
variables, the same before_send scrubbing). The event is a RuntimeError raised two calls deep,
so its stack trace has real frames, tagged smoke=true, in the APP_ENV environment. No request,
no user, no database, and no host name (see _without_server_name): the only network call is
Sentry's own. Of the settings it reads only SENTRY_DSN and APP_ENV, through init_sentry.

Prints one line: the event id, the environment and the DSN's host (the ingest host, which
names the Sentry organization's region), never the DSN or its key. Exit codes:

- 0: Sentry accepted the event within FLUSH_TIMEOUT_SECONDS (its answer was a 2xx). If the
  issue does not then appear in Sentry, look at the project and its inbound filters: the
  delivery itself worked.
- 1: SENTRY_DSN is not set; nothing is initialized or sent.
- 2: not delivered. Sentry could not be reached, or answered with an error (a wrong key or
  project, a rate limit: the SDK reports each as a dropped event); or the event was still
  unsent after FLUSH_TIMEOUT_SECONDS (Sentry slow or unreachable); or the client dropped it
  before sending.

The run ends its client without another wait: nothing is left for the SDK's exit handler,
which would otherwise wait again and print to stderr about the pending event.
"""

import sys
from typing import Final, NoReturn, TextIO
from urllib.parse import urlsplit

import sentry_sdk
from sentry_sdk.client import BaseClient
from sentry_sdk.transport import HttpTransportCore

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


def _without_server_name(client: BaseClient) -> None:
    """The SDK puts the machine's host name on each event (its server_name option defaults to
    socket.gethostname()). This synthetic event carries none: the option is unset on this
    script's client only, so the services' own events are as before (observability.py is
    unchanged)."""
    client.options["server_name"] = None


def _drops_of(client: BaseClient) -> list[str]:
    """The reasons the client's HTTP transport gives for each send it gives up on, as they
    come: "network" (Sentry unreachable), "status_403", "status_429", "status_500" (Sentry's
    answer), "self_rate_limits", "full_queue". The SDK reports them through the transport's
    on_dropped_event hook; it is wrapped here, on this client's transport only, and still
    called."""
    drops: list[str] = []
    transport = client.transport
    if isinstance(transport, HttpTransportCore):
        reported = transport.on_dropped_event

        def on_dropped_event(reason: str) -> None:
            drops.append(reason)
            reported(reason)

        # The SDK's hook for a dropped send is a method meant to be overridden; mypy forbids
        # assigning one on an instance (and reads the bound replacement as lacking `self`),
        # and a subclass would need init_sentry to change.
        transport.on_dropped_event = on_dropped_event  # type: ignore[method-assign, assignment]
    return drops


def _sent_within(timeout: float) -> bool:
    """Waits `timeout` seconds at the most for the client to send what it holds; True when
    nothing is left unsent."""
    sentry_sdk.flush(timeout=timeout)
    pending: list[int] = []
    sentry_sdk.flush(
        timeout=PENDING_CHECK_SECONDS, callback=lambda count, _timeout: pending.append(count)
    )
    return not pending


def _smoke(client: BaseClient, settings: Settings, out: TextIO, flush_timeout: float) -> int:
    _without_server_name(client)
    drops = _drops_of(client)
    event_id = _capture_smoke_error()
    where = f"environment {settings.app_env}, host {urlsplit(settings.sentry_dsn or '').hostname}"
    if event_id is None:
        print(f"Sentry's client dropped the smoke event before sending it ({where}).", file=out)
        return 2
    sent = _sent_within(flush_timeout)
    if drops:
        reasons = ", ".join(dict.fromkeys(drops))
        print(f"Smoke event {event_id} not delivered: {reasons} ({where}).", file=out)
        return 2
    if not sent:
        print(f"Smoke event {event_id} not sent within {flush_timeout:g} s ({where}).", file=out)
        return 2
    print(f"Smoke event {event_id} sent ({where}).", file=out)
    return 0


def run(settings: Settings, out: TextIO, flush_timeout: float = FLUSH_TIMEOUT_SECONDS) -> int:
    if not settings.sentry_dsn:
        print(NO_DSN, file=out)
        return 1
    init_sentry(settings)
    client = sentry_sdk.get_client()
    try:
        return _smoke(client, settings, out, flush_timeout)
    finally:
        # No second wait: the bound above was the only one. A send still held is abandoned
        # with the transport, and the SDK's exit handler finds nothing to wait for or print.
        client.close(timeout=0)


def main() -> None:
    sys.exit(run(get_settings(), sys.stdout))


if __name__ == "__main__":
    main()
