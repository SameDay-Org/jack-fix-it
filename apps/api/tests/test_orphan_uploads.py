"""The sweep of uploads no row references (#191): what it deletes, what it never does, its logs.

An in-memory storage that lists and deletes; the real database (rolled back) for the reference
checks. The S3 side of listing and deleting is in test_storage_adapter.py.
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import OrphanUploadMode
from app.db import Base
from app.integrations.storage import (
    DELETE_BATCH_MAX,
    DeleteResult,
    ObjectPage,
    PresignedUpload,
    StorageUnavailableError,
    StoredObject,
)
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.categories.service import CategoryService
from app.modules.pros.models import ProDocument, ProDocumentType, ProProfile
from app.modules.pros.schemas import ProProfileUpdate
from app.modules.pros.service import ProProfileConfig, ProProfileService
from app.modules.requests.models import (
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    ServiceRequest,
)
from app.modules.service_areas.service import ServiceAreaService
from app.modules.uploads.orphans import (
    KEY_STATEMENTS,
    REFERENCED_BY,
    SKIPPED,
    UPLOAD_PREFIX,
    OrphanSweepConfig,
    OrphanUploadSweeper,
    ReferencingColumn,
    SweepCounts,
)
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.tasks import sweep_orphan_uploads
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserRole, UserStatus
from app.observability import configure_logging
from tests.conftest import make_settings
from tests.test_media_logging import leaks
from tests.test_schema_requests_jobs import add

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
MIN_AGE = timedelta(hours=24)
OLD = NOW - MIN_AGE - timedelta(minutes=1)
YOUNG = NOW - MIN_AGE + timedelta(minutes=1)
# Upload key columns that are not uploads: the opaque safe copies (#173), never swept.
NOT_UPLOAD_KEYS = {"request_media.safe_key"}


@dataclass
class ListingStorage:
    """The storage port in memory: each object's last-modified time by key; every call by
    name. Pages of `page_size` keys in key order, cut by `before` as S3 does. The knobs make it
    misbehave: `stray` keys are listed under any prefix, `ignore_before` lists young objects
    as old, `list_error` is raised for page `fail_at_page`, `delete_error` on every delete, and
    `undeletable` keys come back as errors of a DeleteObjects call."""

    objects: dict[str, datetime] = field(default_factory=dict)
    page_size: int = 1_000
    stray: set[str] = field(default_factory=set)
    ignore_before: bool = False
    list_error: Exception | None = None
    fail_at_page: int = 0
    delete_error: Exception | None = None
    undeletable: set[str] = field(default_factory=set)
    calls: list[str] = field(default_factory=list)
    delete_batches: list[list[str]] = field(default_factory=list)
    listed: bool = False  # a page went out

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - the sweep never presigns
        raise AssertionError("the sweep never presigns")

    def presign_get(self, key: str, expires_in: int) -> str:
        self.calls.append("presign_get")  # the pro profile's own answer
        return "https://storage.example.invalid/get"

    def download_to(self, key: str, path: Path) -> None:  # pragma: no cover
        raise AssertionError("the sweep never downloads")

    def upload_from(self, path: Path, key: str, content_type: str) -> None:  # pragma: no cover
        raise AssertionError("the sweep never uploads")

    def list_older_than(self, prefix: str, before: datetime) -> Iterator[ObjectPage]:
        self.calls.append("list")
        keys = sorted(k for k in self.objects if k.startswith(prefix) or k in self.stray)
        for number, start in enumerate(range(0, len(keys), self.page_size)):
            if self.list_error is not None and number == self.fail_at_page:
                raise self.list_error
            page = [StoredObject(k, self.objects[k]) for k in keys[start : start + self.page_size]]
            older = [o for o in page if self.ignore_before or o.last_modified < before]
            self.listed = True
            yield ObjectPage(objects=older, newer=len(page) - len(older))

    def delete_many(self, keys: Sequence[str]) -> DeleteResult:
        self.calls.append("delete")
        self.delete_batches.append(list(keys))
        if self.delete_error is not None:
            raise self.delete_error
        failed = [key for key in keys if key in self.undeletable]
        for key in keys:
            if key not in self.undeletable:
                self.objects.pop(key, None)
        return DeleteResult(deleted=len(keys) - len(failed), failed=len(failed))


Sessions = Callable[[], AbstractAsyncContextManager[AsyncSession]]


def sessions_of(
    session: AsyncSession, before_each: Callable[[], Awaitable[None]] | None = None
) -> Sessions:
    """A session factory that hands out the rolled-back test session, after `before_each`."""

    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        if before_each is not None:
            await before_each()
        yield session

    return factory


def sweeper(
    sessions: Sessions, storage: ListingStorage, mode: OrphanUploadMode = "delete"
) -> OrphanUploadSweeper:
    return OrphanUploadSweeper(sessions, storage, OrphanSweepConfig(mode, MIN_AGE), lambda: NOW)


def upload_key(owner_id: uuid.UUID, purpose: UploadPurpose, extension: str = ".jpg") -> str:
    return f"u/{owner_id}/{purpose.value}/{uuid.uuid4().hex}{extension}"


@dataclass(frozen=True)
class World:
    customer: User
    pro: User
    profile: ProProfile
    request: ServiceRequest


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    tag = uuid.uuid4().hex[:8]
    customer = User(email=f"c-{tag}@x.com", password_hash="x", role=UserRole.CUSTOMER)
    pro = User(email=f"p-{tag}@x.com", password_hash="x", role=UserRole.PRO)
    category = Category(slug=f"orphans-{tag}", names={"en": "Test", "es": "Prueba"})
    await add(db_session, customer, pro, category)
    address = Address(
        user_id=customer.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    profile = ProProfile(user_id=pro.id)
    await add(db_session, address, profile)
    request = ServiceRequest(
        customer_id=customer.id,
        category_id=category.id,
        address_id=address.id,
        description="Fix a leak",
        origin=RequestOrigin.APP,
    )
    await add(db_session, request)
    return World(customer, pro, profile, request)


async def attach_media(session: AsyncSession, world: World, key: str) -> None:
    await add(
        session,
        RequestMedia(request_id=world.request.id, kind=RequestMediaKind.PHOTO, file_key=key),
    )


async def attach_document(session: AsyncSession, world: World, key: str) -> None:
    await add(
        session, ProDocument(pro_id=world.profile.id, doc_type=ProDocumentType.ID, file_key=key)
    )


async def attach_photo(session: AsyncSession, world: World, key: str) -> None:
    world.profile.photo_key = key
    await session.flush()


@dataclass(frozen=True)
class Column:
    purpose: UploadPurpose
    owner: Callable[[World], uuid.UUID]
    attach: Callable[[AsyncSession, World, str], Awaitable[None]]


# One per referencing column.
COLUMNS = [
    Column(UploadPurpose.REQUEST_MEDIA, lambda w: w.customer.id, attach_media),
    Column(UploadPurpose.PRO_DOCUMENT, lambda w: w.pro.id, attach_document),
    Column(UploadPurpose.PROFILE_PHOTO, lambda w: w.pro.id, attach_photo),
]


def counts(**values: int) -> SweepCounts:
    return SweepCounts(**values)


async def test_dry_run_deletes_nothing_and_counts(db_session: AsyncSession, world: World) -> None:
    orphan = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    kept = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    young = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    await attach_media(db_session, world, kept)
    storage = ListingStorage({orphan: OLD, kept: OLD, young: YOUNG})

    result = await sweeper(sessions_of(db_session), storage, "dry_run").sweep()

    assert result == counts(scanned=3, too_young=1, referenced=1, orphaned=1)
    assert set(storage.objects) == {orphan, kept, young}
    assert storage.calls == ["list"]


async def test_delete_mode_removes_only_old_unreferenced_keys(
    db_session: AsyncSession, world: World
) -> None:
    storage = ListingStorage()
    expected_left: set[str] = set()
    for column in COLUMNS:
        owner = column.owner(world)
        old_orphan, young_orphan = (
            upload_key(owner, column.purpose),
            upload_key(owner, column.purpose),
        )
        old_kept, young_kept = upload_key(owner, column.purpose), upload_key(owner, column.purpose)
        storage.objects |= {old_orphan: OLD, young_orphan: YOUNG, old_kept: OLD, young_kept: YOUNG}
        expected_left |= {young_orphan, old_kept, young_kept}
        await column.attach(db_session, world, old_kept)
        if column.purpose is not UploadPurpose.PROFILE_PHOTO:  # a profile holds one photo
            await column.attach(db_session, world, young_kept)

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == expected_left
    assert result == counts(scanned=12, too_young=6, referenced=3, orphaned=3, deleted=3)


async def test_an_object_exactly_at_the_minimum_age_is_too_young(
    db_session: AsyncSession, world: World
) -> None:
    key = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    storage = ListingStorage({key: NOW - MIN_AGE})

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert key in storage.objects
    assert result == counts(scanned=1, too_young=1)


async def test_young_objects_a_storage_lists_as_old_are_kept(
    db_session: AsyncSession, world: World
) -> None:
    # The sweep checks the age again: deleting is final.
    young = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    old = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    storage = ListingStorage({young: YOUNG, old: OLD}, ignore_before=True)

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == {young}
    assert result == counts(scanned=2, too_young=1, orphaned=1, deleted=1)


async def test_skipped_purposes_are_never_deleted(db_session: AsyncSession, world: World) -> None:
    job_photos = {upload_key(world.pro.id, UploadPurpose.JOB_PHOTO) for _ in range(3)}
    storage = ListingStorage(dict.fromkeys(job_photos, OLD))

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == job_photos
    assert result == counts(scanned=3, skipped_purpose=3)
    assert "delete" not in storage.calls


@pytest.mark.parametrize("owner", ["customer", "agent", "admin", "unknown"])
async def test_profile_photos_of_anyone_but_a_pro_are_never_deleted(
    db_session: AsyncSession, world: World, owner: str
) -> None:
    # Only pro profiles hold a photo: nothing tells a customer's photo is unused.
    if owner == "customer":
        owner_id = world.customer.id
    elif owner == "unknown":
        owner_id = uuid.uuid4()
    else:
        staff = User(
            email=f"{owner}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole(owner)
        )
        await add(db_session, staff)
        owner_id = staff.id
    photo = upload_key(owner_id, UploadPurpose.PROFILE_PHOTO)
    pro_photo = upload_key(world.pro.id, UploadPurpose.PROFILE_PHOTO)
    storage = ListingStorage({photo: OLD, pro_photo: OLD})

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == {photo}
    assert result == counts(scanned=2, skipped_purpose=1, orphaned=1, deleted=1)


async def test_a_suspended_pros_unused_photo_is_still_an_orphan(
    db_session: AsyncSession, world: World
) -> None:
    world.pro.status = UserStatus.SUSPENDED
    await db_session.flush()
    photo = upload_key(world.pro.id, UploadPurpose.PROFILE_PHOTO)
    storage = ListingStorage({photo: OLD})

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert storage.objects == {}
    assert result == counts(scanned=1, orphaned=1, deleted=1)


def test_every_purpose_is_mapped_or_skipped() -> None:
    mapped, skipped = set(REFERENCED_BY), set(SKIPPED)

    assert mapped.isdisjoint(skipped)
    assert mapped | skipped == set(UploadPurpose)
    # Every column the mapping names has its query, and every query is of a known column.
    named = {column for references in REFERENCED_BY.values() for column in references.columns}
    assert named == set(KEY_STATEMENTS) == set(ReferencingColumn)


def test_every_upload_key_column_is_a_referencing_column() -> None:
    # A new column that stores upload keys needs a place in the mapping, or the sweep would
    # delete the files it holds.
    key_columns = {
        f"{table.name}.{column.name}"
        for table in Base.metadata.tables.values()
        for column in table.columns
        if column.name.endswith("_key")
    }

    assert key_columns - NOT_UPLOAD_KEYS == {column.value for column in ReferencingColumn}


async def test_unparseable_keys_are_never_deleted(db_session: AsyncSession, world: World) -> None:
    owner, hex32 = world.customer.id, uuid.uuid4().hex
    unparsed = {
        "u/x",
        f"u/{owner}/request_media/{hex32[:31]}.jpg",  # a wrong hex length
        f"u/{owner}/request_media/{hex32}0.jpg",
        f"u/{owner}/avatar/{hex32}.jpg",  # an unknown purpose
        f"u/{owner}/request_media/{hex32}.gif",  # an extension no upload gets
        f"u/{str(owner).upper()}/request_media/{hex32}.jpg",
        f"u/{owner}/request_media/{hex32}.jpg/extra",
        f"u/{owner}/request_media/../{hex32}.jpg",
        f"u/{owner}/request_media/{hex32}.JPG",
        f"m/{hex32}.jpg",  # a safe copy (#173), listed by a storage that misbehaves
    }
    storage = ListingStorage(dict.fromkeys(unparsed, OLD), stray={f"m/{hex32}.jpg"})

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == unparsed
    assert result == counts(scanned=len(unparsed), unparsed=len(unparsed))
    assert "delete" not in storage.calls


async def test_only_the_upload_prefix_is_listed(db_session: AsyncSession, world: World) -> None:
    safe_copy = f"m/{uuid.uuid4().hex}.jpg"
    storage = ListingStorage({safe_copy: OLD})

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert UPLOAD_PREFIX == "u/"
    assert storage.objects == {safe_copy: OLD}
    assert result == counts()


async def test_key_attached_between_list_and_check_is_kept(
    db_session: AsyncSession, world: World
) -> None:
    attached, orphan = (upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA) for _ in "ab")
    storage = ListingStorage({attached: OLD, orphan: OLD})
    done: list[bool] = []

    async def attach_once_listed() -> None:
        # A request is created with the file once its page is listed, before the page's check.
        if storage.listed and not done:
            await attach_media(db_session, world, attached)
            done.append(True)

    result = await sweeper(sessions_of(db_session, attach_once_listed), storage).sweep()

    assert done == [True]
    assert set(storage.objects) == {attached}
    assert result == counts(scanned=2, referenced=1, orphaned=1, deleted=1)


async def test_replaced_pro_photo_becomes_orphan(db_session: AsyncSession, world: World) -> None:
    first, second = (upload_key(world.pro.id, UploadPurpose.PROFILE_PHOTO) for _ in "ab")
    storage = ListingStorage({first: OLD, second: OLD})
    profiles = ProProfileService(
        db_session,
        CategoryService(db_session),
        ServiceAreaService(db_session),
        storage,
        ProProfileConfig.from_settings(make_settings()),
    )
    account = await UserService(db_session).get_by_id(world.pro.id)
    assert account is not None
    await profiles.update_own(account, ProProfileUpdate(photo_key=first))
    await profiles.update_own(account, ProProfileUpdate(photo_key=second))

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == {second}
    assert result == counts(scanned=2, referenced=1, orphaned=1, deleted=1)


async def test_off_mode_touches_no_storage(caplog: pytest.LogCaptureFixture) -> None:
    storage = ListingStorage({f"u/{uuid.uuid4()}/request_media/{uuid.uuid4().hex}.jpg": OLD})

    def no_session() -> AbstractAsyncContextManager[AsyncSession]:
        raise AssertionError("off mode opened a session")

    ctx: dict[str, object] = {
        "settings": make_settings(orphan_upload_mode="off"),
        "storage": storage,
        "session_factory": no_session,
    }

    with caplog.at_level(logging.DEBUG):
        await sweep_orphan_uploads(ctx)
        # Without storage either: off is not a missing configuration.
        await sweep_orphan_uploads({**ctx, "storage": None})
        result = await sweeper(no_session, storage, "off").sweep()

    assert storage.calls == []
    assert result == counts()
    assert caplog.records == []


async def test_the_task_without_storage_logs_and_returns(caplog: pytest.LogCaptureFixture) -> None:
    ctx: dict[str, object] = {"settings": make_settings(), "storage": None}

    with caplog.at_level(logging.INFO):
        await sweep_orphan_uploads(ctx)

    assert [r.message for r in caplog.records] == ["orphan_upload_sweep_unconfigured"]
    assert caplog.records[0].__dict__["mode"] == "dry_run"


async def test_the_task_sweeps_with_the_settings(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    orphan = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    storage = ListingStorage({orphan: datetime.now(UTC) - timedelta(hours=3)})
    ctx: dict[str, object] = {
        "settings": make_settings(orphan_upload_mode="delete", orphan_upload_min_age_hours=2),
        "storage": storage,
        "session_factory": sessions_of(db_session),
    }

    with caplog.at_level(logging.INFO):
        await sweep_orphan_uploads(ctx)

    assert storage.objects == {}
    [summary] = [r for r in caplog.records if r.message == "orphan_uploads_swept"]
    assert (summary.__dict__["mode"], summary.__dict__["deleted"]) == ("delete", 1)


def failing_sessions(key: str) -> Sessions:
    def factory() -> AbstractAsyncContextManager[AsyncSession]:
        # What a driver error holds: the statement and its literals.
        statement = f"SELECT file_key FROM request_media WHERE file_key IN ('{key}')"  # noqa: S608
        raise OperationalError(statement, {"key": key}, Exception(f"connection lost at {key}"))

    return factory


FAILURES = ["list_unavailable", "list_bug", "delete_unavailable", "delete_bug", "database"]


@pytest.mark.parametrize("failure", FAILURES)
async def test_storage_failure_is_logged_without_keys_and_does_not_raise(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture, failure: str
) -> None:
    key = upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA)
    storage = ListingStorage({key: OLD})
    sessions = sessions_of(db_session)
    error_class = "StorageUnavailableError"
    if failure == "list_unavailable":
        storage.list_error = StorageUnavailableError("list failed: InternalError")
    elif failure == "list_bug":
        # An unexpected error whose text names the key.
        storage.list_error, error_class = KeyError(key), "KeyError"
    elif failure == "delete_unavailable":
        storage.delete_error = StorageUnavailableError("delete failed: SlowDown")
    elif failure == "delete_bug":
        storage.delete_error, error_class = RuntimeError(f"bad {key}"), "RuntimeError"
    else:
        sessions, error_class = failing_sessions(key), "OperationalError"

    with caplog.at_level(logging.DEBUG):
        configure_logging("DEBUG")
        result = await sweeper(sessions, storage).sweep()

    [failed] = [r for r in caplog.records if r.message == "orphan_upload_sweep_failed"]
    assert (failed.levelno, failed.__dict__["error_class"]) == (logging.WARNING, error_class)
    assert failed.exc_info is None
    assert key in storage.objects
    assert result.deleted == 0
    assert result.failed == (1 if failure == "delete_unavailable" else 0)
    assert not leaks(caplog.records, key, str(world.customer.id), key.rsplit("/", 1)[1])


async def test_a_failed_run_still_logs_what_it_deleted(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    keys = sorted(upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA) for _ in range(3))
    storage = ListingStorage(
        dict.fromkeys(keys, OLD),
        page_size=1,
        list_error=StorageUnavailableError("list failed: test"),
        fail_at_page=2,
    )

    with caplog.at_level(logging.INFO):
        result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == {keys[2]}
    assert result == counts(scanned=2, orphaned=2, deleted=2)
    messages = [r.message for r in caplog.records]
    assert messages == ["orphan_upload_sweep_failed", "orphan_uploads_swept"]
    assert (caplog.records[1].__dict__["deleted"], caplog.records[1].__dict__["completed"]) == (
        2,
        False,
    )


async def test_a_run_stopped_by_its_timeout_logs_it_and_stops(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    keys = sorted(upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA) for _ in range(3))
    storage = ListingStorage(dict.fromkeys(keys, OLD), page_size=1)
    reached = asyncio.Event()
    pages_checked: list[bool] = []

    async def stall_on_the_second_page() -> None:
        pages_checked.append(True)
        if len(pages_checked) == 2:
            reached.set()
            await asyncio.Event().wait()  # until ARQ's timeout cancels the run

    run = asyncio.create_task(
        sweeper(sessions_of(db_session, stall_on_the_second_page), storage).sweep()
    )
    with caplog.at_level(logging.INFO):
        await asyncio.wait_for(reached.wait(), timeout=5)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run

    assert set(storage.objects) == set(keys[1:])
    [failed, summary] = caplog.records
    assert (failed.message, failed.__dict__["error_class"]) == (
        "orphan_upload_sweep_failed",
        "CancelledError",
    )
    assert summary.message == "orphan_uploads_swept"
    assert (summary.__dict__["completed"], summary.__dict__["deleted"]) == (False, 1)


async def test_partial_delete_failure_is_counted(db_session: AsyncSession, world: World) -> None:
    keys = {upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA) for _ in range(5)}
    stuck = set(sorted(keys)[:2])
    storage = ListingStorage(dict.fromkeys(keys, OLD), undeletable=stuck)

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == stuck
    assert result == counts(scanned=5, orphaned=5, deleted=3, failed=2)


async def test_logs_carry_no_keys_or_user_ids(
    db_session: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    # Every outcome at once, over several pages, with one delete failing.
    storage = ListingStorage(page_size=2)
    orphans: list[str] = []
    for column in COLUMNS:
        owner = column.owner(world)
        referenced, orphan = upload_key(owner, column.purpose), upload_key(owner, column.purpose)
        await column.attach(db_session, world, referenced)
        orphans.append(orphan)
        storage.objects |= {referenced: OLD, orphan: OLD, upload_key(owner, column.purpose): YOUNG}
    storage.objects |= {
        upload_key(world.pro.id, UploadPurpose.JOB_PHOTO): OLD,
        upload_key(world.customer.id, UploadPurpose.PROFILE_PHOTO): OLD,
        f"u/{world.customer.id}/request_media/x.jpg": OLD,
    }
    storage.undeletable = {orphans[0]}
    every_key = set(storage.objects)

    with caplog.at_level(logging.DEBUG):
        configure_logging("DEBUG")
        await sweeper(sessions_of(db_session), storage).sweep()

    secrets = [
        *every_key,
        *(key.rsplit("/", 1)[1] for key in every_key),
        str(world.customer.id),
        str(world.pro.id),
    ]
    assert caplog.records
    assert not leaks(caplog.records, *secrets)
    [summary] = [r for r in caplog.records if r.message == "orphan_uploads_swept"]
    logged = {name: summary.__dict__[name] for name in SweepCounts.__dataclass_fields__}
    assert logged == {
        "scanned": 12,
        "too_young": 3,
        "referenced": 3,
        "orphaned": 3,
        "deleted": 2,
        "unparsed": 1,
        "skipped_purpose": 2,
        "failed": 1,
    }
    assert (summary.__dict__["mode"], summary.__dict__["completed"]) == ("delete", True)


def count_queries(session: AsyncSession) -> list[str]:
    statements: list[str] = []
    connection = session.bind.sync_connection  # type: ignore[union-attr]  # db_session is bound to a connection

    @event.listens_for(connection, "before_cursor_execute")
    def record(*args: object) -> None:
        statements.append(str(args[2]))

    return statements


@pytest.mark.parametrize("profile_photos", [False, True])
async def test_one_reference_query_per_page(
    db_session: AsyncSession, world: World, profile_photos: bool
) -> None:
    purpose = UploadPurpose.PROFILE_PHOTO if profile_photos else UploadPurpose.REQUEST_MEDIA
    owner = world.pro.id if profile_photos else world.customer.id
    keys = {upload_key(owner, purpose) for _ in range(6)}
    storage = ListingStorage(dict.fromkeys(keys, OLD), page_size=2)
    statements = count_queries(db_session)

    result = await sweeper(sessions_of(db_session), storage, "dry_run").sweep()

    assert result == counts(scanned=6, orphaned=6)
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    unions = [s for s in selects if s.count("UNION ALL") == len(ReferencingColumn) - 1]
    assert len(unions) == 3  # one per page, across every referencing column
    # A profile photo's owner role is read with its page, in one more query.
    assert len(selects) == 3 * (2 if profile_photos else 1)


async def test_pagination(db_session: AsyncSession, world: World) -> None:
    total = 2 * DELETE_BATCH_MAX + 500
    keys = {upload_key(world.customer.id, UploadPurpose.REQUEST_MEDIA) for _ in range(total)}
    referenced = sorted(keys)[::700]
    for key in referenced:
        await attach_media(db_session, world, key)
    # Pages larger than one DeleteObjects call takes, and more than one of them.
    storage = ListingStorage(dict.fromkeys(keys, OLD), page_size=DELETE_BATCH_MAX + 300)

    result = await sweeper(sessions_of(db_session), storage).sweep()

    assert set(storage.objects) == set(referenced)
    assert result == counts(
        scanned=total,
        referenced=len(referenced),
        orphaned=total - len(referenced),
        deleted=total - len(referenced),
    )
    assert storage.calls.count("list") == 1
    assert all(0 < len(batch) <= DELETE_BATCH_MAX for batch in storage.delete_batches)
    assert len(storage.delete_batches) == 4  # two pages of 1,300 and 1,200 keys


@pytest.mark.parametrize(
    ("overrides", "valid"),
    [
        ({}, True),
        ({"orphan_upload_mode": "delete"}, True),
        ({"orphan_upload_mode": "everything"}, False),
        ({"orphan_upload_min_age_hours": 1}, True),
        ({"orphan_upload_min_age_hours": 0}, False),
        ({"orphan_upload_sweep_minutes": 60}, True),
        ({"orphan_upload_sweep_minutes": 0}, False),
        ({"orphan_upload_sweep_minutes": 61}, False),
        ({"orphan_upload_sweep_timeout_seconds": 60}, True),
        ({"orphan_upload_sweep_timeout_seconds": 0}, False),
    ],
)
def test_sweep_settings(overrides: dict[str, object], valid: bool) -> None:
    if not valid:
        with pytest.raises(ValueError, match="orphan_upload"):
            make_settings(**overrides)
        return
    settings = make_settings(**overrides)
    defaults = {
        "orphan_upload_mode": "dry_run",
        "orphan_upload_min_age_hours": 24,
        "orphan_upload_sweep_minutes": 60,
        "orphan_upload_sweep_timeout_seconds": 1_800,
    }
    assert {name: getattr(settings, name) for name in defaults} == defaults | overrides
