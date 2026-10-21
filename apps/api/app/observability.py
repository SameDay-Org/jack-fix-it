"""JSON logging and Sentry, shared by the API and the worker."""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, Final

import sentry_sdk

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
    )
