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

# The tries ARQ allows beyond MEDIA_SANITIZE_MAX_TRIES (app/worker.py): the job settles its rows
# from that try on, and a spare try runs when one is stopped before it could.
SANITIZE_SPARE_TRIES = 2


async def sanitize_request_media(ctx: dict[str, Any], request_id: str) -> str:
    """ARQ task: makes the safe copy of each pending photo and video of one request. A transient
    failure asks ARQ to run it again later; the last try fails what is still pending."""
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
    final = attempt >= settings.media_sanitize_max_tries + SANITIZE_SPARE_TRIES
    try:
        outcome = await copier.copy_request_media(uuid.UUID(request_id), attempt, final=final)
    except (SQLAlchemyError, OSError) as error:
        # The database or the network failed (or did not answer in time: TimeoutError is an
        # OSError) outside one file's copy: ARQ would end the job for good on this error, so it
        # is a retry. Its text is never logged.
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
        raise Retry(defer=settings.media_sanitize_retry_seconds)
    return str(outcome)


def sanitize_task(settings: Settings) -> Function:
    """sanitize_request_media as the worker registers it (app/worker.py). No result is kept: a
    failed run's exception (with its SQL) never stays in Redis, and the job id is free again
    once a run ends; rows already copied are skipped. Two spare tries: the job fails its rows
    from MEDIA_SANITIZE_MAX_TRIES on, so a try stopped by a deploy is followed by one that still
    settles them. ARQ's timeout ends a job for good, so each try stops itself before it (see
    app/modules/requests/media_copies.py) and asks for the next one."""
    return func(
        sanitize_request_media,
        keep_result=0,
        max_tries=settings.media_sanitize_max_tries + SANITIZE_SPARE_TRIES,
        timeout=settings.media_sanitize_job_timeout_seconds,
    )
