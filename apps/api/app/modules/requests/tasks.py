"""Worker side of the requests module: privacy-safe media copies (#173)."""

import logging
import uuid
from typing import Any

from arq import Retry
from arq.worker import Function, func
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.requests.media_copies import MediaCopier, MediaCopyConfig

logger = logging.getLogger(__name__)

# The tries ARQ allows beyond MEDIA_SANITIZE_MAX_TRIES (app/worker.py). A transient failure fails
# its row from MEDIA_SANITIZE_MAX_TRIES on; the last two tries also fail what had no time, so a
# deploy that stops one of them is followed by one that still settles every row.
SANITIZE_SPARE_TRIES = 2


async def sanitize_request_media(ctx: dict[str, Any], request_id: str) -> str:
    """ARQ task: makes the safe copy of each pending photo and video of one request. A transient
    failure asks ARQ to run it again later; the last two tries fail what is still pending. On
    the last one a retry is never asked: ARQ would refuse it, so the job logs and ends."""
    settings: Settings = ctx["settings"]
    storage: Storage | None = ctx.get("storage")
    if storage is None:
        # S3_* settings are missing (development without storage): the rows stay pending.
        logger.error(
            "media_sanitize_storage_unconfigured", extra={"service_request_id": request_id}
        )
        return "storage_unconfigured"
    copier = MediaCopier(ctx["session_factory"], storage, MediaCopyConfig.from_settings(settings))
    attempt: int = ctx["job_try"]
    last = settings.media_sanitize_max_tries + SANITIZE_SPARE_TRIES
    try:
        outcome = await copier.copy_request_media(
            uuid.UUID(request_id), attempt, final=attempt >= last - 1
        )
    except (SQLAlchemyError, OSError) as error:
        # The database or the network failed (or did not answer in time: TimeoutError is an
        # OSError) outside one file's copy: ARQ would end the job for good on this error, so it
        # is a retry. Its text is never logged.
        if attempt >= last:
            return _unsettled(request_id, attempt, type(error).__name__)
        logger.warning(
            "media_sanitize_retry",
            extra={
                "service_request_id": request_id,
                "reason": "internal",
                "attempt": attempt,
                "error_class": type(error).__name__,
            },
        )
        raise Retry(defer=settings.media_sanitize_retry_seconds) from None
    if outcome.waiting or outcome.deferred:
        if attempt >= last:
            return _unsettled(request_id, attempt, None)
        raise Retry(defer=settings.media_sanitize_retry_seconds)
    return str(outcome)


def _unsettled(request_id: str, attempt: int, error_class: str | None) -> str:
    """The last try could not settle every row (the database failed it): they stay pending, never
    served. Logged as an error for the BDC; ARQ has no try left to give."""
    extra: dict[str, object] = {"service_request_id": request_id, "attempt": attempt}
    if error_class is not None:
        extra["error_class"] = error_class
    logger.error("media_sanitize_unsettled", extra=extra)
    return "unsettled"


def sanitize_task(settings: Settings) -> Function:
    """sanitize_request_media as the worker registers it (app/worker.py). No result is kept: a
    failed run's exception (with its SQL) never stays in Redis, and the job id is free again
    once a run ends; rows already copied are skipped. Two spare tries (SANITIZE_SPARE_TRIES): the
    last two settle every row, so a try stopped by a deploy is followed by one that still
    settles them. ARQ's timeout ends a job for good, so each try stops itself before it (see
    app/modules/requests/media_copies.py) and asks for the next one."""
    return func(
        sanitize_request_media,
        keep_result=0,
        max_tries=settings.media_sanitize_max_tries + SANITIZE_SPARE_TRIES,
        timeout=settings.media_sanitize_job_timeout_seconds,
    )
