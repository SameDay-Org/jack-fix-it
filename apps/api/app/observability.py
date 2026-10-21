"""JSON logging and Sentry, shared by the API and the worker."""

import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, Final

import sentry_sdk
from sentry_sdk.types import Breadcrumb, BreadcrumbHint, Event, Hint

from app.config import Settings

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
            "message": record.getMessage(),
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


# A URL or path with a query, inside free text such as a log message: the query ends at a space.
_URL_QUERY_IN_TEXT: Final = re.compile(r"((?:[A-Za-z][A-Za-z0-9+.-]*://|/)[^\s?]*)\?\S*")


def _without_query(url: str) -> str:
    return url.split("?", 1)[0]


def _is_url(value: str) -> bool:
    return value.startswith("/") or "://" in value


def before_send(event: Event, hint: Hint) -> Event:
    """Sentry hook: drops the query string from the request URL, its Referer and the transaction.

    Keeps the path and every other field. Fields of an unexpected shape are left as they are.
    """
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("query_string", None)
        url = request.get("url")
        if isinstance(url, str):
            request["url"] = _without_query(url)
        headers = request.get("headers")
        if isinstance(headers, dict):
            for name, value in list(headers.items()):
                if isinstance(value, str) and _is_url(value):
                    headers[name] = _without_query(value)
    transaction = event.get("transaction")
    if isinstance(transaction, str) and _is_url(transaction):
        event["transaction"] = _without_query(transaction)
    return event


def before_breadcrumb(crumb: Breadcrumb, hint: BreadcrumbHint) -> Breadcrumb:
    """Sentry hook: drops the query string from HTTP and navigation breadcrumbs.

    Also from URLs in a breadcrumb's message, e.g. a library's log line naming a request URL.
    """
    message = crumb.get("message")
    if isinstance(message, str):
        crumb["message"] = _URL_QUERY_IN_TEXT.sub(r"\1", message)
    data = crumb.get("data")
    if isinstance(data, dict):
        data.pop("http.query", None)
        url = data.get("url")
        if crumb.get("type") in ("http", "navigation") and isinstance(url, str):
            data["url"] = _without_query(url)
    return crumb
