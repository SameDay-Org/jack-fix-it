"""scripts/sentry_smoke.py: one synthetic error proves the service reports to Sentry (#397).

Sentry sends to memory here (no network): MemoryTransport keeps each envelope, and the slow
transports below send through the SDK's own background worker, as its HTTP transport does,
so the flush and its pending callback are the SDK's.
"""

import io
import json
import socket
import sys
import threading
from collections.abc import Callable, Iterator
from typing import Any, cast

import pytest
import sentry_sdk
from sentry_sdk.envelope import Envelope
from sentry_sdk.transport import Transport
from sentry_sdk.worker import BackgroundWorker

from app import observability
from app.config import Settings
from scripts import sentry_smoke
from tests.conftest import make_settings
from tests.test_sentry_scrubbing import MemoryTransport

# Every part of it is distinctive, so a leak of any part is found. The line printed may name
# the host (the ingest host, with the organization's id); nothing else of the DSN is printed,
# and nothing of it is in what goes to Sentry.
DSN_KEY = "smokekeyb7f3e1"
DSN_HOST = "o4507291.ingest.us.sentry.example"
DSN_PROJECT = "8162534"
DSN = f"https://{DSN_KEY}@{DSN_HOST}/{DSN_PROJECT}"
NEVER_PRINTED = (DSN, DSN_KEY, f"/{DSN_PROJECT}", DSN_PROJECT)
NEVER_SENT = (*NEVER_PRINTED, DSN_HOST, "o4507291")
SMOKE_FRAMES = ["_capture_smoke_error", "_fail_one_call_down", "_raise_smoke_error"]


class WorkerTransport(MemoryTransport):
    """Sends on the SDK's background worker, each send held until `answered` is set (bounded,
    so a failing test cannot hang): Sentry slow, or not answering at all."""

    def __init__(self) -> None:
        super().__init__()
        self.answered = threading.Event()
        self.flushes: list[float] = []
        self._worker = BackgroundWorker()

    def capture_envelope(self, envelope: Envelope) -> None:
        def send() -> None:
            self.answered.wait(timeout=5)
            self.envelopes.append(envelope)

        self._worker.submit(send)

    def flush(self, timeout: float, callback: Any = None) -> None:
        self.flushes.append(timeout)
        self._worker.flush(timeout, callback)

    def kill(self) -> None:
        self.answered.set()
        self._worker.kill()


@pytest.fixture
def sentry_to(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[Transport], None]]:
    """Makes init_sentry's client send to the given transport. Disabled again afterwards, a
    held send answered first so that the client's close does not wait for it."""
    real_init = sentry_sdk.init
    installed: list[Transport] = []

    def install(transport: Transport) -> None:
        installed.append(transport)

        def init_with(*args: Any, **kwargs: Any) -> object:
            return real_init(*args, transport=transport, **kwargs)

        monkeypatch.setattr(sentry_sdk, "init", init_with)

    try:
        yield install
    finally:
        for transport in installed:
            if isinstance(transport, WorkerTransport):
                transport.answered.set()
        sentry_sdk.get_client().close()
        sentry_sdk.get_global_scope().set_client(None)


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any connection the run opens fails the test: Sentry's transport is the only network
    use, and it is in memory here."""

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError(f"network call: {args}")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


class ReadSettings:
    """Settings that record which of them are read."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.read: set[str] = set()

    def __getattr__(self, name: str) -> object:
        self.read.add(name)
        return getattr(self._settings, name)


def _smoke(settings: Settings, **kwargs: Any) -> tuple[int, str]:
    out = io.StringIO()
    code = sentry_smoke.run(settings, out, **kwargs)
    return code, out.getvalue()


def _events(transport: MemoryTransport) -> list[dict[str, Any]]:
    return [
        json.loads(item.get_bytes())
        for envelope in transport.envelopes
        for item in envelope
        if item.type == "event"
    ]


def _wire(transport: MemoryTransport) -> str:
    """Everything the transport was handed: each envelope's headers and items."""
    return "".join(
        json.dumps(envelope.headers) + "".join(item.get_bytes().decode() for item in envelope)
        for envelope in transport.envelopes
    )


def test_smoke_without_dsn_sends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    inits: list[dict[str, Any]] = []
    monkeypatch.setattr(sentry_sdk, "init", lambda *args, **kwargs: inits.append(kwargs))

    for dsn in (None, ""):
        code, printed = _smoke(make_settings(sentry_dsn=dsn))

        assert (code, printed) == (1, "SENTRY_DSN is not set: nothing sent\n")
    assert inits == []
    assert not sentry_sdk.get_client().is_active()


def test_main_exits_with_the_runs_code(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sentry_smoke, "get_settings", lambda: make_settings(sentry_dsn=None))

    with pytest.raises(SystemExit) as exit_:
        sentry_smoke.main()

    assert exit_.value.code == 1
    assert capsys.readouterr() == ("SENTRY_DSN is not set: nothing sent\n", "")


@pytest.mark.usefixtures("no_network")
def test_smoke_sends_one_tagged_event_with_a_stack(
    sentry_to: Callable[[Transport], None],
) -> None:
    transport = MemoryTransport()
    sentry_to(transport)

    code, printed = _smoke(make_settings(sentry_dsn=DSN, app_env="development"))

    assert code == 0
    [event] = _events(transport)
    assert len(transport.envelopes) == 1
    where = f"(environment development, host {DSN_HOST})"
    assert printed == f"Smoke event {event['event_id']} sent {where}.\n"
    [exception] = event["exception"]["values"]
    assert (exception["type"], exception["value"]) == (
        "RuntimeError",
        "sentry smoke test (safe to resolve)",
    )
    frames = exception["stacktrace"]["frames"]
    assert [frame["function"] for frame in frames] == SMOKE_FRAMES
    assert {frame["module"] for frame in frames} == {"scripts.sentry_smoke"}
    assert all("vars" not in frame for frame in frames)  # no local variable values
    assert event["tags"] == {"smoke": "true"}
    assert event["environment"] == "development"
    assert event["level"] == "error"
    # No request and no user. server_name is the SDK's default, the machine's host name (on
    # Railway the container's), as on every event of the service: not set by the script.
    assert "request" not in event
    assert "user" not in event
    assert event["server_name"] == socket.gethostname()
    assert event["breadcrumbs"] == {"values": []}


def test_smoke_reads_only_the_dsn_and_the_environment(
    sentry_to: Callable[[Transport], None],
) -> None:
    sentry_to(MemoryTransport())
    settings = ReadSettings(make_settings(sentry_dsn=DSN))

    code, _ = _smoke(cast(Settings, settings))

    assert code == 0
    assert settings.read == {"sentry_dsn", "app_env"}


@pytest.mark.parametrize("outcome", ["sent", "not_sent", "dropped"])
def test_smoke_never_prints_the_dsn(
    sentry_to: Callable[[Transport], None],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    outcome: str,
) -> None:
    """Whatever the outcome, one line on stdout and nothing on stderr: of the DSN, its host
    only. Nothing of the DSN in what goes to Sentry."""
    transport = MemoryTransport() if outcome != "not_sent" else WorkerTransport()
    sentry_to(transport)
    if outcome == "dropped":
        monkeypatch.setattr(observability, "before_send", lambda event, hint: None)

    code = sentry_smoke.run(make_settings(sentry_dsn=DSN), sys.stdout, flush_timeout=0.2)
    if isinstance(transport, WorkerTransport):
        transport.answered.set()
        sentry_sdk.flush(timeout=2)  # the held envelope reaches the transport: check it too

    assert code == (0 if outcome == "sent" else 2)
    printed, errors = capsys.readouterr()
    assert errors == ""
    assert len(printed.splitlines()) == 1
    assert printed.endswith(f" (environment test, host {DSN_HOST}).\n")
    assert len(transport.envelopes) == (0 if outcome == "dropped" else 1)
    for part in NEVER_PRINTED:
        assert part not in printed
    for part in NEVER_SENT:
        assert part not in _wire(transport)


def test_smoke_flush_timeout_exits_2(sentry_to: Callable[[Transport], None]) -> None:
    """Sentry never answers: the send is still pending when the bounded flush ends."""
    transport = WorkerTransport()
    sentry_to(transport)

    code, printed = _smoke(make_settings(sentry_dsn=DSN), flush_timeout=0.2)

    assert code == 2
    assert transport.envelopes == []
    assert printed.startswith("Smoke event ")
    assert printed.endswith(f" not sent within 0.2 s (environment test, host {DSN_HOST}).\n")
    assert transport.flushes == [0.2, sentry_smoke.PENDING_CHECK_SECONDS]


def test_smoke_waits_for_a_slow_send_within_the_timeout(
    sentry_to: Callable[[Transport], None],
) -> None:
    """A send slower than the SDK's first 0.1 s look (which reports it pending) but done
    within the timeout is sent: exit 0, and the bound given to the flush is the script's."""
    transport = WorkerTransport()
    sentry_to(transport)
    answer = threading.Timer(0.3, transport.answered.set)
    answer.start()

    try:
        code, printed = _smoke(make_settings(sentry_dsn=DSN))
    finally:
        answer.cancel()

    assert code == 0
    [event] = _events(transport)
    where = f"(environment test, host {DSN_HOST})"
    assert printed == f"Smoke event {event['event_id']} sent {where}.\n"
    assert transport.flushes == [
        sentry_smoke.FLUSH_TIMEOUT_SECONDS,
        sentry_smoke.PENDING_CHECK_SECONDS,
    ]
    assert sentry_smoke.FLUSH_TIMEOUT_SECONDS == 10


def test_smoke_uses_the_existing_scrubbing(
    sentry_to: Callable[[Transport], None], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sentry starts as the service starts it (init_sentry's options), and its before_send
    sees the smoke event once."""
    transport = MemoryTransport()
    sentry_to(transport)
    to_memory = sentry_sdk.init
    options: list[dict[str, Any]] = []

    def init(*args: Any, **kwargs: Any) -> object:
        options.append(kwargs)
        return to_memory(*args, **kwargs)

    monkeypatch.setattr(sentry_sdk, "init", init)
    seen: list[dict[str, Any]] = []
    real_before_send = observability.before_send

    def before_send(event: Any, hint: Any) -> Any:
        seen.append(event)
        return real_before_send(event, hint)

    monkeypatch.setattr(observability, "before_send", before_send)

    code, _ = _smoke(make_settings(sentry_dsn=DSN))

    assert code == 0
    [given] = options
    assert given["dsn"] == DSN
    assert given["send_default_pii"] is False
    assert given["include_local_variables"] is False
    assert given["max_request_body_size"] == "never"
    assert given["before_send"] is before_send
    assert given["before_breadcrumb"] is observability.before_breadcrumb
    [scrubbed] = seen
    [event] = _events(transport)
    assert scrubbed["event_id"] == event["event_id"]
