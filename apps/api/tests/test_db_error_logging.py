"""Database errors reach the logs and Sentry as a summary only (#174, Vault round 1).

Their text holds the SQL statement, and hide_parameters hides bound values only: a literal
written into the SQL, or quoted back by the driver, would reach the logs. Real database, real
triggers. The bound-parameter case is test_status_writer_guard.py's API test.
"""

import json
import logging
from typing import Any

import httpx
import pytest
import sentry_sdk
from fastapi import FastAPI
from sentry_sdk.utils import event_from_exception
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, PendingRollbackError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db_errors import summary_of
from app.main import create_app
from app.observability import JsonFormatter, before_breadcrumb, before_send, init_sentry
from tests.conftest import make_settings
from tests.test_sentry_scrubbing import TEST_DSN, MemoryTransport, _payloads, sentry_transport
from tests.test_status_writer_guard import Committed, Rows, committed, refused, rows

__all__ = ["committed", "rows", "sentry_transport"]  # fixtures, used by name

# Built into the SQL at run time, as a buggy writer would: no source line below holds them.
CANARY = "PRIVATE-ROW-CANARY privacy174@example.invalid"
EMAIL_CANARY = "dup-canary-174@example.invalid"
SECRETS = ("PRIVATE-ROW-CANARY", "privacy174", "dup-canary-174")
# Pieces of the statements below: none may be logged. (Sentry adds source lines around each
# frame, so no frame's neighbourhood holds them: the statements are built here, far above.)
STATEMENT_PARTS = ("status='cancelled'", "status='accepted'", "email='", "next_action='", "[SQL:")
GUARD_MESSAGE = "the status of service_requests changes only through its state machine"
GENERIC_500 = {"error": {"code": "internal_error", "message": "Internal server error."}}


def literal_status_write(committed: Committed) -> Any:
    """A raw status update with literals, as the guard must refuse it."""
    return text(
        f"UPDATE service_requests SET status='cancelled', next_action='{CANARY}' "  # noqa: S608 - literal SQL is what this test is about
        f"WHERE id='{committed.request_id}'"
    )


def literal_status_write_in(rows: Rows) -> Any:
    return text(
        f"UPDATE service_requests SET status='accepted', next_action='{CANARY}' "  # noqa: S608 - literal SQL is what this test is about
        f"WHERE id='{rows.request.id}'"
    )


def literal_duplicate_email(committed: Committed) -> Any:
    """Two users set to one literal email: a unique violation that quotes the value back."""
    return text(
        f"UPDATE users SET email='{EMAIL_CANARY}' WHERE id IN ('{committed.agent.id}', "  # noqa: S608 - literal SQL is what this test is about
        f"(SELECT customer_id FROM service_requests WHERE id='{committed.request_id}'))"
    )


def add_route(app: FastAPI, committed: Committed, statement: Any) -> str:
    path = "/test-only/db-error-logging"

    @app.post(path)
    async def failing_write() -> None:
        async with committed.sessions() as session:
            await session.execute(statement)

    return path


async def post(app: FastAPI, path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.post(path)


def everything_logged(caplog: pytest.LogCaptureFixture) -> str:
    """What stdout would print, the raw messages, and pytest's own rendering with tracebacks."""
    formatter = JsonFormatter()
    lines = [formatter.format(r) + r.getMessage() for r in caplog.records]
    return "\n".join([*lines, caplog.text])


def assert_no_sql(output: str) -> None:
    for secret in (*SECRETS, *STATEMENT_PARTS):
        assert secret not in output, secret


def only_record(caplog: pytest.LogCaptureFixture, message: str) -> logging.LogRecord:
    [record] = [r for r in caplog.records if r.getMessage() == message]
    return record


async def test_guard_refusal_with_literal_sql_logs_no_literal(
    app: FastAPI, committed: Committed, caplog: pytest.LogCaptureFixture
) -> None:
    path = add_route(app, committed, literal_status_write(committed))

    with caplog.at_level(logging.DEBUG):
        response = await post(app, path)

    assert response.status_code == 500
    assert response.json() == GENERIC_500
    assert_no_sql(everything_logged(caplog))
    refusal = only_record(caplog, "status_guard_refused")
    assert refusal.levelno == logging.WARNING
    assert vars(refusal)["table"] == "service_requests"
    error = only_record(caplog, "unhandled_error")
    assert error.exc_info is None
    assert vars(error)["sqlstate"] == "42501"
    assert vars(error)["reason"] == GUARD_MESSAGE
    assert GUARD_MESSAGE in JsonFormatter().format(error)


async def test_unique_violation_with_literal_logs_only_its_summary(
    app: FastAPI, committed: Committed, caplog: pytest.LogCaptureFixture
) -> None:
    path = add_route(app, committed, literal_duplicate_email(committed))

    with caplog.at_level(logging.DEBUG):
        response = await post(app, path)

    assert response.status_code == 500
    assert response.json() == GENERIC_500
    assert_no_sql(everything_logged(caplog))
    assert not [r for r in caplog.records if r.getMessage() == "status_guard_refused"]
    error = only_record(caplog, "unhandled_error")
    assert error.exc_info is None
    assert vars(error)["sqlstate"] == "23505"
    assert vars(error)["table"] == "users"
    assert vars(error)["constraint"] == "uq_users_email"
    assert vars(error)["error_class"] == "IntegrityError"


@pytest.mark.parametrize("write", [literal_status_write, literal_duplicate_email])
async def test_captured_sentry_event_of_a_database_error_has_no_sql(
    sentry_transport: MemoryTransport, committed: Committed, write: Any
) -> None:
    app = create_app(make_settings(sentry_dsn=TEST_DSN))
    path = add_route(app, committed, write(committed))

    response = await post(app, path)
    sentry_sdk.flush()

    assert response.status_code == 500
    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"exception"' in p]
    assert events, "no event was captured"
    assert_no_sql("\n".join(payloads))
    for event in events:
        values = event["exception"]["values"]
        assert {value["value"] for value in values} == {values[-1]["value"]}
        assert "sqlstate=" in values[-1]["value"]
        crumbs = event.get("breadcrumbs", {}).get("values", [])
        assert all("message" not in c for c in crumbs if c.get("category") == "query")


async def test_before_send_replaces_the_text_of_each_exception_in_the_chain(
    sentry_transport: MemoryTransport, db_session: AsyncSession, rows: Rows
) -> None:
    init_sentry(make_settings(sentry_dsn=TEST_DSN))
    statement = literal_status_write_in(rows)
    error = await refused(db_session, lambda: db_session.execute(statement))
    event, hint = event_from_exception(error, client_options=sentry_sdk.get_client().options)
    assert CANARY in json.dumps(event, default=str)  # what Sentry would have sent

    result = before_send(event, hint)

    assert_no_sql(json.dumps(result, default=str))
    values = result["exception"]["values"]
    assert len(values) > 1  # the driver's exceptions are in the chain too
    assert {value["value"] for value in values} == {
        f"error_class=ProgrammingError sqlstate=42501 table=service_requests reason={GUARD_MESSAGE}"
    }


async def test_a_library_logging_a_database_error_as_an_argument_logs_its_summary(
    db_session: AsyncSession, rows: Rows
) -> None:
    statement = literal_status_write_in(rows)
    error = await refused(db_session, lambda: db_session.execute(statement))
    # How ARQ logs a failed job: the exception as the last argument, and its traceback.
    record = logging.LogRecord(
        "arq.worker",
        logging.ERROR,
        __file__,
        1,
        "%6.2fs ! %s failed, %s: %s",
        (0.25, "job:sanitize", type(error).__name__, error),
        (type(error), error, error.__traceback__),
    )
    assert CANARY in record.getMessage()  # what would have been logged

    logged = JsonFormatter().format(record)

    assert_no_sql(logged)
    payload = json.loads(logged)
    assert payload["message"].startswith("  0.25s ! job:sanitize failed, ProgrammingError: ")
    assert "sqlstate=42501" in payload["message"]
    assert payload["exception"].startswith("Traceback (most recent call last):")
    assert payload["exception"].endswith(
        "ProgrammingError: error_class=ProgrammingError sqlstate=42501 "
        f"table=service_requests reason={GUARD_MESSAGE}"
    )


async def test_a_logged_database_error_reaches_sentry_without_sql(
    sentry_transport: MemoryTransport, db_session: AsyncSession, rows: Rows
) -> None:
    init_sentry(make_settings(sentry_dsn=TEST_DSN))
    statement = literal_status_write_in(rows)
    error = await refused(db_session, lambda: db_session.execute(statement))
    # Not "arq.worker": Sentry's ARQ integration ignores that logger and captures the job's
    # exception instead (the exception path above). Any other library may log one this way.
    library_log = logging.getLogger("some.library")

    # Through Sentry's logging integration: as an argument, as ARQ does, and as the message.
    library_log.warning("%s: %s", "job:sanitize", error)  # a breadcrumb
    library_log.error("%s failed, %s: %s", "job:sanitize", type(error).__name__, error)
    library_log.error(error, exc_info=error)
    sentry_sdk.flush()

    payloads = _payloads(sentry_transport)
    events = [json.loads(p) for p in payloads if '"logentry"' in p]
    assert len(events) == 2
    assert_no_sql("\n".join(payloads))
    crumbs = [c for event in events for c in event.get("breadcrumbs", {}).get("values", [])]
    assert any(c.get("category") == "some.library" for c in crumbs)


def test_a_database_error_logged_as_the_message_logs_its_summary() -> None:
    statement = "UPDATE x SET y='" + CANARY + "'"  # noqa: S608 - test data
    error = DBAPIError(statement, None, Exception("driver"))
    record = logging.LogRecord("app", logging.ERROR, __file__, 1, error, None, None)

    logged = json.loads(JsonFormatter().format(record))

    assert logged["message"] == "DBAPIError(error_class=DBAPIError)"


def test_sql_breadcrumbs_lose_their_statement_and_data() -> None:
    statement = "UPDATE users SET email='" + EMAIL_CANARY + "'"  # noqa: S608 - test data
    data = {"db.params": [EMAIL_CANARY], "db.cursor": f"<cursor {statement[:30]}>"}

    kept = before_breadcrumb({"category": "query", "message": statement, "data": data}, {})

    assert kept == {"category": "query"}


def test_the_summary_follows_the_exception_chain() -> None:
    statement = "UPDATE x SET y='" + CANARY + "'"  # noqa: S608 - test data
    database_error = DBAPIError(statement, None, Exception("driver"))

    def raised(outer: BaseException, cause: BaseException, *, suppress: bool) -> BaseException:
        try:
            try:
                raise cause
            except BaseException as inner:
                if suppress:
                    raise outer from None
                raise outer from inner
        except (RuntimeError, DBAPIError) as caught:
            return caught

    caused = raised(RuntimeError("wrapped"), database_error, suppress=False)
    summary = summary_of(caused)
    assert summary is not None
    assert summary.error_class == "DBAPIError"
    assert summary_of(raised(RuntimeError("own"), database_error, suppress=True)) is None
    assert summary_of(RuntimeError("no database")) is None
    # A PendingRollbackError repeats the earlier error's text, statement included.
    pending = summary_of(PendingRollbackError(f"rolled back [SQL: {statement}]"))
    assert pending is not None
    assert_no_sql(pending.describe())
    # An exception group's members, at any depth, as a traceback prints them.
    group = BaseExceptionGroup("tasks", [ValueError("other"), BaseExceptionGroup("in", [caused])])
    assert summary_of(group) == summary
    # The outer error keeps its class name, not its text (which may repeat the statement).
    record = logging.LogRecord(
        "app", logging.ERROR, __file__, 1, "x", None, (RuntimeError, caused, caused.__traceback__)
    )
    logged = json.loads(JsonFormatter().format(record))["exception"]
    assert logged.endswith("RuntimeError (from DBAPIError): error_class=DBAPIError")
    assert_no_sql(logged)


def test_other_errors_keep_their_text_and_traceback() -> None:
    try:
        raise RuntimeError("probe failure")
    except RuntimeError as error:
        record = logging.LogRecord(
            "app", logging.ERROR, __file__, 1, "unhandled_error", None, (RuntimeError, error, None)
        )

    assert json.loads(JsonFormatter().format(record))["exception"].endswith(
        "RuntimeError: probe failure"
    )
