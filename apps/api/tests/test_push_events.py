"""An invalid push never escapes notifications.events (#328).

Every push_* function runs after the commit of the action it announces. An InvalidPushError
(a bad message id or an unknown catalog key: a bug in the caller) is logged as push_invalid
with the user id, the message id and the short reason, and dropped: no params, no deep link.
Valid pushes queue exactly as before.
"""

import inspect
import json
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import pytest

from app.modules.notifications import catalog, events, service
from app.observability import JsonFormatter
from tests.test_requests_api import ENQUEUE_TIMEOUT, RecordingQueue

PUBLIC_CODE = "JFX-7Q2K"
LOG_FIELDS = {"timestamp", "level", "logger", "message", "request_id"}


@dataclass(frozen=True)
class Caller:
    """A push_* function: who receives it, the message id that names it, where it opens."""

    name: str
    recipient: str  # the keyword holding the user id
    message_id: str  # with {keyword} for the event's id
    link: str  # the deep link, with {keyword} for the ids


CALLERS = (
    Caller(
        "push_new_request",
        "pro_user_id",
        "dispatch:{dispatch_id}",
        "/opportunities/{dispatch_id}",
    ),
    Caller("push_new_quote", "customer_id", "quote:{quote_id}", "/requests/{request_id}"),
    Caller(
        "push_quote_accepted",
        "pro_user_id",
        "quote_accepted:{quote_id}",
        "/",  # home: the opportunity 404s once quoted and the job does not exist yet (#338)
    ),
    Caller("push_job_booked", "customer_id", "job_booked:{job_id}", "/requests/{request_id}/job"),
    Caller("push_job_scheduled", "pro_user_id", "job_scheduled:{job_id}", "/jobs/{job_id}"),
    Caller(
        "push_job_on_the_way",
        "customer_id",
        "job_on_the_way:{job_id}",
        "/requests/{request_id}/job",
    ),
    Caller(
        "push_job_checked_in",
        "customer_id",
        "job_checked_in:{job_id}",
        "/requests/{request_id}/job",
    ),
    Caller("push_job_started", "customer_id", "job_started:{job_id}", "/requests/{request_id}/job"),
    Caller("push_job_done", "customer_id", "job_done:{job_id}", "/requests/{request_id}/job"),
    Caller("push_job_confirmed", "pro_user_id", "job_confirmed:{job_id}", "/jobs/{job_id}"),
    Caller(
        "push_booking_not_completed",
        "customer_id",
        "booking_not_completed:{payment_id}",
        "/requests/{request_id}",
    ),
)


def kind(caller: Caller) -> str:
    return caller.name.removeprefix("push_")


def function(caller: Caller) -> Callable[..., Awaitable[None]]:
    found: Callable[..., Awaitable[None]] = getattr(events, caller.name)
    return found


def arguments(caller: Caller) -> dict[str, Any]:
    """Every keyword the function takes: a fresh uuid per id, the code and the deadline."""
    values: dict[str, Any] = {}
    for name in inspect.signature(function(caller)).parameters:
        if name == "queue":
            continue
        if name.endswith("_id"):
            values[name] = uuid.uuid4()
        elif name == "public_code":
            values[name] = PUBLIC_CODE
        elif name == "timeout_seconds":
            values[name] = ENQUEUE_TIMEOUT
        else:
            raise AssertionError(f"{caller.name} takes an unknown keyword: {name}")
    return values


def message_id(caller: Caller, values: dict[str, Any]) -> str:
    return caller.message_id.format(**values)


def records(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.message == message]


def logged_fields(record: logging.LogRecord) -> tuple[str, dict[str, Any]]:
    """The JSON line as production writes it, and its fields beyond the standard ones."""
    line = JsonFormatter().format(record)
    payload: dict[str, Any] = json.loads(line)
    return line, {key: value for key, value in payload.items() if key not in LOG_FIELDS}


@pytest.fixture
def unknown_keys(monkeypatch: pytest.MonkeyPatch) -> str:
    """The catalog knows none of the push keys: what a misspelled kind would meet."""
    monkeypatch.setattr(catalog, "catalog_keys", frozenset)
    return "unknown catalog key"


@pytest.fixture
def refused_message_ids(monkeypatch: pytest.MonkeyPatch) -> str:
    """No message id passes the pattern: what an id too long or with a stray character meets."""
    monkeypatch.setattr(service, "MESSAGE_ID_PATTERN", re.compile(r"(?!)"))
    return "message_id"


def test_the_table_covers_every_push_function() -> None:
    public = {
        name
        for name, member in inspect.getmembers(events, inspect.iscoroutinefunction)
        if name.startswith("push_")
    }
    assert {caller.name for caller in CALLERS} == public


@pytest.mark.parametrize("caller", CALLERS, ids=[caller.name for caller in CALLERS])
@pytest.mark.parametrize("invalid", ["unknown_keys", "refused_message_ids"])
async def test_an_invalid_push_is_logged_with_ids_and_never_raises(
    caller: Caller,
    invalid: str,
    request: pytest.FixtureRequest,
    caplog: pytest.LogCaptureFixture,
) -> None:
    reason: str = request.getfixturevalue(invalid)
    queue = RecordingQueue()
    values = arguments(caller)

    with caplog.at_level(logging.INFO):
        await function(caller)(queue, **values)  # returns: nothing escapes

    assert queue.before == []  # refused before anything was queued
    assert records(caplog, "push_enqueue_failed") == []
    [record] = records(caplog, "push_invalid")
    assert record.levelno == logging.ERROR
    line, fields = logged_fields(record)
    assert fields == {
        "user_id": str(values[caller.recipient]),
        "message_id": message_id(caller, values),
        "reason": reason,
    }
    assert PUBLIC_CODE not in line
    assert caller.link.format(**values) not in line
    assert '"params"' not in line
    assert '"deep_link"' not in line


@pytest.mark.parametrize("caller", CALLERS, ids=[caller.name for caller in CALLERS])
async def test_a_valid_push_queues_as_before_and_logs_nothing(
    caller: Caller, caplog: pytest.LogCaptureFixture
) -> None:
    queue = RecordingQueue()
    values = arguments(caller)
    sent = message_id(caller, values)

    with caplog.at_level(logging.INFO):
        await function(caller)(queue, **values)

    assert queue.jobs == {
        f"push:{sent}": (
            "send_push",
            (
                str(values[caller.recipient]),
                sent,
                f"push.{kind(caller)}.title",
                f"push.{kind(caller)}.body",
                {"public_code": PUBLIC_CODE},
                caller.link.format(**values),
            ),
        )
    }
    assert records(caplog, "push_invalid") == []
    assert records(caplog, "push_enqueue_failed") == []
