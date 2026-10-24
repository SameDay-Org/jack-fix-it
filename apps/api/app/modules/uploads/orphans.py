"""The sweep of uploads no row references (#191, plan task D6): privacy hardening found in #186.

Clients PUT files straight to the storage under `u/<user id>/<purpose>/<32 hex><ext>`
(service.py), and nothing records a key until a feature row attaches it. So a photo the
customer removed before submitting, an upload whose cancel arrived too late (#186), the files
of an app killed before submit and a pro's replaced profile photo would stay in the storage for
ever. This worker cron finds them and, in `delete` mode, deletes them.

What is never deleted:
- anything outside `u/`: safe copies (`m/`, #173) are not swept;
- an object last modified less than ORPHAN_UPLOAD_MIN_AGE_HOURS ago: its row may still be on
  its way (`too_young`);
- a key the uploads parser does not accept (`unparsed`);
- a purpose with no referencing table (SKIPPED), and a profile photo of anyone but a pro, since
  only pro profiles hold one (`skipped_purpose`);
- a key that any referencing column holds, whatever its purpose (`referenced`).

Each page of the listing is checked against the database when it arrives, in one query across
every referencing column, never against a snapshot taken before the listing: a key attached
while the listing ran is kept. The residual: a row that attaches a key after its page's check
(or commits after it) points at a deleted file. Only an object older than the minimum age is
ever in that window; a fresh upload never is.

Modes (ORPHAN_UPLOAD_MODE): `off` does nothing, not even a storage call; `dry_run` (the
default) counts and logs what it would delete; `delete` deletes. The logs are one
`orphan_uploads_swept` line of counts per run, and `orphan_upload_sweep_failed` with an error
class when the storage or the database fails, or ARQ stops the run at
ORPHAN_UPLOAD_SWEEP_TIMEOUT_SECONDS (the next run starts over). The summary's `completed` is
false for such a run: its counts cover the pages it reached, and a delete batch it was waiting
on when stopped is in none of them. Never a key or a user id: a key holds the owner's id and
the purpose.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable, Collection, Iterator, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy import Select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import OrphanUploadMode, Settings
from app.integrations.storage import (
    DELETE_BATCH_MAX,
    DeleteResult,
    ObjectPage,
    Storage,
    StorageUnavailableError,
)
from app.modules.pros.service import ProService
from app.modules.requests.service import media_keys_among
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.service import UploadKey, parse_upload_key
from app.modules.users.service import UserService
from app.modules.users.types import UserRole

logger = logging.getLogger(__name__)

UPLOAD_PREFIX: Final = "u/"


class ReferencingColumn(StrEnum):
    """A column that holds upload keys."""

    REQUEST_MEDIA_FILE_KEY = "request_media.file_key"
    PRO_DOCUMENTS_FILE_KEY = "pro_documents.file_key"
    PRO_PROFILES_PHOTO_KEY = "pro_profiles.photo_key"


@dataclass(frozen=True)
class References:
    """Where a purpose's files are attached."""

    columns: frozenset[ReferencingColumn]
    # Set when only owners with this role have a column for the purpose: anyone else's files
    # are skipped, never deleted.
    owner_role: UserRole | None = None


# Every purpose is in exactly one of these two (tests/test_orphan_uploads.py): a new purpose
# needs a decision before the sweep runs on it.
REFERENCED_BY: Final[Mapping[UploadPurpose, References]] = {
    UploadPurpose.REQUEST_MEDIA: References(frozenset({ReferencingColumn.REQUEST_MEDIA_FILE_KEY})),
    UploadPurpose.PRO_DOCUMENT: References(frozenset({ReferencingColumn.PRO_DOCUMENTS_FILE_KEY})),
    # Customers have no profile-photo column yet.
    UploadPurpose.PROFILE_PHOTO: References(
        frozenset({ReferencingColumn.PRO_PROFILES_PHOTO_KEY}), owner_role=UserRole.PRO
    ),
}
# No table references these yet: job photos wait for #63.
SKIPPED: Final[frozenset[UploadPurpose]] = frozenset({UploadPurpose.JOB_PHOTO})

KeyStatement = Callable[[Collection[str]], Select[str] | Select[str | None]]
# Each column's query, from the module that owns its table (ADR 0003).
KEY_STATEMENTS: Final[Mapping[ReferencingColumn, KeyStatement]] = {
    ReferencingColumn.REQUEST_MEDIA_FILE_KEY: media_keys_among,
    ReferencingColumn.PRO_DOCUMENTS_FILE_KEY: ProService.document_keys_among,
    ReferencingColumn.PRO_PROFILES_PHOTO_KEY: ProService.photo_keys_among,
}

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass(frozen=True)
class OrphanSweepConfig:
    mode: OrphanUploadMode
    min_age: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "OrphanSweepConfig":
        return cls(
            mode=settings.orphan_upload_mode,
            min_age=timedelta(hours=settings.orphan_upload_min_age_hours),
        )


@dataclass
class SweepCounts:
    """One run's counts. Every object listed lands in exactly one of too_young, unparsed,
    skipped_purpose, referenced and orphaned. Of the orphaned ones a delete was tried on, deleted
    counts those gone and failed those the storage refused or failed on (still there); a batch
    an unexpected error or a cancellation cut is in neither."""

    scanned: int = 0
    too_young: int = 0
    referenced: int = 0
    orphaned: int = 0
    deleted: int = 0
    unparsed: int = 0
    skipped_purpose: int = 0
    failed: int = 0


class OrphanUploadSweeper:
    def __init__(
        self,
        sessions: SessionFactory,
        storage: Storage,
        config: OrphanSweepConfig,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._config = config
        self._clock = clock

    async def sweep(self) -> SweepCounts:
        """One run over every upload, page by page. Never raises (but a cancellation): a
        failure ends the run, is logged with its class only, and the next run starts over."""
        counts = SweepCounts()
        if self._config.mode == "off":
            return counts
        before = self._clock() - self._config.min_age
        completed = False
        try:
            pages = self._storage.list_older_than(UPLOAD_PREFIX, before)
            while (page := await asyncio.to_thread(_next_page, pages)) is not None:
                await self._sweep_page(page, before, counts)
            completed = True
        except asyncio.CancelledError:
            # ARQ's timeout: logged like a failure, then ARQ's to finish.
            self._log_failure("CancelledError")
            raise
        except Exception as error:  # noqa: BLE001 - ARQ would log the error's text, and a storage or driver message can hold a key
            self._log_failure(type(error).__name__)
        finally:
            # Also after a failure or a cancellation: what the run did so far is on record.
            logger.info(
                "orphan_uploads_swept",
                extra={"mode": self._config.mode, "completed": completed, **asdict(counts)},
            )
        return counts

    def _log_failure(self, error_class: str) -> None:
        logger.warning(
            "orphan_upload_sweep_failed",
            extra={"mode": self._config.mode, "error_class": error_class},
        )

    async def _sweep_page(self, page: ObjectPage, before: datetime, counts: SweepCounts) -> None:
        counts.scanned += len(page.objects) + page.newer
        counts.too_young += page.newer
        candidates: dict[str, UploadKey] = {}
        for stored in page.objects:
            if stored.last_modified >= before:
                # The storage leaves these out already; checked again, as deleting is final.
                counts.too_young += 1
                continue
            parsed = parse_upload_key(stored.key)
            if parsed is None:
                counts.unparsed += 1
            elif parsed.purpose in SKIPPED:
                counts.skipped_purpose += 1
            else:
                candidates[stored.key] = parsed
        if not candidates:
            return
        # The page's check runs now, on what the database holds after the listing.
        async with self._sessions() as session:
            skipped = await _skipped_by_owner(session, candidates)
            checked = [key for key in candidates if key not in skipped]
            referenced = await _referenced(session, checked)
        orphans = [key for key in checked if key not in referenced]
        counts.skipped_purpose += len(skipped)
        counts.referenced += len(checked) - len(orphans)
        counts.orphaned += len(orphans)
        if self._config.mode != "delete":
            return
        for start in range(0, len(orphans), DELETE_BATCH_MAX):
            batch = orphans[start : start + DELETE_BATCH_MAX]
            try:
                result: DeleteResult = await asyncio.to_thread(self._storage.delete_many, batch)
            except StorageUnavailableError:
                counts.failed += len(batch)
                raise
            counts.deleted += result.deleted
            counts.failed += result.failed


def _next_page(pages: Iterator[ObjectPage]) -> ObjectPage | None:
    """The next page, or None after the last; it blocks on the storage (a thread runs it)."""
    return next(pages, None)


async def _skipped_by_owner(session: AsyncSession, candidates: Mapping[str, UploadKey]) -> set[str]:
    """The keys whose purpose only some owners have a column for, of anyone else: read now,
    one query per role."""
    owners: dict[UserRole, set[uuid.UUID]] = {}
    for parsed in candidates.values():
        role = REFERENCED_BY[parsed.purpose].owner_role
        if role is not None:
            owners.setdefault(role, set()).add(parsed.owner_id)
    allowed = {
        role: await UserService(session).ids_with_role(ids, role) for role, ids in owners.items()
    }
    skipped: set[str] = set()
    for key, parsed in candidates.items():
        role = REFERENCED_BY[parsed.purpose].owner_role
        if role is not None and parsed.owner_id not in allowed[role]:
            skipped.add(key)
    return skipped


async def _referenced(session: AsyncSession, keys: Sequence[str]) -> set[str]:
    """The keys among `keys` that any referencing column holds, in one query."""
    if not keys:
        return set()
    statement = union_all(*(key_statement(keys) for key_statement in KEY_STATEMENTS.values()))
    return {key for key in (await session.scalars(statement)).all() if key is not None}
