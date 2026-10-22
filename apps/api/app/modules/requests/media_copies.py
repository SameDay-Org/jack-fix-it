"""Privacy-safe copies of a request's photos and videos (#173), made by the worker.

POST /v1/requests queues sanitize_request_media after its commit. For each media row still
pending, the job downloads the original to a temporary file, makes the safe copy
(app/modules/media/sanitize.py), uploads it under an opaque key (m/<32 hex><ext>: no user id,
no purpose) and marks the row ready in one short transaction. Temporary files are deleted in
every case. A row already ready or failed is skipped, so a run again makes no second copy.

A transient failure (the storage, a timeout, ffmpeg missing for now) leaves the row pending and
asks for a retry, until the job's last try, where it fails like a file that can never be made
safe (it does not decode, has too many pixels, ffmpeg rejects it). A failed row is never served.

Logs carry the media id, the request id and a reason code: never a key (the original's names
the customer), a path or ffmpeg's output.
"""

import asyncio
import logging
import tempfile
import time
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import (
    Storage,
    StorageObjectMissingError,
    StorageUnavailableError,
)
from app.modules.media.sanitize import (
    SanitizeConfig,
    SanitizeError,
    SanitizeFailure,
    SanitizeRetryableError,
    sanitize,
)
from app.modules.requests.models import MediaSafeStatus
from app.modules.requests.repository import ServiceRequestRepository
from app.modules.uploads.service import upload_content_type
from app.queue import JobQueue, enqueue

logger = logging.getLogger(__name__)

SANITIZE_TASK: Final = "sanitize_request_media"
# What one row's run ended in; "skipped": another run had already settled it.
_RowResult = Literal["ready", "failed", "waiting", "skipped"]
SAFE_KEY_PREFIX: Final = "m/"


def sanitize_job_id(request_id: uuid.UUID) -> str:
    """One sanitize job per request: a second enqueue while it is queued or running is a no-op."""
    return f"sanitize:{request_id}"


async def enqueue_sanitize(queue: JobQueue, request_id: uuid.UUID, timeout_seconds: float) -> bool:
    """Queues sanitize_request_media for the request (after its commit). See app.queue.enqueue."""
    return await enqueue(
        queue,
        SANITIZE_TASK,
        str(request_id),
        job_id=sanitize_job_id(request_id),
        timeout_seconds=timeout_seconds,
    )


def new_safe_key(extension: str) -> str:
    return f"{SAFE_KEY_PREFIX}{uuid.uuid4().hex}{extension}"


@dataclass(frozen=True)
class MediaCopyConfig:
    max_tries: int
    sanitize: SanitizeConfig
    # One try's time and one file's worst case: a try stops before ARQ's timeout would cut it.
    job_budget_seconds: float = float("inf")
    row_budget_seconds: float = 0.0

    @classmethod
    def from_settings(cls, settings: Settings) -> "MediaCopyConfig":
        return cls(
            max_tries=settings.media_sanitize_max_tries,
            sanitize=SanitizeConfig.from_settings(settings),
            job_budget_seconds=settings.media_sanitize_job_timeout_seconds,
            row_budget_seconds=settings.media_sanitize_row_budget_seconds,
        )


@dataclass(frozen=True)
class MediaCopyOutcome:
    ready: int = 0
    failed: int = 0
    waiting: int = 0  # still pending after a transient failure: the job should run again
    deferred: int = 0  # not tried: no time left in this try, the next one goes on

    def __str__(self) -> str:
        return (
            f"ready={self.ready} failed={self.failed} waiting={self.waiting} "
            f"deferred={self.deferred}"
        )


class MediaCopier:
    def __init__(
        self,
        sessions: Callable[[], AbstractAsyncContextManager[AsyncSession]],
        storage: Storage,
        config: MediaCopyConfig,
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._config = config

    async def copy_request_media(
        self,
        request_id: uuid.UUID,
        attempt: int,
        *,
        final: bool = False,
        clock: Callable[[], float] = time.monotonic,
    ) -> MediaCopyOutcome:
        """Makes the safe copy of each pending media row of the request. `attempt` is the job's
        try (1 first): from MEDIA_SANITIZE_MAX_TRIES on, a transient failure fails the row too.
        A row starts only while the try has time for one more file; the rest is deferred to the
        next try, or failed (timeout) on the `final` one ARQ allows."""
        started = clock()
        async with self._sessions() as session:
            pending = [
                (media.id, media.file_key)
                for media in await ServiceRequestRepository(session).pending_media(request_id)
            ]
        settled: dict[_RowResult, int] = {"ready": 0, "failed": 0, "waiting": 0, "skipped": 0}
        deferred = 0
        for media_id, file_key in pending:
            elapsed = clock() - started
            if elapsed + self._config.row_budget_seconds > self._config.job_budget_seconds:
                if final:
                    await self._fail(media_id, request_id, SanitizeFailure.TIMEOUT, None)
                    settled["failed"] += 1
                else:
                    deferred += 1
                continue
            settled[await self._copy_guarded(media_id, request_id, file_key, attempt)] += 1
        ready, failed, waiting = settled["ready"], settled["failed"], settled["waiting"]
        return MediaCopyOutcome(ready=ready, failed=failed, waiting=waiting, deferred=deferred)

    async def _copy_guarded(
        self, media_id: uuid.UUID, request_id: uuid.UUID, file_key: str, attempt: int
    ) -> _RowResult:
        """One row, whatever goes wrong: an unexpected error is retried, then failed, and one bad
        row never stops the others. Errors are logged by class only: their text can name the
        key or a path."""
        try:
            return await self._copy_one(media_id, request_id, file_key, attempt)
        except Exception as error:  # noqa: BLE001 - see the docstring
            error_class = type(error).__name__
        try:
            return await self._transient(
                media_id, request_id, SanitizeFailure.INTERNAL, attempt, error_class
            )
        except Exception as error:  # noqa: BLE001 - the database fails too: the next try settles it
            logger.warning(
                "media_sanitize_retry",
                extra={
                    "media_id": str(media_id),
                    "service_request_id": str(request_id),
                    "reason": SanitizeFailure.INTERNAL.value,
                    "attempt": attempt,
                    "error_class": type(error).__name__,
                },
            )
            return "waiting"

    async def _copy_one(
        self, media_id: uuid.UUID, request_id: uuid.UUID, file_key: str, attempt: int
    ) -> _RowResult:
        try:
            safe_key, content_type = await self._copy(file_key)
        except SanitizeError as error:
            await self._fail(media_id, request_id, error.reason, error.exit_code)
            return "failed"
        except _TRANSIENT as error:
            return await self._transient(media_id, request_id, _transient_reason(error), attempt)
        if not await self._mark_ready(media_id, safe_key, content_type):
            return "skipped"
        logger.info(
            "media_sanitized",
            extra={"media_id": str(media_id), "service_request_id": str(request_id)},
        )
        return "ready"

    async def _transient(
        self,
        media_id: uuid.UUID,
        request_id: uuid.UUID,
        reason: SanitizeFailure,
        attempt: int,
        error_class: str | None = None,
    ) -> _RowResult:
        """A failure that may pass: retried, until the last try fails the row."""
        if attempt >= self._config.max_tries:
            await self._fail(media_id, request_id, reason, None)
            return "failed"
        extra: dict[str, object] = {
            "media_id": str(media_id),
            "service_request_id": str(request_id),
            "reason": reason.value,
            "attempt": attempt,
        }
        if error_class is not None:
            extra["error_class"] = error_class
        logger.warning("media_sanitize_retry", extra=extra)
        return "waiting"

    async def _copy(self, file_key: str) -> tuple[str, str]:
        """Original -> temporary file -> safe copy -> storage. The safe key and its type."""
        content_type = upload_content_type(file_key)
        if content_type is None:
            raise SanitizeError(SanitizeFailure.UNSUPPORTED)
        # ignore_cleanup_errors: on Windows a file still open in a cancelled thread would turn
        # the cancellation into a PermissionError. The OS temp cleanup removes what is left.
        with tempfile.TemporaryDirectory(
            prefix="media-copy-", ignore_cleanup_errors=True
        ) as directory:
            workdir = Path(directory)
            original = workdir / "original"
            await asyncio.to_thread(self._storage.download_to, file_key, original)
            safe = await sanitize(original, content_type, workdir, self._config.sanitize)
            safe_key = new_safe_key(safe.extension)
            await asyncio.to_thread(
                self._storage.upload_from, safe.path, safe_key, safe.content_type
            )
        return safe_key, safe.content_type

    async def _mark_ready(self, media_id: uuid.UUID, safe_key: str, content_type: str) -> bool:
        """False when another run already settled the row: its copy is kept, this one is not."""
        async with self._sessions() as session:
            media = await ServiceRequestRepository(session).media_for_update(media_id)
            if media is None or media.safe_status != MediaSafeStatus.PENDING:
                await session.commit()  # nothing changed: ends the transaction and its lock
                return False
            media.safe_key = safe_key
            media.safe_content_type = content_type
            media.safe_status = MediaSafeStatus.READY
            await session.commit()
        return True

    async def _fail(
        self,
        media_id: uuid.UUID,
        request_id: uuid.UUID,
        reason: SanitizeFailure,
        exit_code: int | None,
    ) -> None:
        async with self._sessions() as session:
            media = await ServiceRequestRepository(session).media_for_update(media_id)
            if media is None or media.safe_status != MediaSafeStatus.PENDING:
                await session.commit()  # nothing changed: ends the transaction and its lock
                return
            media.safe_status = MediaSafeStatus.FAILED
            await session.commit()
        extra: dict[str, object] = {
            "media_id": str(media_id),
            "service_request_id": str(request_id),
            "reason": reason.value,
        }
        if exit_code is not None:
            extra["ffmpeg_exit_code"] = exit_code
        logger.error("media_sanitize_failed", extra=extra)


_TRANSIENT: Final = (SanitizeRetryableError, StorageObjectMissingError, StorageUnavailableError)


def _transient_reason(
    error: SanitizeRetryableError | StorageObjectMissingError | StorageUnavailableError,
) -> SanitizeFailure:
    if isinstance(error, SanitizeRetryableError):
        return error.reason
    if isinstance(error, StorageObjectMissingError):
        return SanitizeFailure.MISSING
    return SanitizeFailure.STORAGE
