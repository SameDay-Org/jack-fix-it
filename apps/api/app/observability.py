"""JSON logging and Sentry, shared by the API and the worker."""

import json
import logging
import string
import sys
import traceback
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, Final

import sentry_sdk
from sentry_sdk.types import Breadcrumb, BreadcrumbHint, Event, Hint

from app.config import Settings
from app.db_errors import safe_message, summary_of

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

# Attributes every LogRecord has; anything else on a record came from `extra=` and is logged.
# uvicorn's color_message is the same text with ANSI codes.
_STANDARD_RECORD_ATTRS: Final = frozenset(
    vars(logging.LogRecord("", logging.INFO, "", 0, "", None, None))
) | {"message", "asctime", "color_message"}

# Third-party loggers that install their own handlers; they are routed through the root handler.
_THIRD_PARTY_LOGGERS: Final = ("uvicorn", "uvicorn.error", "arq")


class JsonFormatter(logging.Formatter):
    """One JSON object per line: timestamp, level, logger, message, request_id and extras."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": safe_message(record),
        }
        request_id = getattr(record, "request_id", None) or request_id_var.get()
        if request_id:
            payload["request_id"] = request_id
        for key, value in vars(record).items():
            if key not in _STANDARD_RECORD_ATTRS and key not in payload:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)

    def formatException(self, ei: Any) -> str:  # noqa: N802 - logging.Formatter's name
        """A database error keeps its stack but not its text: the summary replaces it. So does
        an error caused by one, whose own text may repeat it."""
        _, error, tb = ei
        summary = summary_of(error)
        if summary is None:
            return super().formatException(ei)
        name = type(error).__name__
        if name != summary.error_class:
            name = f"{name} (from {summary.error_class})"
        lines = ["Traceback (most recent call last):\n", *traceback.format_tb(tb)]
        return "".join(lines) + f"{name}: {summary.describe()}"


def configure_logging(level: str) -> None:
    """Install the JSON stdout handler on the root logger. Safe to call more than once."""
    root = logging.getLogger()
    if not any(isinstance(handler.formatter, JsonFormatter) for handler in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
    root.setLevel(level)
    for name in _THIRD_PARTY_LOGGERS:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    # uvicorn's access line includes the query string, which can carry PII.
    # RequestIdMiddleware logs every request instead (app.access).
    logging.getLogger("uvicorn.access").disabled = True
    # httpx logs every outgoing request at INFO with the full URL, query string included.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    # At DEBUG, botocore logs the canonical request and the signature of every presigned URL:
    # enough to rebuild a working URL from the logs.
    for name in ("boto3", "botocore"):
        logging.getLogger(name).setLevel(logging.WARNING)


# Passed to `arq --custom-log-dict` so ARQ's own startup lines are JSON too.
# The worker's on_startup hook then applies LOG_LEVEL through configure_logging().
WORKER_LOG_CONFIG: Final[dict[str, Any]] = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": "app.observability.JsonFormatter"}},
    "handlers": {
        "stdout": {
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout",
            "formatter": "json",
        }
    },
    "root": {"handlers": ["stdout"], "level": "INFO"},
}


def init_sentry(settings: Settings) -> None:
    """Enable Sentry only when SENTRY_DSN is set. PII is never sent."""
    if not settings.sentry_dsn:
        return
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.app_env,
        send_default_pii=False,
        # Request bodies and frame locals can hold emails, passwords and tokens.
        max_request_body_size="never",
        include_local_variables=False,
        # send_default_pii=False still sends the query string, which can carry emails or tokens.
        before_send=before_send,
        before_breadcrumb=before_breadcrumb,
    )


_ASCII_LETTERS: Final = frozenset(string.ascii_letters)
_SCHEME_CHARS: Final = _ASCII_LETTERS | frozenset(string.digits + "+.-")
# Besides whitespace and the start of the text, a URL in free text may follow one of these.
_URL_START_AFTER: Final = frozenset("\"'([<{=:,;")


def _without_query(url: str) -> str:
    return url.partition("?")[0]


def _is_url(value: str) -> bool:
    return value.startswith("/") or "://" in value


def _url_starts_at(text: str, i: int) -> bool:
    """A path (`/…`) or a `scheme://` URL starts at `i`, right after a start boundary."""
    if i > 0 and not (text[i - 1].isspace() or text[i - 1] in _URL_START_AFTER):
        return False
    if text[i] == "/":
        return True
    if text[i] not in _ASCII_LETTERS:
        return False
    # Stops at the first non-scheme character; boundaries are not scheme characters, so two
    # scans never overlap.
    k = i + 1
    while k < len(text) and text[k] in _SCHEME_CHARS:
        k += 1
    return text.startswith("://", k)


def _without_url_queries(text: str) -> str:
    """Cuts the query from every URL or path in free text, such as a log message.

    A query runs from the URL's first `?` to the next whitespace, quotes and brackets included,
    so `?a=1;token=x` or `?q=(x)&token=y` cannot keep a part. One left-to-right pass that never
    rescans a URL: linear by construction, as the hook runs on every log record.
    """
    parts: list[str] = []
    copied = i = 0
    while i < len(text):
        if not _url_starts_at(text, i):
            i += 1
            continue
        k = i
        while k < len(text) and text[k] != "?" and not text[k].isspace():
            k += 1
        if k < len(text) and text[k] == "?":
            parts.append(text[copied:k])
            while k < len(text) and not text[k].isspace():
                k += 1
            copied = k
        # A URL without a query ends at whitespace too: nothing inside it can start a new one.
        i = k
    parts.append(text[copied:])
    return "".join(parts)


def _without_database_text(event: Event, hint: Hint) -> None:
    """A database error's text can hold SQL literals (#174): each exception in the chain gets
    the error's summary as its value, and a log line naming the error gets its safe message.
    Frame locals are already off (include_local_variables=False)."""
    exc_info = hint.get("exc_info")
    error = exc_info[1] if isinstance(exc_info, tuple) and len(exc_info) == 3 else None
    summary = summary_of(error)
    exception = event.get("exception")
    values = exception.get("values") if isinstance(exception, dict) else None
    if summary is not None and isinstance(values, list):
        for value in values:
            if isinstance(value, dict):
                value["value"] = summary.describe()
    record = hint.get("log_record")
    logentry = event.get("logentry")
    if isinstance(record, logging.LogRecord) and isinstance(logentry, dict):
        message = safe_message(record)
        if message != record.getMessage():
            logentry.update(message=message, formatted=message, params=[])


def before_send(event: Event, hint: Hint) -> Event:
    """Sentry hook: drops the query string from the request URL, its Referer and the transaction,
    and a database error's text.

    Keeps the path and every other field. Fields of an unexpected shape are left as they are.
    """
    _without_database_text(event, hint)
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("query_string", None)
        url = request.get("url")
        if isinstance(url, str):
            request["url"] = _without_query(url)
        headers = request.get("headers")
        if isinstance(headers, dict):
            for name, value in list(headers.items()):
                if not isinstance(value, str):
                    continue
                # Referer is a URI reference by definition and may be relative ("login?…",
                # "?…", RFC 9110 §10.1.3), so its query goes whatever the value looks like.
                is_referer = isinstance(name, str) and name.lower() == "referer"
                if is_referer or _is_url(value):
                    headers[name] = _without_query(value)
    transaction = event.get("transaction")
    if isinstance(transaction, str) and _is_url(transaction):
        event["transaction"] = _without_query(transaction)
    return event


def before_breadcrumb(crumb: Breadcrumb, hint: BreadcrumbHint) -> Breadcrumb:
    """Sentry hook: drops the query string from HTTP and navigation breadcrumbs.

    Also from URLs in a breadcrumb's message and in the text values of its data, e.g. a
    library's log line, or its `extra`, naming a request URL. The SQL breadcrumbs the
    SQLAlchemy and asyncpg integrations record keep their timing but lose the statement and
    their data (parameters, the cursor's repr): a statement can hold literals (#174). A log
    line naming a database error gets its safe message.
    """
    if crumb.get("category") == "query":
        crumb.pop("message", None)
        crumb.pop("data", None)
        return crumb
    record = hint.get("log_record")
    if isinstance(record, logging.LogRecord):
        safe = safe_message(record)
        if safe != record.getMessage():
            crumb["message"] = safe
    message = crumb.get("message")
    if isinstance(message, str):
        crumb["message"] = _without_url_queries(message)
    data = crumb.get("data")
    if isinstance(data, dict):
        data.pop("http.query", None)
        for name, value in list(data.items()):
            if isinstance(value, str):
                data[name] = _without_url_queries(value)
        url = data.get("url")
        if crumb.get("type") in ("http", "navigation") and isinstance(url, str):
            data["url"] = _without_query(url)
    return crumb
