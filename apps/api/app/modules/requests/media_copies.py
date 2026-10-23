"""Privacy-safe copies of a request's photos and videos (#173), made by the worker.

POST /v1/requests queues sanitize_request_media after its commit. For each media row still
pending, the job downloads the original to a temporary file, makes the safe copy
(app/modules/media/sanitize.py), uploads it under an opaque key (m/<32 hex><ext>: no user id,
no purpose) and marks the row ready in one short transaction. Temporary files are deleted in
every case. A row already ready or failed is skipped. A row has one key, derived from its id: a
try again, or an upload a timeout left running, rewrites that one copy and never leaves another.

A transient failure (the storage, a timeout, ffmpeg missing for now) leaves the row pending and
asks for a retry, until the job's last try, where it fails like a file that can never be made
safe (it does not decode, has too many pixels, ffmpeg rejects it). A failed row is never served.

ARQ stops a job at MEDIA_SANITIZE_JOB_TIMEOUT_SECONDS and never runs it again, so a try stops
itself first. Every step has a bound: a download, an image transform, an ffmpeg or ffprobe run
and an upload get MEDIA_SANITIZE_TIMEOUT_SECONDS each, a database step
MEDIA_SANITIZE_OVERHEAD_SECONDS. No step goes past the try's work deadline,
MEDIA_SANITIZE_SETTLE_SECONDS before ARQ's. A file starts only while the try has time for its
whole budget (Settings.media_sanitize_min_job_seconds gives the first one that time). The files
a try had no time for, or that its deadline cut, go on in the next try, or fail (timeout) in one
write on the last two (with a row whose own failing write failed). The very last try never asks
for a retry: ARQ would refuse it.

A transfer or an image transform runs in a thread, which a timeout cannot stop: the row's
temporary directory stays until the thread ends, so no thread ever writes to a removed file.

Logs carry the media id, the request id and a reason code: never a key (the original's names
the customer), a path or ffmpeg's output.
"""

import asyncio
import logging
import math
import shutil
import tempfile
import threading
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from functools import partial
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
    SafeFile,
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
# Makes a row's safe key from its id (uuid5): stable for the row, and its id cannot be read back.
_SAFE_KEY_NAMESPACE: Final = uuid.UUID("5d1f0b0e-6a43-4f4e-9b8a-173c0a5e1d7f")
# The threads of transfers and image transforms. A timed-out one cannot be stopped: it ends on
# its own (the storage's connect and read timeouts, an image's pixel cap).
_THREADS: Final = ThreadPoolExecutor(thread_name_prefix="media-copy")


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


def safe_key_for(media_id: uuid.UUID, extension: str) -> str:
    """The row's one safe key: every try, and any upload left running, writes the same object."""
    return f"{SAFE_KEY_PREFIX}{uuid.uuid5(_SAFE_KEY_NAMESPACE, str(media_id)).hex}{extension}"


@dataclass(frozen=True)
class MediaCopyConfig:
    max_tries: int
    sanitize: SanitizeConfig  # its timeout_seconds bounds each step of a file's copy
    # One try's time (ARQ's timeout) and one file's whole budget: see the module docstring.
    job_budget_seconds: float = math.inf
    row_budget_seconds: float = 0.0
    overhead_seconds: float = math.inf  # one database step
    settle_seconds: float = 0.0  # the end of a try, kept for after its work

    @classmethod
    def from_settings(cls, settings: Settings) -> "MediaCopyConfig":
        return cls(
            max_tries=settings.media_sanitize_max_tries,
            sanitize=SanitizeConfig.from_settings(settings),
            job_budget_seconds=settings.media_sanitize_job_timeout_seconds,
            row_budget_seconds=settings.media_sanitize_row_budget_seconds,
            overhead_seconds=settings.media_sanitize_overhead_seconds,
            settle_seconds=settings.media_sanitize_settle_seconds,
        )


@dataclass(frozen=True)
class MediaCopyOutcome:
    ready: int = 0
    failed: int = 0
    waiting: int = 0  # still pending after a transient failure: the job should run again
    deferred: int = 0  # not tried, or cut by the try's deadline: the next try goes on

    def __str__(self) -> str:
        return (
            f"ready={self.ready} failed={self.failed} waiting={self.waiting} "
            f"deferred={self.deferred}"
        )


class _OutOfTimeError(Exception):
    """The try reached its work deadline: no step starts or goes on, what is left is settled."""


async def _within[T](
    seconds: float, start: Callable[[], Awaitable[T]], timed_out: Callable[[], Exception]
) -> T:
    """`start()`'s result within `seconds`; past them, the step is cancelled and `timed_out()`
    raised."""
    timeout = asyncio.timeout(None if math.isinf(seconds) else seconds)
    try:
        async with timeout:
            return await start()
    except TimeoutError:
        if not timeout.expired():
            raise  # the step's own error, not this bound
        raise timed_out() from None


def _step_timed_out() -> SanitizeRetryableError:
    return SanitizeRetryableError(SanitizeFailure.TIMEOUT)


class _Try:
    """One try's clock. Its work ends `settle_seconds` before ARQ's timeout."""

    def __init__(self, config: MediaCopyConfig, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._end = clock() + config.job_budget_seconds
        self._work_end = self._end - config.settle_seconds

    def work_left(self) -> float:
        return self._work_end - self._clock()

    def left(self) -> float:
        """Until ARQ's timeout: what the last try's settlement may use."""
        return self._end - self._clock()

    async def step[T](
        self,
        start: Callable[[], Awaitable[T]],
        seconds: float,
        timed_out: Callable[[], Exception],
    ) -> T:
        """`start()` within `seconds` (past them: `timed_out()`), and never past the work
        deadline (there: _OutOfTimeError)."""
        left = self.work_left()
        if left <= 0:
            raise _OutOfTimeError
        if left < seconds:
            return await _within(left, start, _OutOfTimeError)
        return await _within(seconds, start, timed_out)


class _Workdir:
    """A row's temporary directory. It is removed once the row is done and no thread of the
    row still runs: a thread a timeout left behind keeps its files until it ends."""

    def __init__(self) -> None:
        self.path = Path(tempfile.mkdtemp(prefix="media-copy-"))
        self._lock = threading.Lock()
        self._running = 0
        self._closed = False

    def run[T](self, work: Callable[[], T]) -> asyncio.Future[T]:
        """`work()` in a thread. Cancelling the result abandons the thread, never its files."""
        with self._lock:
            self._running += 1
        try:
            future = _THREADS.submit(work)
        except BaseException:
            self._thread_done(None)
            raise
        future.add_done_callback(self._thread_done)
        return asyncio.wrap_future(future)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            idle = self._running == 0
        if idle:
            self._remove()

    def _thread_done(self, _: object) -> None:
        with self._lock:
            self._running -= 1
            last = self._closed and self._running == 0
        if last:
            self._remove()

    def _remove(self) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


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
        The first row always starts; a later one only while the try has time for its whole
        budget. The rows a try had no time for, or that its deadline cut, are deferred to the
        next try. A `final` try fails them (timeout) instead, with the rows whose own failing
        write failed, in one write from the settle reserve. TimeoutError when the database does
        not answer in time."""
        run = _Try(self._config, clock)
        try:
            pending = await run.step(
                partial(self._pending, request_id), self._config.overhead_seconds, TimeoutError
            )
        except _OutOfTimeError:
            raise TimeoutError from None
        settled: dict[_RowResult, int] = {"ready": 0, "failed": 0, "waiting": 0, "skipped": 0}
        unsettled: list[uuid.UUID] = []
        stuck: list[uuid.UUID] = []  # final: rows still waiting after their failing write failed
        for index, (media_id, file_key) in enumerate(pending):
            if unsettled or (index > 0 and run.work_left() < self._config.row_budget_seconds):
                unsettled.append(media_id)
                continue
            try:
                result = await self._copy_guarded(run, media_id, request_id, file_key, attempt)
            except _OutOfTimeError:
                unsettled.append(media_id)
                continue
            if final and result == "waiting":
                stuck.append(media_id)
            else:
                settled[result] += 1
        if final and (unsettled or stuck):
            reasons = {
                **dict.fromkeys(unsettled, SanitizeFailure.TIMEOUT),
                **dict.fromkeys(stuck, SanitizeFailure.INTERNAL),
            }
            settled["failed"] += await self._fail_unsettled(run, request_id, reasons)
            unsettled = []
        return MediaCopyOutcome(
            ready=settled["ready"],
            failed=settled["failed"],
            waiting=settled["waiting"],
            deferred=len(unsettled),
        )

    async def _pending(self, request_id: uuid.UUID) -> list[tuple[uuid.UUID, str]]:
        async with self._sessions() as session:
            return [
                (media.id, media.file_key)
                for media in await ServiceRequestRepository(session).pending_media(request_id)
            ]

    async def _copy_guarded(
        self,
        run: _Try,
        media_id: uuid.UUID,
        request_id: uuid.UUID,
        file_key: str,
        attempt: int,
    ) -> _RowResult:
        """One row, whatever goes wrong: an unexpected error is retried, then failed, and one bad
        row never stops the others. Errors are logged by class only: their text can name the
        key or a path. The try's deadline is not the row's error: it stops the loop."""
        try:
            return await self._copy_one(run, media_id, request_id, file_key, attempt)
        except _OutOfTimeError:
            raise
        except Exception as error:  # noqa: BLE001 - see the docstring
            error_class = type(error).__name__
        try:
            return await self._transient(
                run, media_id, request_id, SanitizeFailure.INTERNAL, attempt, error_class
            )
        except _OutOfTimeError:
            raise
        # The database fails too: the next try, or a final try's settlement, settles it.
        except Exception as error:  # noqa: BLE001
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
        self,
        run: _Try,
        media_id: uuid.UUID,
        request_id: uuid.UUID,
        file_key: str,
        attempt: int,
    ) -> _RowResult:
        try:
            safe_key, content_type = await self._copy(run, media_id, file_key)
        except SanitizeError as error:
            await self._fail(run, media_id, request_id, error.reason, error.exit_code)
            return "failed"
        except _TRANSIENT as error:
            return await self._transient(
                run, media_id, request_id, _transient_reason(error), attempt
            )
        marked = await run.step(
            partial(self._mark_ready, media_id, safe_key, content_type),
            self._config.overhead_seconds,
            TimeoutError,
        )
        if not marked:
            return "skipped"
        logger.info(
            "media_sanitized",
            extra={"media_id": str(media_id), "service_request_id": str(request_id)},
        )
        return "ready"

    async def _transient(
        self,
        run: _Try,
        media_id: uuid.UUID,
        request_id: uuid.UUID,
        reason: SanitizeFailure,
        attempt: int,
        error_class: str | None = None,
    ) -> _RowResult:
        """A failure that may pass: retried, until the last try fails the row."""
        if attempt >= self._config.max_tries:
            await self._fail(run, media_id, request_id, reason, None)
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

    async def _copy(self, run: _Try, media_id: uuid.UUID, file_key: str) -> tuple[str, str]:
        """Original -> temporary file -> safe copy -> storage. The safe key and its type."""
        content_type = upload_content_type(file_key)
        if content_type is None:
            raise SanitizeError(SanitizeFailure.UNSUPPORTED)
        seconds = self._config.sanitize.timeout_seconds
        workdir = _Workdir()
        try:
            original = workdir.path / "original"
            download = partial(self._storage.download_to, file_key, original)
            await run.step(partial(workdir.run, download), seconds, _step_timed_out)
            # The transform's own steps are bounded inside: each ffmpeg or ffprobe run, and the
            # image thread (in_thread). Here only the try's deadline applies.
            transform = partial(
                sanitize,
                original,
                content_type,
                workdir.path,
                self._config.sanitize,
                in_thread=partial(_bounded_thread, workdir, seconds),
            )
            safe = await run.step(transform, math.inf, _OutOfTimeError)
            safe_key = safe_key_for(media_id, safe.extension)
            upload = partial(self._storage.upload_from, safe.path, safe_key, safe.content_type)
            await run.step(partial(workdir.run, upload), seconds, _step_timed_out)
        finally:
            workdir.close()
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
        run: _Try,
        media_id: uuid.UUID,
        request_id: uuid.UUID,
        reason: SanitizeFailure,
        exit_code: int | None,
    ) -> None:
        failed = await run.step(
            partial(self._fail_rows, [media_id]), self._config.overhead_seconds, TimeoutError
        )
        if not failed:
            return  # another run had already settled it
        extra: dict[str, object] = {
            "media_id": str(media_id),
            "service_request_id": str(request_id),
            "reason": reason.value,
        }
        if exit_code is not None:
            extra["ffmpeg_exit_code"] = exit_code
        logger.error("media_sanitize_failed", extra=extra)

    async def _fail_unsettled(
        self, run: _Try, request_id: uuid.UUID, reasons: dict[uuid.UUID, SanitizeFailure]
    ) -> int:
        """A final try's settlement: the rows it could not settle fail in one write, within
        MEDIA_SANITIZE_OVERHEAD_SECONDS and what is left before ARQ's timeout (the settle
        reserve: past the work deadline, never cut by it)."""
        seconds = min(self._config.overhead_seconds, run.left())
        failed = await _within(seconds, partial(self._fail_rows, list(reasons)), TimeoutError)
        for media_id in failed:
            logger.error(
                "media_sanitize_failed",
                extra={
                    "media_id": str(media_id),
                    "service_request_id": str(request_id),
                    "reason": reasons[media_id].value,
                },
            )
        return len(failed)

    async def _fail_rows(self, media_ids: Sequence[uuid.UUID]) -> list[uuid.UUID]:
        """Marks those of the rows still pending failed; the ids it changed (another run may
        have settled the rest)."""
        async with self._sessions() as session:
            failed = await ServiceRequestRepository(session).fail_pending_media(media_ids)
            await session.commit()
        return failed


async def _bounded_thread(
    workdir: _Workdir, seconds: float, work: Callable[[], SafeFile]
) -> SafeFile:
    """The image transform in one of the row's threads, within `seconds`."""
    return await _within(seconds, partial(workdir.run, work), _step_timed_out)


_TRANSIENT: Final = (SanitizeRetryableError, StorageObjectMissingError, StorageUnavailableError)


def _transient_reason(
    error: SanitizeRetryableError | StorageObjectMissingError | StorageUnavailableError,
) -> SanitizeFailure:
    if isinstance(error, SanitizeRetryableError):
        return error.reason
    if isinstance(error, StorageObjectMissingError):
        return SanitizeFailure.MISSING
    return SanitizeFailure.STORAGE
