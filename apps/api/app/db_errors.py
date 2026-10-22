"""What may be logged of a database error (#174): never its statement, parameters or message.

A SQLAlchemy error's text holds the SQL statement, and `hide_parameters` hides bound values
only: literals written into the SQL ("WHERE email = 'x@y'") stay in the statement, a driver
message can quote a value ("invalid input syntax for type uuid: ..."), and a
PendingRollbackError repeats the text of the error before it. So logs and Sentry get a summary:
the error class, the SQLSTATE, and the constraint and table names when the driver gives them.
A refusal by the status guard (#163) is recognized by its SQLSTATE and fixed message, which
names the table only.
"""

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from sqlalchemy.exc import DBAPIError, SQLAlchemyError

GUARD_SQLSTATE: Final = "42501"
_GUARD_MESSAGE: Final = re.compile(r"the status of (\w+) changes only through its state machine")
_MAX_EXCEPTIONS: Final = 50


@dataclass(frozen=True)
class DatabaseErrorSummary:
    error_class: str
    sqlstate: str | None = None
    constraint: str | None = None
    table: str | None = None
    guard_table: str | None = None  # set when the status guard refused the write

    @property
    def guard_message(self) -> str | None:
        """The guard's own message, rebuilt from the table name alone."""
        if self.guard_table is None:
            return None
        return f"the status of {self.guard_table} changes only through its state machine"

    def as_extra(self) -> dict[str, str]:
        """The fields for a log record's `extra`, without the empty ones."""
        fields = {
            "error_class": self.error_class,
            "sqlstate": self.sqlstate,
            "constraint": self.constraint,
            "table": self.table or self.guard_table,
            "reason": self.guard_message,
        }
        return {name: value for name, value in fields.items() if value}

    def describe(self) -> str:
        """One line, for Sentry's exception value and log messages."""
        return " ".join(f"{name}={value}" for name, value in self.as_extra().items())


def database_error_in(exc: BaseException) -> SQLAlchemyError | None:
    """The first SQLAlchemy error among the exceptions a traceback of `exc` would print: its
    __cause__, its __context__ unless suppressed by `raise ... from None`, and the members of
    an exception group, at any depth (bounded)."""
    pending = [exc]
    for _ in range(_MAX_EXCEPTIONS):
        if not pending:
            return None
        current = pending.pop(0)
        if isinstance(current, SQLAlchemyError):
            return current
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        elif current.__context__ is not None and not current.__suppress_context__:
            pending.append(current.__context__)
    return None


def summarize(error: SQLAlchemyError) -> DatabaseErrorSummary:
    orig = error.orig if isinstance(error, DBAPIError) else None
    driver = getattr(orig, "__cause__", None)  # asyncpg's exception, behind the adapter
    sqlstate = _text(getattr(orig, "sqlstate", None)) or _text(getattr(orig, "pgcode", None))
    guard_table = None
    if sqlstate == GUARD_SQLSTATE:
        match = _GUARD_MESSAGE.search(_text(getattr(driver, "message", None)) or str(orig))
        guard_table = match.group(1) if match else None
    return DatabaseErrorSummary(
        error_class=type(error).__name__,
        sqlstate=sqlstate,
        constraint=_text(getattr(driver, "constraint_name", None)),
        table=_text(getattr(driver, "table_name", None)),
        guard_table=guard_table,
    )


def summary_of(value: object) -> DatabaseErrorSummary | None:
    """The summary when `value` is, or was caused by, a database error."""
    if not isinstance(value, BaseException):
        return None
    error = database_error_in(value)
    return summarize(error) if error is not None else None


def record_summary(record: logging.LogRecord) -> DatabaseErrorSummary | None:
    """The summary when a log record carries a database error anywhere: as its exc_info (or
    in that exception's chain), as its message, or among its arguments."""
    exc_info = record.exc_info
    if isinstance(exc_info, tuple) and len(exc_info) == 3:
        summary = summary_of(exc_info[1])
        if summary is not None:
            return summary
    args = record.args
    values = args.values() if isinstance(args, Mapping) else args if isinstance(args, tuple) else ()
    return next(
        (summary for value in (record.msg, *values) if (summary := summary_of(value))), None
    )


def safe_message(record: logging.LogRecord) -> str:
    """`record.getMessage()`, or, when the record carries a database error, the logger's name
    and the error's summary alone. Nothing of the record's message or arguments is kept: a
    message can arrive already rendered with the error's text in it (asyncio logs "Future
    exception was never retrieved" with the future's repr), and an argument next to the
    error can be a runtime value."""
    summary = record_summary(record)
    if summary is None:
        return record.getMessage()
    return f"{record.name}: {summary.error_class}({summary.describe()})"


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
