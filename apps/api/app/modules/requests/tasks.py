"""Worker side of the requests module: privacy-safe media copies (#173)."""

import logging
import uuid
from typing import Any

from arq import Retry

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
    outcome = await copier.copy_request_media(uuid.UUID(request_id), attempt=ctx["job_try"])
    if outcome.waiting:
        raise Retry(defer=settings.media_sanitize_retry_seconds)
    return str(outcome)
