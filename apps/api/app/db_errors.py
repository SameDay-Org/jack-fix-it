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


def safe_message(record: logging.LogRecord) -> str:
    """`record.getMessage()`, with a database error logged as the message, or among its
    arguments, replaced by its summary. A library can log one as an argument: ARQ logs
    "%s failed, %s: %s" with the exception last."""
    if summary_of(record.msg) is not None:
        return str(_safe_arg(record.msg))
    args = record.args
    if isinstance(args, tuple) and any(summary_of(arg) for arg in args):
        return str(record.msg) % tuple(_safe_arg(arg) for arg in args)
    if isinstance(args, Mapping) and any(summary_of(arg) for arg in args.values()):
        return str(record.msg) % {key: _safe_arg(arg) for key, arg in args.items()}
    return record.getMessage()


def _safe_arg(value: object) -> object:
    summary = summary_of(value)
    return f"{summary.error_class}({summary.describe()})" if summary else value


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
