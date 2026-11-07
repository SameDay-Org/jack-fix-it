"""Job photos and Job's done (D12.2, #298): the pro's before and after photos, the rules by
status, ownership and the cap, completion with an after photo, and both job views."""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import PresignedUpload
from app.modules.jobs.models import Job, JobPhoto, JobPhotoKind, JobStatus
from app.modules.jobs.repository import JobPhotoRepository
from app.modules.jobs.tasks import sanitize_job_photos
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.requests.tasks import SANITIZE_SPARE_TRIES
from app.modules.uploads.keys import make_key, time_ordered_token, upload_issued_at
from app.modules.uploads.schemas import UploadPurpose
from app.observability import configure_logging
from app.queue import get_job_queue
from tests.conftest import make_settings
from tests.job_world import JobWorld, build_world, events, job_row, make_job
from tests.test_media_copies import MAX_TRIES, MemoryStorage, ctx, gps_jpeg
from tests.test_media_logging import leaks

BASE = "/v1/pros/me/jobs"
CAP = 3
TTL = 120
ATTACH_MINUTES = 60
ENQUEUE_TIMEOUT = 0.5
INVALID_PHOTO = {
    "error": {"code": "invalid_photo", "message": "One or more photos are not valid uploads."}
}
NOT_ALLOWED = {
    "error": {
        "code": "job_photo_not_allowed",
        "message": "Photos of this kind cannot be added to the job in its current status.",
    }
}
DUPLICATE = {"error": {"code": "duplicate_photo", "message": "This photo is already attached."}}
LIMIT = {
    "error": {"code": "job_photo_limit", "message": "The job cannot hold more photos of this kind."}
}
AFTER_REQUIRED = {
    "error": {
        "code": "after_photos_required",
        "message": "Add at least one photo of the finished work before marking the job done.",
    }
}
AFTER_PROCESSING = {
    "error": {
        "code": "after_photos_processing",
        "message": "The photos of the finished work are still processing. Try again in a moment.",
    }
}
EXPIRED = {
    "error": {
        "code": "upload_expired",
        "message": "One or more photos were uploaded too long ago. Upload them again.",
    }
}
INVALID_TRANSITION = {
    "error": {
        "code": "invalid_transition",
        "message": "The job cannot move to that status from its current one.",
    }
}
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}


@dataclass
class FakeStorage:
    gets: list[tuple[str, int]] = field(default_factory=list)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - nothing uploads here
        raise AssertionError("no upload here")

    def presign_get(self, key: str, expires_in: int) -> str:
        self.gets.append((key, expires_in))
        return f"https://storage.example.invalid/get/{key}?sig=fake"


@dataclass
class RecordingQueue:
    jobs: dict[str, tuple[str, tuple[object, ...]]] = field(default_factory=dict)
    failure: Exception | None = None

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        if self.failure is not None:
            raise self.failure
        assert _job_id is not None
        if _job_id in self.jobs:
            return None
        self.jobs[_job_id] = (function, args)
        return object()


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        job_photo_max_per_kind=CAP,
        job_photo_attach_max_age_minutes=ATTACH_MINUTES,
        download_url_ttl_seconds=TTL,
        job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT,
    )


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.state.storage = fake  # what get_storage, behind the lazy provider, hands out
    return fake


@pytest.fixture
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
async def world(db_session: AsyncSession, storage: FakeStorage, queue: RecordingQueue) -> JobWorld:
    return await build_world(db_session)


def key_of(
    user_id: uuid.UUID,
    purpose: str = "job_photo",
    extension: str = ".jpg",
    issued_at: datetime | None = None,
) -> str:
    """An upload key as the API issues it (uploads/keys.py), issued now unless `issued_at`."""
    token = time_ordered_token(issued_at or datetime.now(UTC))
    return f"u/{user_id}/{purpose}/{token}{extension}"


@dataclass
class PhotoStorage(MemoryStorage):
    """Files in memory for the real copier, plus signed GETs for the views."""

    def presign_get(self, key: str, expires_in: int) -> str:
        return f"https://storage.example.invalid/get/{key}?sig=fake"


async def sanitize_to_the_end(
    session: AsyncSession, storage: MemoryStorage, job: Job, photo: JobPhoto
) -> None:
    """The real copier on its last try: the photo ends ready or failed. The worker's bulk
    update bypasses the identity map, so the photo is refreshed as a fresh request would."""
    last_try = MAX_TRIES + SANITIZE_SPARE_TRIES
    await sanitize_job_photos(ctx(session, storage, last_try), str(job.id), [str(photo.id)])
    await session.refresh(photo)


def add(
    client: httpx.AsyncClient,
    job: Job,
    headers: dict[str, str],
    kind: str,
    keys: list[str],
) -> Any:
    return client.post(
        f"{BASE}/{job.id}/photos", json={"kind": kind, "upload_keys": keys}, headers=headers
    )


async def stored(session: AsyncSession, job: Job) -> list[JobPhoto]:
    return await JobPhotoRepository(session).of_jobs([job.id])


async def photo_row(
    session: AsyncSession,
    world: JobWorld,
    job: Job,
    kind: JobPhotoKind,
    status: MediaSafeStatus = MediaSafeStatus.PENDING,
    safe_key: str | None = None,
    at: datetime | None = None,
) -> JobPhoto:
    photo = JobPhoto(
        job_id=job.id,
        kind=kind,
        file_key=key_of(world.pro.id),
        uploaded_by=world.pro.id,
        safe_status=status,
        safe_key=safe_key,
        safe_content_type="image/jpeg" if safe_key else None,
        **({"created_at": at} if at else {}),
    )
    session.add(photo)
    await session.flush()
    return photo


def safe_key() -> str:
    return f"m/{uuid.uuid4().hex}.jpg"


# Before and after photos by status


@pytest.mark.parametrize(
    ("status", "allowed"),
    [
        (JobStatus.SCHEDULED, False),
        (JobStatus.ON_THE_WAY, True),
        (JobStatus.IN_PROGRESS, True),
        (JobStatus.COMPLETED, False),
        (JobStatus.CANCELLED, False),
    ],
)
async def test_before_photos_by_status(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
    allowed: bool,
) -> None:
    job = await make_job(db_session, world, status)

    response = await add(db_client, job, world.pro.headers, "before", [key_of(world.pro.id)])

    if allowed:
        assert response.status_code == 201, response.text
        assert len(response.json()["photos"]["before"]) == 1
        assert len(await stored(db_session, job)) == 1
    else:
        assert (response.status_code, response.json()) == (409, NOT_ALLOWED)
        assert await stored(db_session, job) == []


@pytest.mark.parametrize(
    ("status", "allowed"),
    [
        (JobStatus.SCHEDULED, False),
        (JobStatus.ON_THE_WAY, False),
        (JobStatus.IN_PROGRESS, True),
        (JobStatus.COMPLETED, False),
    ],
)
async def test_after_photos_by_status(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: JobStatus,
    allowed: bool,
) -> None:
    job = await make_job(db_session, world, status)

    response = await add(db_client, job, world.pro.headers, "after", [key_of(world.pro.id)])

    if allowed:
        assert response.status_code == 201, response.text
        assert len(response.json()["photos"]["after"]) == 1
    else:
        assert (response.status_code, response.json()) == (409, NOT_ALLOWED)
        assert await stored(db_session, job) == []


# Ownership


async def test_another_pros_job_is_not_found(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)

    for caller in (world.other_pro, world.pro_without_profile):
        response = await add(db_client, job, caller.headers, "after", [key_of(caller.id)])
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
    assert await stored(db_session, job) == []


@pytest.mark.parametrize(
    "bad",
    [
        "another_users",
        "request_media",
        "pro_document",
        "profile_photo",
        "pdf",
        "malformed",
        "traversal",
    ],
)
async def test_a_key_not_the_callers_job_photo_stores_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, bad: str
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    pro = world.pro.id
    key = {
        "another_users": key_of(world.other_pro.id),
        "request_media": key_of(pro, "request_media"),
        "pro_document": key_of(pro, "pro_document"),
        "profile_photo": key_of(pro, "profile_photo"),
        "pdf": key_of(pro, extension=".pdf"),  # job photos are images only
        "malformed": f"u/{pro}/job_photo/x.jpg",
        "traversal": f"u/{pro}/job_photo/../{uuid.uuid4().hex}.jpg",
    }[bad]

    # One good key with it: nothing at all is stored.
    response = await add(db_client, job, world.pro.headers, "after", [key_of(pro), key])

    assert (response.status_code, response.json()) == (422, INVALID_PHOTO)
    assert await stored(db_session, job) == []


# Duplicates and the cap


async def test_duplicate_keys_conflict(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    other_job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    taken = key_of(world.pro.id)
    first = await add(db_client, job, world.pro.headers, "before", [taken])
    assert first.status_code == 201, first.text

    fresh = key_of(world.pro.id)
    twice = await add(db_client, job, world.pro.headers, "after", [fresh, fresh])
    again = await add(db_client, job, world.pro.headers, "after", [fresh, taken])
    elsewhere = await add(db_client, other_job, world.pro.headers, "after", [taken])

    for response in (twice, again, elsewhere):
        assert (response.status_code, response.json()) == (409, DUPLICATE)
    assert [photo.file_key for photo in await stored(db_session, job)] == [taken]
    assert await stored(db_session, other_job) == []


async def test_a_key_taken_after_the_check_is_a_conflict(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Another job's photo takes the key between the check and the insert: the unique index
    # answers, as a 409, never a 500.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    other_job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    taken = key_of(world.pro.id)
    db_session.add(
        JobPhoto(
            job_id=other_job.id, kind=JobPhotoKind.AFTER, file_key=taken, uploaded_by=world.pro.id
        )
    )
    await db_session.commit()

    async def none_held(self: JobPhotoRepository, keys: object) -> set[str]:
        return set()

    monkeypatch.setattr(JobPhotoRepository, "held_keys", none_held)

    job_id = job.id  # the rollback expires the test's rows too
    response = await add(db_client, job, world.pro.headers, "after", [taken])

    assert (response.status_code, response.json()) == (409, DUPLICATE)
    assert await JobPhotoRepository(db_session).of_jobs([job_id]) == []


async def test_the_cap_is_per_kind(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)

    def keys(count: int) -> list[str]:
        return [key_of(world.pro.id) for _ in range(count)]

    assert (await add(db_client, job, world.pro.headers, "before", keys(2))).status_code == 201
    over = await add(db_client, job, world.pro.headers, "before", keys(2))
    alone_over = await add(db_client, job, world.pro.headers, "after", keys(CAP + 1))
    last = await add(db_client, job, world.pro.headers, "before", keys(1))
    after = await add(db_client, job, world.pro.headers, "after", keys(CAP))

    for response in (over, alone_over):
        assert (response.status_code, response.json()) == (409, LIMIT)
    assert (last.status_code, after.status_code) == (201, 201)
    kinds = [photo.kind for photo in await stored(db_session, job)]
    assert (kinds.count(JobPhotoKind.BEFORE), kinds.count(JobPhotoKind.AFTER)) == (CAP, CAP)


async def test_the_cap_is_checked_before_the_keys_are_looked_up(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A body far over the cap never reaches the database with its keys (an IN list that
    # large would fail as a 500).
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)

    async def never(self: JobPhotoRepository, keys: object) -> set[str]:
        raise AssertionError("the keys were looked up")

    monkeypatch.setattr(JobPhotoRepository, "held_keys", never)
    keys = [key_of(world.pro.id) for _ in range(CAP + 1)]

    response = await add(db_client, job, world.pro.headers, "after", keys)

    assert (response.status_code, response.json()) == (409, LIMIT)


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "after", "upload_keys": []},
        {"kind": "during", "upload_keys": ["x"]},
        {"kind": "after"},
        {"kind": "after", "upload_keys": ["x" * 257]},
        {"kind": "after", "upload_keys": ["x"], "extra": 1},
    ],
)
async def test_a_bad_body_is_a_validation_error(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, body: dict[str, Any]
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)

    response = await db_client.post(f"{BASE}/{job.id}/photos", json=body, headers=world.pro.headers)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


# Order and the safe copies' queue


async def test_photos_keep_the_order_given_and_queue_their_safe_copies(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    storage: FakeStorage,
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    keys = [key_of(world.pro.id) for _ in range(CAP - 1)]

    first = await add(db_client, job, world.pro.headers, "after", keys)
    second = await add(db_client, job, world.pro.headers, "after", [key_of(world.pro.id)])

    assert (first.status_code, second.status_code) == (201, 201)
    rows = await stored(db_session, job)
    assert [photo.file_key for photo in rows[: CAP - 1]] == keys
    listed = [photo["id"] for photo in second.json()["photos"]["after"]]
    assert listed == [str(photo.id) for photo in rows]
    # One run per batch, named after its first photo and given only its photos: a running
    # copy never hides a new batch, and never fails one it was not given.
    first_ids = [str(photo.id) for photo in rows[: CAP - 1]]
    assert queue.jobs == {
        f"sanitize-job-photos:{rows[0].id}": ("sanitize_job_photos", (str(job.id), first_ids)),
        f"sanitize-job-photos:{rows[CAP - 1].id}": (
            "sanitize_job_photos",
            (str(job.id), [str(rows[CAP - 1].id)]),
        ),
    }
    # The pro sees their originals until the safe copies are made.
    assert [key for key, _ in storage.gets[-CAP:]] == [photo.file_key for photo in rows]


async def test_a_failed_enqueue_never_fails_the_call(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    queue.failure = RedisConnectionError("down")

    with caplog.at_level(logging.ERROR):
        response = await add(db_client, job, world.pro.headers, "after", [key_of(world.pro.id)])

    assert response.status_code == 201, response.text
    [photo] = await stored(db_session, job)
    assert photo.safe_status is MediaSafeStatus.PENDING
    assert [r.message for r in caplog.records] == ["job_photo_sanitize_enqueue_failed"]


# Upload age: the orphan sweep never deletes a key a job accepted (Vault B2)


@pytest.mark.parametrize(
    ("age", "accepted"),
    [
        (timedelta(minutes=ATTACH_MINUTES) - timedelta(seconds=30), True),
        (timedelta(minutes=ATTACH_MINUTES) + timedelta(seconds=30), False),
    ],
)
async def test_an_upload_issued_before_the_attach_window_is_expired(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    age: timedelta,
    accepted: bool,
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    old = key_of(world.pro.id, issued_at=datetime.now(UTC) - age)
    keys = [key_of(world.pro.id), old]

    response = await add(db_client, job, world.pro.headers, "after", keys)

    if accepted:
        assert response.status_code == 201
        assert [photo.file_key for photo in await stored(db_session, job)] == keys
    else:
        assert (response.status_code, response.json()) == (422, EXPIRED)
        assert await stored(db_session, job) == []
        assert queue.jobs == {}


def test_an_issued_key_carries_its_issue_time() -> None:
    owner = uuid.uuid4()
    started = datetime.now(UTC)
    key = make_key(owner, UploadPurpose.JOB_PHOTO, "image/jpeg")
    issued_at = upload_issued_at(key)
    at = datetime(2026, 1, 2, 3, 4, 5, 678_000, tzinfo=UTC)

    assert issued_at is not None
    assert started - timedelta(milliseconds=1) <= issued_at <= datetime.now(UTC)
    assert upload_issued_at(key_of(owner, issued_at=at)) == at
    assert upload_issued_at(f"u/{owner}/job_photo/{uuid.uuid4().hex}.jpg") is None
    assert upload_issued_at(f"x/{owner}/job_photo/{time_ordered_token(at)}.jpg") is None
    late = datetime(2999, 12, 30, tzinfo=UTC)
    assert upload_issued_at(key_of(owner, issued_at=late)) == late
    assert upload_issued_at(key_of(owner, issued_at=datetime(3000, 1, 2, tzinfo=UTC))) is None


@pytest.mark.parametrize(
    "token",
    [
        uuid.uuid4().hex,  # issued before time-ordered keys: its age is unknown
        "ffffffffffff7fffbfffffffffffffff",  # made up: the year 10889, past any datetime
    ],
    ids=["legacy", "out-of-range"],
)
async def test_a_key_with_no_issue_time_is_expired(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, token: str
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    key = f"u/{world.pro.id}/job_photo/{token}.jpg"

    response = await add(db_client, job, world.pro.headers, "after", [key])

    assert (response.status_code, response.json()) == (422, EXPIRED)
    assert await stored(db_session, job) == []


@pytest.mark.parametrize(
    ("minutes", "hours", "valid"),
    [(720, 24, True), (721, 24, False), (30, 1, True), (31, 1, False)],
)
def test_the_attach_window_is_at_most_half_the_sweep_age(
    minutes: int, hours: int, valid: bool
) -> None:
    overrides = {
        "job_photo_attach_max_age_minutes": minutes,
        "orphan_upload_min_age_hours": hours,
    }
    if valid:
        assert make_settings(**overrides).job_photo_attach_max_age_minutes == minutes
    else:
        with pytest.raises(ValueError, match="JOB_PHOTO_ATTACH_MAX_AGE_MINUTES"):
            make_settings(**overrides)


# Job's done


async def test_complete_requires_an_after_photo(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.BEFORE)
    before = len(await events(db_session, job.id))

    response = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (response.status_code, response.json()) == (409, AFTER_REQUIRED)
    row = await job_row(db_session, job.id)
    assert (row.status, row.completed_at) == (JobStatus.IN_PROGRESS, None)
    assert len(await events(db_session, job.id)) == before


async def test_an_after_photo_whose_copy_failed_does_not_count(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # Never shown to the customer (e.g. a key with no file behind it): not proof of the work.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.FAILED)
    await photo_row(db_session, world, job, JobPhotoKind.BEFORE, MediaSafeStatus.READY, safe_key())

    response = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (response.status_code, response.json()) == (409, AFTER_REQUIRED)
    assert (await job_row(db_session, job.id)).status is JobStatus.IN_PROGRESS


async def test_complete_sets_completed_at_once(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.READY, safe_key())
    started = datetime.now(UTC)

    first = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    row = await job_row(db_session, job.id)
    completed_at = row.completed_at
    again = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (first.status_code, again.status_code) == (200, 200)
    assert first.json()["status"] == again.json()["status"] == "completed"
    assert completed_at is not None
    assert completed_at >= started - timedelta(seconds=5)
    assert first.json()["completed_at"] == again.json()["completed_at"]
    assert (await job_row(db_session, job.id)).completed_at == completed_at
    to_completed = [
        e for e in await events(db_session, job.id) if e.to_status is JobStatus.COMPLETED
    ]
    assert len(to_completed) == 1
    assert (to_completed[0].from_status, to_completed[0].actor_id) == (
        JobStatus.IN_PROGRESS,
        world.pro.id,
    )


P, R, F = MediaSafeStatus.PENDING, MediaSafeStatus.READY, MediaSafeStatus.FAILED


@pytest.mark.parametrize(
    ("after", "expected"),
    [
        ([P], AFTER_PROCESSING),
        ([P, F], AFTER_PROCESSING),
        ([F, F], AFTER_REQUIRED),
    ],
)
async def test_complete_needs_an_after_photo_whose_copy_is_ready(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    after: list[MediaSafeStatus],
    expected: dict[str, object],
) -> None:
    # Vault B1: a pending copy is no proof yet (a key with no file, or bytes that are not an
    # image, pass the attach and only fail in the copier). A ready before photo is no proof.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    for status in after:
        await photo_row(db_session, world, job, JobPhotoKind.AFTER, status)
    await photo_row(db_session, world, job, JobPhotoKind.BEFORE, R, safe_key())
    before = len(await events(db_session, job.id))

    response = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (response.status_code, response.json()) == (409, expected)
    row = await job_row(db_session, job.id)
    assert (row.status, row.completed_at) == (JobStatus.IN_PROGRESS, None)
    assert len(await events(db_session, job.id)) == before


async def test_one_ready_after_photo_completes_among_pending_and_failed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, P)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, F)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, R, safe_key())

    response = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (response.status_code, response.json()["status"]) == (200, "completed")


@pytest.mark.parametrize(
    "contents", [None, b"this is not a JPEG"], ids=["never-uploaded", "invalid-image"]
)
async def test_no_completion_without_a_valid_after_photo(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    app: FastAPI,
    contents: bytes | None,
) -> None:
    # The Vault's B1 probe through the real copier: while the copy is made the job waits;
    # once it failed the pro must add another photo. The job never completes meanwhile.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    files = PhotoStorage()
    app.state.storage = files
    key = key_of(world.pro.id)
    if contents is not None:
        files.objects[key] = contents
    attached = await add(db_client, job, world.pro.headers, "after", [key])
    [photo] = await stored(db_session, job)

    waiting = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    await sanitize_to_the_end(db_session, files, job, photo)
    refused = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    view = await db_client.get(f"/v1/requests/{job.request_id}/job", headers=world.customer.headers)

    assert attached.status_code == 201
    assert photo.safe_status is MediaSafeStatus.FAILED
    assert (waiting.status_code, waiting.json()) == (409, AFTER_PROCESSING)
    assert (refused.status_code, refused.json()) == (409, AFTER_REQUIRED)
    row = await job_row(db_session, job.id)
    assert (row.status, row.completed_at) == (JobStatus.IN_PROGRESS, None)
    assert view.json()["photos"] == {"before": [], "after": [], "pending": 0}


async def test_complete_queues_pending_copies_again(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    queue: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A lost enqueue (Redis down) must not leave the job waiting for ever: each try of Job's
    # done queues the pending after photos' copies again, under the batch's run name.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    queue.failure = RedisConnectionError("down")
    keys = [key_of(world.pro.id) for _ in range(2)]
    assert (await add(db_client, job, world.pro.headers, "after", keys)).status_code == 201
    await photo_row(db_session, world, job, JobPhotoKind.BEFORE)  # pending, not an after photo
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, F)
    first, second = [p for p in await stored(db_session, job) if p.file_key in keys]

    with caplog.at_level(logging.ERROR):
        still_down = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    queue.failure = None
    again = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    once_more = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    for response in (still_down, again, once_more):
        assert (response.status_code, response.json()) == (409, AFTER_PROCESSING)
    assert [r.message for r in caplog.records].count("job_photo_sanitize_enqueue_failed") == 2
    assert queue.jobs == {
        f"sanitize-job-photos:{first.id}": (
            "sanitize_job_photos",
            (str(job.id), [str(first.id), str(second.id)]),
        )
    }
    row = await job_row(db_session, job.id)
    assert (row.status, row.completed_at) == (JobStatus.IN_PROGRESS, None)


async def test_a_valid_after_photo_completes_once_its_copy_is_ready(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, app: FastAPI
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    files = PhotoStorage()
    app.state.storage = files
    key = key_of(world.pro.id)
    files.objects[key] = gps_jpeg()
    assert (await add(db_client, job, world.pro.headers, "after", [key])).status_code == 201
    [photo] = await stored(db_session, job)

    waiting = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    await sanitize_to_the_end(db_session, files, job, photo)
    done = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    view = await db_client.get(f"/v1/requests/{job.request_id}/job", headers=world.customer.headers)

    assert (waiting.status_code, waiting.json()) == (409, AFTER_PROCESSING)
    assert (done.status_code, done.json()["status"]) == (200, "completed")
    [shown] = view.json()["photos"]["after"]
    assert "/m/" in shown["url"]
    assert key not in shown["url"]


async def test_failed_after_photos_free_their_slots_for_a_replacement(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, app: FastAPI
) -> None:
    # Gatekeeper B1: every slot held by a failed copy left no way to complete.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    for _ in range(CAP):
        await photo_row(db_session, world, job, JobPhotoKind.AFTER, F)
    refused = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
    files = PhotoStorage()
    app.state.storage = files
    key = key_of(world.pro.id)
    files.objects[key] = gps_jpeg()

    replaced = await add(db_client, job, world.pro.headers, "after", [key])
    [replacement] = [photo for photo in await stored(db_session, job) if photo.file_key == key]
    await sanitize_to_the_end(db_session, files, job, replacement)
    done = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (refused.status_code, refused.json()) == (409, AFTER_REQUIRED)
    assert replaced.status_code == 201
    assert replacement.safe_status is MediaSafeStatus.READY
    assert (done.status_code, done.json()["status"]) == (200, "completed")


async def test_failed_photos_count_against_twice_the_cap(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    # Replacements are bounded: every row of the kind, failed or not, counts against 2 x CAP.
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    for _ in range(2 * CAP - 1):
        await photo_row(db_session, world, job, JobPhotoKind.AFTER, F)

    last = await add(db_client, job, world.pro.headers, "after", [key_of(world.pro.id)])
    over = await add(db_client, job, world.pro.headers, "after", [key_of(world.pro.id)])
    before = await add(db_client, job, world.pro.headers, "before", [key_of(world.pro.id)])

    assert last.status_code == 201
    assert (over.status_code, over.json()) == (409, LIMIT)
    assert before.status_code == 201  # per kind
    kinds = [photo.kind for photo in await stored(db_session, job)]
    assert kinds.count(JobPhotoKind.AFTER) == 2 * CAP


async def test_pending_and_ready_photos_fill_the_cap(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, R, safe_key())
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, F)
    for _ in range(CAP - 1):
        await photo_row(db_session, world, job, JobPhotoKind.AFTER, P)

    response = await add(db_client, job, world.pro.headers, "after", [key_of(world.pro.id)])

    assert (response.status_code, response.json()) == (409, LIMIT)


@pytest.mark.parametrize("status", [JobStatus.SCHEDULED, JobStatus.ON_THE_WAY, JobStatus.CONFIRMED])
async def test_complete_from_another_status_is_an_invalid_transition(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, status: JobStatus
) -> None:
    job = await make_job(db_session, world, status)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER)

    response = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)

    assert (response.status_code, response.json()) == (409, INVALID_TRANSITION)
    assert (await job_row(db_session, job.id)).status is status


async def test_another_pro_cannot_complete(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER)

    for caller in (world.other_pro, world.pro_without_profile):
        response = await db_client.post(f"{BASE}/{job.id}/complete", headers=caller.headers)
        assert (response.status_code, response.json()) == (404, NOT_FOUND)
    assert (await job_row(db_session, job.id)).status is JobStatus.IN_PROGRESS


# Both views


async def test_photos_on_both_views_with_signed_urls(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, storage: FakeStorage
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    t0 = datetime.now(UTC) - timedelta(minutes=10)
    ready_after = await photo_row(
        db_session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.READY, safe_key(), t0
    )
    ready_before = await photo_row(
        db_session,
        world,
        job,
        JobPhotoKind.BEFORE,
        MediaSafeStatus.READY,
        safe_key(),
        t0 + timedelta(minutes=1),
    )
    pending = await photo_row(
        db_session, world, job, JobPhotoKind.AFTER, at=t0 + timedelta(minutes=2)
    )
    failed = await photo_row(
        db_session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.FAILED, at=t0 - timedelta(1)
    )
    sent = datetime.now(UTC)

    pro_view = await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers)
    pro_list = await db_client.get(BASE, headers=world.pro.headers)
    customer = await db_client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
    )

    def urls(photos: list[dict[str, Any]]) -> list[str]:
        return [photo["url"] for photo in photos]

    def signed(key: str) -> str:
        return f"https://storage.example.invalid/get/{key}?sig=fake"

    pro_photos = pro_view.json()["photos"]
    # The pro: every photo, oldest first; the safe copy once ready, else the original.
    assert urls(pro_photos["before"]) == [signed(str(ready_before.safe_key))]
    assert urls(pro_photos["after"]) == [
        signed(failed.file_key),
        signed(str(ready_after.safe_key)),
        signed(pending.file_key),
    ]
    listed = next(item for item in pro_list.json()["items"] if item["id"] == str(job.id))
    assert urls(listed["photos"]["before"]) == urls(pro_photos["before"])
    assert urls(listed["photos"]["after"]) == urls(pro_photos["after"])
    # The customer: ready safe copies only, oldest first; pending counted; failed never.
    photos = customer.json()["photos"]
    assert urls(photos["before"]) == [signed(str(ready_before.safe_key))]
    assert urls(photos["after"]) == [signed(str(ready_after.safe_key))]
    assert photos["pending"] == 1
    assert "/job_photo/" not in customer.text
    every = [*photos["before"], *photos["after"], *pro_photos["before"], *pro_photos["after"]]
    for photo in every:
        assert photo["content_type"] == "image/jpeg"
        expires_at = datetime.fromisoformat(photo["expires_at"])
        assert sent + timedelta(seconds=TTL - 5) <= expires_at
        assert expires_at <= datetime.now(UTC) + timedelta(seconds=TTL)
    assert {ttl for _, ttl in storage.gets} == {TTL}


async def test_a_customer_is_never_signed_a_key_outside_the_safe_copies(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    # A row marked ready that holds the original's key: never served to the customer.
    photo = await photo_row(db_session, world, job, JobPhotoKind.AFTER)
    photo.safe_status, photo.safe_key = MediaSafeStatus.READY, photo.file_key
    photo.safe_content_type = "image/jpeg"
    await db_session.flush()

    with caplog.at_level(logging.ERROR):
        response = await db_client.get(
            f"/v1/requests/{job.request_id}/job", headers=world.customer.headers
        )

    assert response.json()["photos"] == {"before": [], "after": [], "pending": 0}
    assert storage.gets == []
    [record] = [r for r in caplog.records if r.message == "job_photo_key_refused"]
    assert record.__dict__["photo_id"] == str(photo.id)


async def test_no_photo_no_storage(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, app: FastAPI
) -> None:
    # A job without photos never reaches the storage: a missing configuration fails only the
    # views that have something to sign.
    del app.state.storage
    job = await make_job(db_session, world, JobStatus.SCHEDULED)

    response = await db_client.get(f"{BASE}/{job.id}", headers=world.pro.headers)

    assert response.status_code == 200
    assert response.json()["photos"] == {"before": [], "after": []}


async def test_a_cannot_see_bs_job_photos(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, storage: FakeStorage
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    await photo_row(db_session, world, job, JobPhotoKind.AFTER, MediaSafeStatus.READY, safe_key())

    other_customer = await db_client.get(
        f"/v1/requests/{job.request_id}/job", headers=world.other_customer.headers
    )
    other_pro = await db_client.get(f"{BASE}/{job.id}", headers=world.other_pro.headers)
    other_list = await db_client.get(BASE, headers=world.other_pro.headers)

    assert (other_customer.status_code, other_pro.status_code) == (404, 404)
    assert other_list.json()["items"] == []
    assert storage.gets == []


# Permissions and logs


@pytest.mark.parametrize("step", ["photos", "complete"])
async def test_route_permissions(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, step: str
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    body = {"kind": "after", "upload_keys": [key_of(world.pro.id)]}

    def post(headers: dict[str, str]) -> Any:
        return db_client.post(f"{BASE}/{job.id}/{step}", json=body, headers=headers)

    anonymous = await post({})
    assert anonymous.status_code == 401
    for caller in (world.customer, world.agent, world.admin):
        response = await post(caller.headers)
        assert (response.status_code, response.json()) == (403, FORBIDDEN)
    assert await stored(db_session, job) == []
    assert (await job_row(db_session, job.id)).status is JobStatus.IN_PROGRESS


async def test_logs_carry_ids_never_keys(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    keys = [key_of(world.pro.id) for _ in range(2)]

    with caplog.at_level(logging.DEBUG):
        configure_logging("DEBUG")
        assert (await add(db_client, job, world.pro.headers, "after", keys)).status_code == 201
        bad = await add(db_client, job, world.pro.headers, "after", [key_of(world.other_pro.id)])
        assert bad.status_code == 422
        await photo_row(db_session, world, job, JobPhotoKind.AFTER, R, safe_key())
        done = await db_client.post(f"{BASE}/{job.id}/complete", headers=world.pro.headers)
        assert done.status_code == 200

    messages = [record.message for record in caplog.records]
    assert "job_photos_added" in messages
    assert "job_completed" in messages
    secrets = [*keys, *(key.rsplit("/", 1)[1] for key in keys), "/job_photo/"]
    assert not leaks(caplog.records, *secrets)
    [added] = [r for r in caplog.records if r.message == "job_photos_added"]
    assert (added.__dict__["job_id"], added.__dict__["count"]) == (str(job.id), 2)


async def test_the_repository_lists_oldest_first_across_jobs(
    db_session: AsyncSession, world: JobWorld
) -> None:
    jobs = [await make_job(db_session, world, JobStatus.IN_PROGRESS) for _ in range(2)]
    t0 = datetime.now(UTC)
    late = await photo_row(db_session, world, jobs[0], JobPhotoKind.AFTER, at=t0)
    early = await photo_row(
        db_session, world, jobs[1], JobPhotoKind.AFTER, at=t0 - timedelta(minutes=1)
    )

    rows = await JobPhotoRepository(db_session).of_jobs([job.id for job in jobs])

    assert [row.id for row in rows] == [early.id, late.id]
    assert await JobPhotoRepository(db_session).of_jobs([]) == []
    ids = (await db_session.scalars(select(JobPhoto.id).where(JobPhoto.job_id == jobs[0].id))).all()
    assert list(ids) == [late.id]
