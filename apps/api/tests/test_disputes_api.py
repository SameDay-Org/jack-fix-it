"""Report a problem (#75): POST|GET /v1/jobs/{job_id}/dispute (the customer) and
GET /v1/pros/me/jobs/{job_id}/dispute, POST .../reply (the pro)."""

import logging
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_app_settings
from app.integrations.storage import PresignedUpload
from app.modules.disputes.models import (
    Dispute,
    DisputePhoto,
    DisputeReason,
    DisputeResolution,
    DisputeStatus,
)
from app.modules.disputes.photos import DisputePhotoRows
from app.modules.disputes.repository import DisputeRepository
from app.modules.disputes.router import get_dispute_clock
from app.modules.disputes.service import DisputeConfig
from app.modules.jobs.confirmation import JobAutoConfirmer
from app.modules.jobs.models import JobStatus
from app.modules.jobs.service import JobDisputes
from app.modules.media.safe_status import MediaSafeStatus
from app.modules.uploads.keys import time_ordered_token
from app.queue import get_job_queue
from app.redaction import MASK
from tests.conftest import make_settings
from tests.job_world import LEAKS, JobWorld, Party, build_world, events, job_row, make_job

CAP: Final = 3
ATTACH_MINUTES: Final = 60
TTL: Final = 120
WINDOW: Final = timedelta(hours=48)  # JOB_AUTO_CONFIRM_AFTER_HOURS's default
# Distinctive on purpose: none of them can show up inside a UUID, a timestamp or a count.
PHONE: Final = "(786) 555-0177"
EMAIL: Final = "dispute.zq81@example.com"
SENTINEL: Final = "zqxj-dispute-sentinel"
DESCRIPTION: Final = f"The sink still leaks {SENTINEL}. Call me at {PHONE} or {EMAIL}"
REPLY: Final = f"I fixed the trap, {SENTINEL}; text me at {PHONE}"
TEXT_LEAKS = (SENTINEL, PHONE, EMAIL, *LEAKS)
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
NOT_DISPUTABLE = {
    "error": {
        "code": "job_not_disputable",
        "message": "A problem can no longer be reported on this job.",
    }
}
ALREADY_REPLIED = {
    "error": {
        "code": "already_replied",
        "message": "You already replied to this problem report.",
    }
}
NO_OPEN_DISPUTE = {
    "error": {"code": "no_open_dispute", "message": "This job has no open problem report."}
}
KEY_REUSED = {
    "error": {
        "code": "idempotency_key_reused",
        "message": "This Idempotency-Key was already used with a different report.",
    }
}


@dataclass
class FakeStorage:
    gets: list[str] = field(default_factory=list)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - nothing uploads here
        raise AssertionError("no upload here")

    def presign_get(self, key: str, expires_in: int) -> str:
        self.gets.append(key)
        return f"https://storage.example.invalid/get/{key}?sig=fake"


@dataclass
class RecordingQueue:
    jobs: dict[str, tuple[str, tuple[object, ...]]] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        assert _job_id is not None
        self.order.append(f"enqueue:{function}")
        self.jobs.setdefault(_job_id, (function, args))
        return object()

    def pushes(self) -> list[tuple[object, ...]]:
        return [args for function, args in self.jobs.values() if function == "send_push"]


@dataclass
class Clock:
    now: datetime

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        dispute_photo_max_count=CAP,
        job_photo_attach_max_age_minutes=ATTACH_MINUTES,
        download_url_ttl_seconds=TTL,
    )


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.state.storage = fake
    return fake


@pytest.fixture
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
def clock(app: FastAPI) -> Clock:
    fixed = Clock(datetime.now(UTC))
    app.dependency_overrides[get_dispute_clock] = lambda: fixed
    return fixed


@pytest.fixture
async def world(
    db_session: AsyncSession, storage: FakeStorage, queue: RecordingQueue, clock: Clock
) -> JobWorld:
    return await build_world(db_session)


def path(job_id: object) -> str:
    return f"/v1/jobs/{job_id}/dispute"


def pro_path(job_id: object) -> str:
    return f"/v1/pros/me/jobs/{job_id}/dispute"


def photo_key(party: Party, at: datetime, purpose: str = "dispute_photo") -> str:
    return f"u/{party.id}/{purpose}/{time_ordered_token(at)}.jpg"


async def completed_job(
    session: AsyncSession, world: JobWorld, clock: Clock, ago: timedelta = timedelta(hours=1)
) -> uuid.UUID:
    job = await make_job(session, world, JobStatus.COMPLETED, completed_at=clock.now - ago)
    return job.id


async def report(
    client: httpx.AsyncClient,
    party: Party,
    job_id: object,
    /,
    key: object = None,
    **body: Any,
) -> httpx.Response:
    body.setdefault("reason_code", "poor_quality")
    body.setdefault("description", DESCRIPTION)
    headers = dict(party.headers)
    if key is not None:
        headers["Idempotency-Key"] = str(key)
    return await client.post(path(job_id), json=body, headers=headers)


async def disputes(session: AsyncSession) -> list[Dispute]:
    statement = select(Dispute).execution_options(populate_existing=True)
    return list((await session.scalars(statement)).all())


async def photos(session: AsyncSession) -> list[DisputePhoto]:
    statement = (
        select(DisputePhoto)
        .order_by(DisputePhoto.created_at)
        .execution_options(populate_existing=True)
    )
    return list((await session.scalars(statement)).all())


def unsigned(response: httpx.Response) -> dict[str, Any]:
    """The customer's view without its photo links' expiry, which follows the clock."""
    body: dict[str, Any] = response.json()
    for photo in body["dispute"]["photos"]:
        photo.pop("expires_at")
    return body


def assert_no_leak(text: str) -> None:
    for leak in TEXT_LEAKS:
        assert leak not in text


# --- Reporting -------------------------------------------------------------------------------


async def test_the_customer_reports_a_problem_and_the_job_is_held(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    caplog.set_level(logging.INFO)
    job_id = await completed_job(db_session, world, clock)
    keys = [photo_key(world.customer, clock.now) for _ in range(2)]
    commit = db_session.commit

    async def recorded_commit() -> None:
        queue.order.append("commit")
        await commit()

    monkeypatch.setattr(db_session, "commit", recorded_commit)

    response = await report(db_client, world.customer, job_id, photo_keys=keys)

    assert response.status_code == 201, response.text
    body = response.json()
    dispute = body["dispute"]
    assert (dispute["reason_code"], dispute["status"], dispute["resolution"]) == (
        "poor_quality",
        "open",
        None,
    )
    # Contact details masked; only the masked text exists anywhere.
    assert MASK in dispute["description"]
    assert SENTINEL in dispute["description"]
    assert PHONE not in dispute["description"]
    assert EMAIL not in dispute["description"]
    [row] = await disputes(db_session)
    assert row.description == dispute["description"]
    # The customer sees their own photos at once: the originals, until the safe copies are ready.
    assert [photo["url"].split("/get/")[1].split("?")[0] for photo in dispute["photos"]] == keys
    assert dispute["photos_pending"] == 2
    # Reported: nothing more to report, and no deadline left to show.
    assert (body["can_report"], body["report_by"]) == (False, None)
    # One transaction: the dispute, its photos, the job's move and its event.
    assert [p.file_key for p in await photos(db_session)] == keys
    assert (await job_row(db_session, job_id)).status is JobStatus.DISPUTED
    # One transaction shares now(): pick the move by its status, not by its time.
    [last] = [e for e in await events(db_session, job_id) if e.to_status is JobStatus.DISPUTED]
    assert (last.from_status, last.to_status, last.actor_id) == (
        JobStatus.COMPLETED,
        JobStatus.DISPUTED,
        world.customer.id,
    )
    # After the commit: the pro's push, then the photos' safe copies.
    assert queue.order == ["commit", "enqueue:send_push", "enqueue:sanitize_dispute_photos"]
    [push] = queue.pushes()
    assert push[0] == str(world.pro.id)
    assert push[1] == f"job_disputed:{job_id}"
    assert push[5] == f"/jobs/{job_id}"
    # Logs carry ids only: never the text, never a contact.
    assert_no_leak(caplog.text)
    assert_no_leak(response.text.replace(dispute["description"], ""))


async def test_a_second_report_returns_the_first_unchanged(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
) -> None:
    job_id = await completed_job(db_session, world, clock)
    first = await report(db_client, world.customer, job_id)
    again = await report(
        db_client, world.customer, job_id, reason_code="damage", description="Something else"
    )

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json() == first.json()
    assert len(await disputes(db_session)) == 1
    moves = [e for e in await events(db_session, job_id) if e.to_status is JobStatus.DISPUTED]
    assert len(moves) == 1
    assert len(queue.pushes()) == 1


@pytest.mark.parametrize("with_key", [True, False], ids=["key", "no_key"])
async def test_a_retry_returns_the_report_after_its_photo_keys_aged(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    with_key: bool,
) -> None:
    # The first answer was lost; the app retries the same body once the keys are too old to
    # attach anew, while the job is still inside its window.
    job_id = await completed_job(db_session, world, clock)
    key = uuid.uuid4() if with_key else None
    keys = [photo_key(world.customer, clock.now)]
    first = await report(db_client, world.customer, job_id, key, photo_keys=keys)
    clock.now += timedelta(minutes=ATTACH_MINUTES, seconds=1)

    again = await report(db_client, world.customer, job_id, key, photo_keys=keys)

    assert (first.status_code, again.status_code) == (201, 200), again.text
    # The same report; only its photo links are signed again, from the later clock.
    assert unsigned(again) == unsigned(first)
    [row] = await disputes(db_session)
    assert row.idempotency_key == key
    assert (row.idempotency_fingerprint is not None) is with_key
    assert len(await photos(db_session)) == 1
    assert len(queue.pushes()) == 1


async def test_a_key_used_with_another_body_or_job_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
) -> None:
    first_job, second_job = [await completed_job(db_session, world, clock) for _ in range(2)]
    key = uuid.uuid4()
    first = await report(db_client, world.customer, first_job, key)
    assert first.status_code == 201, first.text

    other_body = await report(db_client, world.customer, first_job, key, reason_code="damage")
    other_job = await report(db_client, world.customer, second_job, key)

    assert (other_body.status_code, other_body.json()) == (409, KEY_REUSED)
    assert (other_job.status_code, other_job.json()) == (409, KEY_REUSED)
    [row] = await disputes(db_session)
    assert row.reason_code is DisputeReason.POOR_QUALITY
    assert (await job_row(db_session, second_job)).status is JobStatus.COMPLETED
    assert len(queue.pushes()) == 1
    # Keys are per customer: the same key from another customer is a new key.
    their_world = replace(world, customer=world.other_customer)
    theirs = await completed_job(db_session, their_world, clock)
    assert (await report(db_client, world.other_customer, theirs, key)).status_code == 201


async def test_a_key_taken_meanwhile_by_a_report_on_another_job_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_job, second_job = [await completed_job(db_session, world, clock) for _ in range(2)]
    key = uuid.uuid4()
    assert (await report(db_client, world.customer, first_job, key)).status_code == 201

    async def not_yet(self: DisputeRepository, opened_by: uuid.UUID, key: uuid.UUID) -> None:
        return None  # the other report commits after this look: the unique index decides

    monkeypatch.setattr(DisputeRepository, "by_idempotency_key", not_yet)
    response = await report(db_client, world.customer, second_job, key)

    assert (response.status_code, response.json()) == (409, KEY_REUSED)
    assert len(await disputes(db_session)) == 1
    assert (await job_row(db_session, second_job)).status is JobStatus.COMPLETED


async def test_an_idempotency_key_that_is_not_a_uuid_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)

    response = await report(db_client, world.customer, job_id, "not-a-uuid")

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await disputes(db_session) == []


@pytest.mark.parametrize(
    ("ago", "window_hours", "allowed"),
    [
        (WINDOW - timedelta(seconds=1), None, True),
        (WINDOW, None, False),  # due at its very end, as the auto-confirm
        (WINDOW + timedelta(hours=1), None, False),
        (timedelta(hours=23), 24, True),
        (timedelta(hours=24), 24, False),
    ],
    ids=["inside", "at_the_end", "past", "own_window_inside", "own_window_past"],
)
async def test_a_problem_is_reported_only_inside_the_window(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    app: FastAPI,
    ago: timedelta,
    window_hours: int | None,
    allowed: bool,
) -> None:
    if window_hours is not None:
        own = make_settings(dispute_window_hours=window_hours)
        app.dependency_overrides[get_app_settings] = lambda: own
    job_id = await completed_job(db_session, world, clock, ago)

    response = await report(db_client, world.customer, job_id)

    if allowed:
        assert response.status_code == 201, response.text
        return
    assert (response.status_code, response.json()) == (409, NOT_DISPUTABLE)
    assert await disputes(db_session) == []
    assert (await job_row(db_session, job_id)).status is JobStatus.COMPLETED


@pytest.mark.parametrize(
    "status",
    [
        JobStatus.SCHEDULED,
        JobStatus.ON_THE_WAY,
        JobStatus.IN_PROGRESS,
        JobStatus.CONFIRMED,
        JobStatus.PAID_OUT,
        JobStatus.CANCELLED,
        JobStatus.REFUNDED,
    ],
)
async def test_only_a_completed_job_is_reported(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    status: JobStatus,
) -> None:
    job = await make_job(db_session, world, status, completed_at=clock.now - timedelta(hours=1))

    response = await report(db_client, world.customer, job.id)

    assert (response.status_code, response.json()) == (409, NOT_DISPUTABLE)
    assert await disputes(db_session) == []


async def test_an_auto_confirmed_job_goes_to_support_not_to_a_dispute(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    # Still inside the window by the report's clock: only the job's status refuses it.
    job_id = await completed_job(db_session, world, clock)
    confirmed = await JobAutoConfirmer(db_session).confirm_if_due(job_id, clock.now + WINDOW)
    assert confirmed is not None
    assert (await job_row(db_session, job_id)).status is JobStatus.CONFIRMED

    response = await report(db_client, world.customer, job_id)

    assert (response.status_code, response.json()) == (409, NOT_DISPUTABLE)


async def test_the_auto_confirm_never_confirms_a_disputed_job(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)
    assert (await report(db_client, world.customer, job_id)).status_code == 201

    confirmer = JobAutoConfirmer(db_session)
    later = clock.now + 2 * WINDOW
    assert job_id not in await confirmer.due(later, None, 1_000)
    assert await confirmer.confirm_if_due(job_id, later) is None
    assert (await job_row(db_session, job_id)).status is JobStatus.DISPUTED


async def test_a_failure_before_the_commit_leaves_the_job_completed(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    queue: RecordingQueue,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = await completed_job(db_session, world, clock)
    await db_session.commit()  # the world outlives the request's rollback

    async def broken(self: JobDisputes, job_id: uuid.UUID, customer: object) -> None:
        raise RuntimeError("probe failure")

    monkeypatch.setattr(JobDisputes, "disputed", broken)
    keys = [photo_key(world.customer, clock.now)]

    response = await report(db_client, world.customer, job_id, photo_keys=keys)
    await db_session.rollback()  # what get_session does with a failed request

    assert response.status_code == 500
    assert await disputes(db_session) == []
    assert await photos(db_session) == []
    assert (await job_row(db_session, job_id)).status is JobStatus.COMPLETED
    assert queue.jobs == {}


# --- Who may ---------------------------------------------------------------------------------


async def test_only_the_jobs_customer_reports_or_reads(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)

    for party, expected in (
        (world.other_customer, (404, NOT_FOUND)),
        (world.pro, (403, FORBIDDEN)),
        (world.agent, (403, FORBIDDEN)),
        (world.admin, (403, FORBIDDEN)),
    ):
        posted = await report(db_client, party, job_id)
        read = await db_client.get(path(job_id), headers=party.headers)
        assert (posted.status_code, posted.json()) == expected
        assert (read.status_code, read.json()) == expected
    unknown = await report(db_client, world.customer, uuid.uuid4())
    assert (unknown.status_code, unknown.json()) == (404, NOT_FOUND)
    assert await disputes(db_session) == []


async def test_only_the_jobs_pro_reads_or_replies(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)
    assert (await report(db_client, world.customer, job_id)).status_code == 201

    for party, expected in (
        (world.other_pro, (404, NOT_FOUND)),
        (world.customer, (403, FORBIDDEN)),
        (world.agent, (403, FORBIDDEN)),
    ):
        read = await db_client.get(pro_path(job_id), headers=party.headers)
        replied = await db_client.post(
            f"{pro_path(job_id)}/reply", json={"message": "x"}, headers=party.headers
        )
        assert (read.status_code, read.json()) == expected
        assert (replied.status_code, replied.json()) == expected


# --- Photos ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case",
    ["someone_elses", "another_purpose", "too_old", "repeated", "too_many", "made_up"],
)
async def test_photo_keys_must_be_the_customers_own_recent_dispute_photos(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    case: str,
) -> None:
    job_id = await completed_job(db_session, world, clock)
    fresh = photo_key(world.customer, clock.now)
    keys = {
        "someone_elses": [photo_key(world.other_customer, clock.now)],
        "another_purpose": [photo_key(world.customer, clock.now, "request_media")],
        "too_old": [
            photo_key(world.customer, clock.now - timedelta(minutes=ATTACH_MINUTES, seconds=1))
        ],
        "repeated": [fresh, fresh],
        "too_many": [photo_key(world.customer, clock.now) for _ in range(CAP + 1)],
        "made_up": [f"u/{world.customer.id}/dispute_photo/{uuid.uuid4().hex}.jpg"],
    }[case]

    response = await report(db_client, world.customer, job_id, photo_keys=keys)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await disputes(db_session) == []
    assert (await job_row(db_session, job_id)).status is JobStatus.COMPLETED


async def test_a_photo_attached_to_one_report_is_refused_on_another(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    first, second = [await completed_job(db_session, world, clock) for _ in range(2)]
    key = photo_key(world.customer, clock.now)
    assert (await report(db_client, world.customer, first, photo_keys=[key])).status_code == 201

    response = await report(db_client, world.customer, second, photo_keys=[key])

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert (await job_row(db_session, second)).status is JobStatus.COMPLETED


async def test_the_pro_sees_safe_copies_only_and_never_the_customers_contacts(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    storage: FakeStorage,
) -> None:
    job_id = await completed_job(db_session, world, clock)
    keys = [photo_key(world.customer, clock.now) for _ in range(3)]
    assert (await report(db_client, world.customer, job_id, photo_keys=keys)).status_code == 201
    ready, pending, failed = await photos(db_session)
    rows = DisputePhotoRows([ready.id, failed.id])
    safe = f"m/{uuid.uuid4().hex}.jpg"
    assert await rows.mark_ready(db_session, ready.id, safe, "image/jpeg")
    assert await rows.fail_pending(db_session, [failed.id]) == [failed.id]
    await db_session.commit()
    storage.gets.clear()

    response = await db_client.get(pro_path(job_id), headers=world.pro.headers)

    assert response.status_code == 200, response.text
    dispute = response.json()["dispute"]
    assert [photo["id"] for photo in dispute["photos"]] == [str(ready.id)]
    assert storage.gets == [safe]  # never an original
    assert dispute["photos_pending"] == 1
    assert (dispute["reply"], response.json()["can_reply"]) == (None, True)
    assert_no_leak(response.text.replace(dispute["description"], ""))
    for name in ("opened_by", "customer_id", "email", "phone"):
        assert name not in response.text
    # The customer: the safe copy once ready, their originals otherwise (failed included).
    storage.gets.clear()
    mine = (await db_client.get(path(job_id), headers=world.customer.headers)).json()
    assert [photo["id"] for photo in mine["dispute"]["photos"]] == [
        str(ready.id),
        str(pending.id),
        str(failed.id),
    ]
    assert storage.gets == [safe, keys[1], keys[2]]


# --- The pro's reply -------------------------------------------------------------------------


async def test_the_pro_replies_once_and_the_customer_does_not_see_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    job_id = await completed_job(db_session, world, clock)
    reply_path = f"{pro_path(job_id)}/reply"
    none_yet = await db_client.post(reply_path, json={"message": REPLY}, headers=world.pro.headers)
    assert (none_yet.status_code, none_yet.json()) == (409, NO_OPEN_DISPUTE)
    assert (await report(db_client, world.customer, job_id)).status_code == 201

    first = await db_client.post(reply_path, json={"message": REPLY}, headers=world.pro.headers)
    again = await db_client.post(reply_path, json={"message": REPLY}, headers=world.pro.headers)
    other = await db_client.post(
        reply_path, json={"message": "Another answer"}, headers=world.pro.headers
    )

    assert first.status_code == 200, first.text
    reply = first.json()["dispute"]["reply"]
    assert MASK in reply
    assert PHONE not in reply
    assert first.json()["can_reply"] is False
    assert (again.status_code, again.json()) == (200, first.json())
    assert (other.status_code, other.json()) == (409, ALREADY_REPLIED)
    customer = await db_client.get(path(job_id), headers=world.customer.headers)
    assert "reply" not in customer.json()["dispute"]
    assert SENTINEL not in customer.text.replace(customer.json()["dispute"]["description"], "")
    assert_no_leak(caplog.text)


async def test_no_reply_once_the_dispute_is_resolved(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)
    assert (await report(db_client, world.customer, job_id)).status_code == 201
    await db_session.execute(
        update(Dispute)
        .where(Dispute.job_id == job_id)
        .values(
            status=DisputeStatus.RESOLVED,
            resolution=DisputeResolution.RELEASED,
            resolved_by=world.admin.id,
            resolved_at=clock.now,
        )
    )

    response = await db_client.post(
        f"{pro_path(job_id)}/reply", json={"message": REPLY}, headers=world.pro.headers
    )

    assert (response.status_code, response.json()) == (409, NO_OPEN_DISPUTE)


async def test_a_reply_racing_the_resolution_finds_no_open_dispute(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = await completed_job(db_session, world, clock)
    assert (await report(db_client, world.customer, job_id)).status_code == 201
    set_pro_reply = DisputeRepository.set_pro_reply

    async def resolved_first(
        self: DisputeRepository, dispute_id: uuid.UUID, reply: str, now: datetime
    ) -> bool:
        # An admin resolves the dispute after the reply read it open.
        await db_session.execute(
            update(Dispute)
            .where(Dispute.id == dispute_id)
            .values(
                status=DisputeStatus.RESOLVED,
                resolution=DisputeResolution.RELEASED,
                resolved_by=world.admin.id,
                resolved_at=clock.now,
            )
        )
        await db_session.commit()
        return await set_pro_reply(self, dispute_id, reply, now)

    monkeypatch.setattr(DisputeRepository, "set_pro_reply", resolved_first)

    response = await db_client.post(
        f"{pro_path(job_id)}/reply", json={"message": REPLY}, headers=world.pro.headers
    )

    assert (response.status_code, response.json()) == (409, NO_OPEN_DISPUTE)
    [row] = await disputes(db_session)
    assert row.pro_reply is None


# --- Reading ---------------------------------------------------------------------------------


async def test_before_a_report_each_side_reads_null_and_the_deadline(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)
    completed_at = (await job_row(db_session, job_id)).completed_at
    assert completed_at is not None

    customer = await db_client.get(path(job_id), headers=world.customer.headers)
    pro = await db_client.get(pro_path(job_id), headers=world.pro.headers)

    assert customer.json() == {
        "dispute": None,
        "can_report": True,
        "report_by": (completed_at + WINDOW).isoformat().replace("+00:00", "Z"),
    }
    assert pro.json() == {"dispute": None, "can_reply": False}


@pytest.mark.parametrize(
    "text", ["   ", "a" + chr(0) + "b", "x" * 2001], ids=["blank", "nul", "long"]
)
async def test_a_blank_or_oversized_description_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    clock: Clock,
    text: str,
) -> None:
    job_id = await completed_job(db_session, world, clock)

    response = await report(db_client, world.customer, job_id, description=text)

    assert (response.status_code, response.json()) == (422, VALIDATION_ERROR)
    assert await disputes(db_session) == []


# --- Settings --------------------------------------------------------------------------------


def test_the_window_defaults_to_the_confirmation_window_and_never_exceeds_it() -> None:
    assert DisputeConfig.from_settings(make_settings()).window == WINDOW
    assert DisputeConfig.from_settings(make_settings(dispute_window_hours=24)).window == (
        timedelta(hours=24)
    )
    with pytest.raises(ValueError, match="DISPUTE_WINDOW_HOURS"):
        make_settings(dispute_window_hours=49)


async def test_a_dispute_photo_is_settled_by_the_copier_rows(
    db_session: AsyncSession, world: JobWorld, clock: Clock
) -> None:
    job_id = await completed_job(db_session, world, clock)
    dispute = Dispute(
        job_id=job_id,
        opened_by=world.customer.id,
        reason_code=DisputeReason.OTHER,
        description="x",
    )
    db_session.add(dispute)
    await db_session.flush()
    photo = DisputePhoto(
        dispute_id=dispute.id,
        file_key=photo_key(world.customer, clock.now),
        uploaded_by=world.customer.id,
    )
    db_session.add(photo)
    await db_session.flush()
    rows = DisputePhotoRows([photo.id])

    assert await rows.pending(db_session, dispute.id) == [(photo.id, photo.file_key)]
    assert await rows.mark_ready(db_session, photo.id, "m/a.jpg", "image/jpeg")
    assert not await rows.mark_ready(db_session, photo.id, "m/b.jpg", "image/jpeg")
    assert await rows.pending(db_session, dispute.id) == []
    assert await rows.fail_pending(db_session, [photo.id]) == []
    stored = await db_session.scalar(
        select(DisputePhoto.safe_status).where(DisputePhoto.id == photo.id)
    )
    assert stored is MediaSafeStatus.READY
