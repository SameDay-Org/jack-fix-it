"""#511 round 1, on real commits and separate connections: what the request's row lock does not
cover by itself.

- The hold (#82): a dispatch queued before the BDC held the request, run after the hold was
  committed, does nothing; one that waits on the staff transaction reads the hold once it
  gets the lock. Resumed, the request is dispatched again.
- A pro's eligibility: whoever gets an offer, by hand or by the automatic dispatch, is read
  again under FOR SHARE locks held to the commit. A revocation committed before that read
  refuses the pro (nothing written, no push); one made after it waits until the offer is
  committed.

The audit writes are recorded, not written (audit_log is append-only); every other row is
deleted afterwards."""

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Final

import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.addresses.models import Address
from app.modules.audit.service import AuditService
from app.modules.audit.types import AuditAction
from app.modules.categories.models import Category
from app.modules.dispatch.models import RequestDispatch
from app.modules.dispatch.repository import DispatchRepository
from app.modules.dispatch.service import dispatch_job_id, enqueue_dispatch
from app.modules.dispatch.tasks import dispatch_request
from app.modules.ops.models import RequestFollowup, RequestNote
from app.modules.pros.models import (
    ProCategory,
    ProProfile,
    ProServiceArea,
    ProVerificationStatus,
)
from app.modules.pros.service import ProService
from app.modules.requests.models import RequestOrigin, RequestStatus, ServiceRequest
from app.modules.service_areas.models import ServiceArea
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserRole, UserStatus
from tests.conftest import Committed, make_settings
from tests.helpers import as_status_writer, letter_tag
from tests.job_world import headers_for, record_pushes
from tests.test_job_state_concurrency import backend_pid
from tests.test_me_card_fields import FakeStorage
from tests.test_requests_api import RecordingQueue

BASE: Final = "/v1/admin/requests"
LOCK_WAIT_SECONDS: Final = 10
# A revocation, and what an assignment of the pro answers once it has been read.
REVOCATIONS: Final = {
    "suspended": (404, "pro_not_found"),
    "demoted": (404, "pro_not_found"),
    "unapproved": (409, "pro_not_approved"),
    "payouts": (409, "pro_payouts_disabled"),
    "category": (409, "pro_category_mismatch"),
    "area": (409, "pro_out_of_area"),
    "area_off": (409, "pro_out_of_area"),
}


@dataclass
class Scene:
    """A classified request in reviewing, one pro who may receive it, an admin: committed."""

    committed: Committed
    request_id: uuid.UUID
    pro_id: uuid.UUID
    pro_user_id: uuid.UUID
    area_id: uuid.UUID
    category_id: uuid.UUID
    admin_headers: dict[str, str]
    audited: list[AuditAction] = field(default_factory=list)

    @property
    def sessions(self) -> async_sessionmaker[AsyncSession]:
        return self.committed.sessions


@pytest.fixture
async def scene(committed: Committed, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Scene]:
    audited: list[AuditAction] = []

    async def no_row(self: AuditService, actor_id: uuid.UUID, action: AuditAction, *_: Any) -> None:
        audited.append(action)

    monkeypatch.setattr(AuditService, "record_staff_action", no_row)
    tag = letter_tag()
    # A ZIP nothing else in the test database uses.
    zip_code = f"8{uuid.uuid4().int % 10_000:04d}"
    async with committed.sessions() as session:
        customer = User(email=committed.email, password_hash="x", role=UserRole.CUSTOMER)
        admin = User(email=f"lock511-{tag}-admin@x.com", password_hash="x", role=UserRole.ADMIN)
        pro_user = User(email=f"lock511-{tag}-pro@x.com", password_hash="x", role=UserRole.PRO)
        category = Category(slug=f"lock511-{tag}", names={"en": "Locks", "es": "Cerrojos"})
        area = ServiceArea(region="Test", city="Orlando", state="FL", zip_code=zip_code)
        session.add_all([customer, admin, pro_user, category, area])
        await session.flush()
        profile = ProProfile(
            user_id=pro_user.id,
            verification_status=ProVerificationStatus.APPROVED,
            payouts_enabled=True,
        )
        address = Address(
            user_id=customer.id, line1="1 Lock Lane", city="Orlando", state="FL", zip_code=zip_code
        )
        session.add_all([profile, address])
        await session.flush()
        request = ServiceRequest(
            customer_id=customer.id,
            address_id=address.id,
            category_id=category.id,
            description="locks",
            origin=RequestOrigin.APP,
        )
        session.add_all(
            [
                request,
                ProCategory(pro_id=profile.id, category_id=category.id),
                ProServiceArea(pro_id=profile.id, service_area_id=area.id),
            ]
        )
        await session.commit()
    try:
        yield Scene(
            committed,
            request.id,
            profile.id,
            pro_user.id,
            area.id,
            category.id,
            headers_for(admin.id, UserRole.ADMIN),
            audited,
        )
    finally:
        async with committed.sessions() as session:
            for statement in (
                delete(RequestDispatch).where(RequestDispatch.request_id == request.id),
                delete(RequestNote).where(RequestNote.request_id == request.id),
                delete(RequestFollowup).where(RequestFollowup.request_id == request.id),
                delete(ServiceRequest).where(ServiceRequest.id == request.id),
                delete(Address).where(Address.id == address.id),
                delete(ProCategory).where(ProCategory.pro_id == profile.id),
                delete(ProServiceArea).where(ProServiceArea.pro_id == profile.id),
                delete(ProProfile).where(ProProfile.id == profile.id),
                delete(User).where(User.id.in_([customer.id, admin.id, pro_user.id])),
                delete(ServiceArea).where(ServiceArea.id == area.id),
                delete(Category).where(Category.id == category.id),
            ):
                await session.execute(statement)
            await session.commit()


async def set_status(scene: Scene, status: RequestStatus) -> None:
    """Puts the request in `status` (the state machine's guard allows a test writer)."""
    async with scene.sessions() as session:
        async with as_status_writer(session):
            await session.execute(
                update(ServiceRequest)
                .where(ServiceRequest.id == scene.request_id)
                .values(status=status)
            )
        await session.commit()


async def request_row(scene: Scene) -> tuple[RequestStatus, bool, int]:
    """(its status, whether it is held, how many offers it has)."""
    async with scene.sessions() as session:
        row = (
            await session.execute(
                select(ServiceRequest.status, ServiceRequest.info_requested_at).where(
                    ServiceRequest.id == scene.request_id
                )
            )
        ).one()
        offers = await session.scalar(
            select(func.count())
            .select_from(RequestDispatch)
            .where(RequestDispatch.request_id == scene.request_id)
        )
    return row.status, row.info_requested_at is not None, int(offers or 0)


def revocation(scene: Scene, kind: str) -> Any:
    """The statement that takes the pro's eligibility away, as its writer would."""
    return {
        "suspended": update(User)
        .where(User.id == scene.pro_user_id)
        .values(status=UserStatus.SUSPENDED),
        "demoted": update(User).where(User.id == scene.pro_user_id).values(role=UserRole.CUSTOMER),
        "unapproved": update(ProProfile)
        .where(ProProfile.id == scene.pro_id)
        .values(verification_status=ProVerificationStatus.REJECTED),
        "payouts": update(ProProfile)
        .where(ProProfile.id == scene.pro_id)
        .values(payouts_enabled=False),
        "category": delete(ProCategory).where(ProCategory.pro_id == scene.pro_id),
        "area": delete(ProServiceArea).where(ProServiceArea.pro_id == scene.pro_id),
        "area_off": update(ServiceArea).where(ServiceArea.id == scene.area_id).values(active=False),
    }[kind]


async def revoke(scene: Scene, kind: str) -> None:
    async with scene.sessions() as session:
        await session.execute(revocation(scene, kind))
        await session.commit()


async def wait_until_waiting(sessions: async_sessionmaker[AsyncSession], pid: int) -> None:
    """Returns once Postgres reports backend `pid` waiting on another backend's lock."""
    query = text("SELECT cardinality(pg_blocking_pids(:pid)) > 0")
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_SECONDS):
                # Each pass is a query: the loop waits on the database, as wait_until_blocked.
                while not await monitor.scalar(query, {"pid": pid}):
                    pass
        except TimeoutError:
            pytest.fail(f"backend {pid} never waited on a lock within {LOCK_WAIT_SECONDS} s")


@dataclass
class Pause:
    """Stops the first call of a method until `go` is set; `inside` says it got there."""

    inside: asyncio.Event = field(default_factory=asyncio.Event)
    go: asyncio.Event = field(default_factory=asyncio.Event)
    calls: int = 0


def pause_at(monkeypatch: pytest.MonkeyPatch, owner: type, name: str) -> Pause:
    pause = Pause()
    original: Callable[..., Awaitable[Any]] = getattr(owner, name)

    async def paused(self: object, *args: Any, **kwargs: Any) -> Any:
        pause.calls += 1
        if pause.calls == 1:
            pause.inside.set()
            await pause.go.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(owner, name, paused)
    return pause


def worker(
    scene: Scene, queue: RecordingQueue, session: AsyncSession | None = None
) -> dict[str, Any]:
    """The dispatch worker's context: its own sessions, or `session` alone."""

    @asynccontextmanager
    async def same() -> AsyncIterator[AsyncSession]:
        assert session is not None
        yield session

    return {
        "session_factory": scene.sessions if session is None else same,
        "redis": queue,
        "settings": make_settings(),
    }


def pushes(queue: RecordingQueue) -> list[tuple[object, ...]]:
    return [args for function, args in queue.jobs.values() if function == "send_push"]


async def post(scene: Scene, action: str, body: dict[str, str] | None = None) -> Any:
    return await scene.committed.client.post(
        f"{BASE}/{scene.request_id}/{action}", json=body, headers=scene.admin_headers
    )


# --- The hold, read under the request's lock (Gatekeeper B1 = Vault B2) ------------------------


@pytest.mark.parametrize("start", [RequestStatus.RECEIVED, RequestStatus.REVIEWING])
async def test_a_dispatch_queued_before_the_hold_does_nothing_and_runs_once_resumed(
    app: FastAPI, scene: Scene, start: RequestStatus
) -> None:
    """Received: the request's own first dispatch (a classified request from the app);
    reviewing: the sweep's or a kick's. Queued before more-info commits, run after it: held,
    nothing written, nothing sent. Resumed, the same task sends the request."""
    record_pushes(app)
    await set_status(scene, start)
    queue = RecordingQueue()
    assert await enqueue_dispatch(queue, scene.request_id, 1.0)
    # The job the worker will run: dispatch_request for this request.
    queued = queue.jobs[dispatch_job_id(scene.request_id)]
    assert queued == ("dispatch_request", (str(scene.request_id),))
    asked = await post(scene, "more-info", {"question": "Which room is it?"})
    assert asked.status_code == 200, asked.text

    sent = RecordingQueue()
    outcome = await dispatch_request(worker(scene, sent), str(scene.request_id))

    assert outcome == "held"
    assert await request_row(scene) == (RequestStatus.REVIEWING, True, 0)
    assert pushes(sent) == []

    resumed = await post(scene, "resume")
    assert resumed.status_code == 200, resumed.text
    outcome = await dispatch_request(worker(scene, sent), str(scene.request_id))

    assert outcome == "sent"
    assert await request_row(scene) == (RequestStatus.FINDING_PRO, False, 1)
    assert len(pushes(sent)) == 1


async def test_a_worker_waiting_on_the_staff_transaction_reads_the_hold_it_commits(
    app: FastAPI, scene: Scene, monkeypatch: pytest.MonkeyPatch
) -> None:
    """more-info holds the request's row lock until it commits; the worker that starts then
    waits on it (as Postgres reports), and once it gets the lock it reads the hold."""
    record_pushes(app)
    await set_status(scene, RequestStatus.REVIEWING)
    pause = pause_at(monkeypatch, AuditService, "record_staff_action")
    asked = asyncio.create_task(post(scene, "more-info", {"question": "Which room is it?"}))
    sent = RecordingQueue()
    try:
        async with asyncio.timeout(LOCK_WAIT_SECONDS):
            await pause.inside.wait()
        async with scene.sessions() as session:
            # The pid's transaction is the worker's: a commit would hand back the connection.
            pid = await backend_pid(session)
            running = asyncio.create_task(
                dispatch_request(worker(scene, sent, session), str(scene.request_id))
            )
            await wait_until_waiting(scene.sessions, pid)
            pause.go.set()
            assert (await asyncio.wait_for(asked, LOCK_WAIT_SECONDS)).status_code == 200
            outcome = await asyncio.wait_for(running, LOCK_WAIT_SECONDS)
    finally:
        pause.go.set()

    assert outcome == "held"
    assert await request_row(scene) == (RequestStatus.REVIEWING, True, 0)
    assert pushes(sent) == []


# --- A pro's eligibility, read under locks held to the offer's commit (Vault B1) --------------


@pytest.mark.parametrize("kind", list(REVOCATIONS))
async def test_an_assignment_refuses_a_pro_revoked_before_its_locked_read(
    app: FastAPI, scene: Scene, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """The revocation commits after the request's lock and before eligibility is read: the
    read sees it. The refusal names the reason; nothing is written, nothing is sent."""
    sent = record_pushes(app)
    pause = pause_at(monkeypatch, ServiceAreaService, "active_ids_for_zip")
    assigning = asyncio.create_task(post(scene, "assign", {"pro_id": str(scene.pro_id)}))
    try:
        async with asyncio.timeout(LOCK_WAIT_SECONDS):
            await pause.inside.wait()
        await revoke(scene, kind)
    finally:
        pause.go.set()
    answer = await asyncio.wait_for(assigning, LOCK_WAIT_SECONDS)

    status, code = REVOCATIONS[kind]
    assert (answer.status_code, answer.json()["error"]["code"]) == (status, code), answer.text
    assert await request_row(scene) == (RequestStatus.RECEIVED, False, 0)
    assert sent.jobs == {}
    assert scene.audited == []


@pytest.mark.parametrize("kind", list(REVOCATIONS))
async def test_a_revocation_after_the_locked_read_waits_for_the_assignment(
    app: FastAPI, scene: Scene, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """The assignment has read the pro under its locks and is about to write the offer: the
    revocation waits on those locks (as Postgres reports) until the offer is committed, then
    applies. The offer and its push were made while the pro was eligible."""
    sent = record_pushes(app)
    pause = pause_at(monkeypatch, DispatchRepository, "add_many")
    assigning = asyncio.create_task(post(scene, "assign", {"pro_id": str(scene.pro_id)}))
    try:
        async with asyncio.timeout(LOCK_WAIT_SECONDS):
            await pause.inside.wait()
        async with scene.sessions() as revoker:
            pid = await backend_pid(revoker)
            revoking = asyncio.create_task(revoker.execute(revocation(scene, kind)))
            await wait_until_waiting(scene.sessions, pid)
            pause.go.set()
            answer = await asyncio.wait_for(assigning, LOCK_WAIT_SECONDS)
            await asyncio.wait_for(revoking, LOCK_WAIT_SECONDS)
            await revoker.commit()
    finally:
        pause.go.set()

    assert answer.status_code == 200, answer.text
    assert await request_row(scene) == (RequestStatus.FINDING_PRO, False, 1)
    assert len(pushes(sent)) == 1
    assert scene.audited == [AuditAction.REQUEST_ASSIGN_PRO]


@pytest.mark.parametrize("kind", [kind for kind in REVOCATIONS if kind != "area_off"])
async def test_the_automatic_dispatch_skips_a_pro_revoked_before_its_locked_read(
    scene: Scene, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """The worker ranked the pro without locks; the revocation commits before the worker reads
    the pro again under locks: the pro is skipped, so no offer, no push, no move. (An area
    switched off then waits instead: the worker locked the ZIP's areas first; next test.)
    Paused where the locked read starts: the profile's account, read without a lock to lock
    the account first (#511 round 2)."""
    await set_status(scene, RequestStatus.REVIEWING)
    pause = pause_at(monkeypatch, ProService, "user_id_of")
    sent = RecordingQueue()
    running = asyncio.create_task(dispatch_request(worker(scene, sent), str(scene.request_id)))
    try:
        async with asyncio.timeout(LOCK_WAIT_SECONDS):
            await pause.inside.wait()
        await revoke(scene, kind)
    finally:
        pause.go.set()
    outcome = await asyncio.wait_for(running, LOCK_WAIT_SECONDS)

    assert outcome == "no_eligible_pros"
    assert await request_row(scene) == (RequestStatus.REVIEWING, False, 0)
    assert pushes(sent) == []


@pytest.mark.parametrize("kind", list(REVOCATIONS))
async def test_a_revocation_after_the_worker_s_locked_read_waits_for_its_offer(
    scene: Scene, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    await set_status(scene, RequestStatus.REVIEWING)
    pause = pause_at(monkeypatch, DispatchRepository, "add_many")
    sent = RecordingQueue()
    running = asyncio.create_task(dispatch_request(worker(scene, sent), str(scene.request_id)))
    try:
        async with asyncio.timeout(LOCK_WAIT_SECONDS):
            await pause.inside.wait()
        async with scene.sessions() as revoker:
            pid = await backend_pid(revoker)
            revoking = asyncio.create_task(revoker.execute(revocation(scene, kind)))
            await wait_until_waiting(scene.sessions, pid)
            pause.go.set()
            outcome = await asyncio.wait_for(running, LOCK_WAIT_SECONDS)
            await asyncio.wait_for(revoking, LOCK_WAIT_SECONDS)
            await revoker.commit()
    finally:
        pause.go.set()

    assert outcome == "sent"
    assert await request_row(scene) == (RequestStatus.FINDING_PRO, False, 1)
    assert len(pushes(sent)) == 1


# --- One order for the pro's account and profile (#511 round 2, Gatekeeper B1) -----------------

# Any backend of this database that `holder` blocks.
BLOCKED_BY: Final = text(
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
    "AND CAST(:holder AS integer) = ANY(pg_blocking_pids(pid))"
)


def pause_after_the_first_pro_lock(monkeypatch: pytest.MonkeyPatch) -> tuple[Pause, dict[str, int]]:
    """Stops an offer right after its first lock on the pro's rows, whichever it takes first
    (the account or the profile), with the backend holding it."""
    pause = Pause()
    held: dict[str, int] = {}
    for owner, name in ((UserService, "active_ids_with_role"), (ProService, "assign_candidate")):
        original: Callable[..., Awaitable[Any]] = getattr(owner, name)

        async def paused(
            self: Any,
            *args: Any,
            _original: Callable[..., Awaitable[Any]] = original,
            **kwargs: Any,
        ) -> Any:
            result = await _original(self, *args, **kwargs)
            if kwargs.get("lock") and pause.calls == 0:
                pause.calls += 1
                # Read inside the offer's transaction: it keeps its connection to the commit.
                held["offer"] = await backend_pid(self._session)
                pause.inside.set()
                await pause.go.wait()
            return result

        monkeypatch.setattr(owner, name, paused)
    return pause, held


@pytest.mark.parametrize("offer", ["by_hand", "automatic"])
async def test_a_pros_new_id_photo_and_an_offer_to_them_take_one_order(
    app: FastAPI, scene: Scene, monkeypatch: pytest.MonkeyPatch, offer: str
) -> None:
    """The real PATCH /v1/auth/me with a first ID photo (#250) locks the pro's account, then
    writes their profile's photo. Against an offer holding its first lock on the pro, the two
    queue when the offer takes the same order (the account first), and deadlock (40P01, a 500
    for one of them) when it takes the profile first: the order is pinned here, not by the doc."""
    record_pushes(app)
    app.state.storage = FakeStorage()
    pause, held = pause_after_the_first_pro_lock(monkeypatch)
    if offer == "by_hand":
        offering = asyncio.create_task(post(scene, "assign", {"pro_id": str(scene.pro_id)}))
    else:
        await set_status(scene, RequestStatus.REVIEWING)
        offering = asyncio.create_task(
            dispatch_request(worker(scene, RecordingQueue()), str(scene.request_id))
        )
    key = f"u/{scene.pro_user_id}/profile_photo/{uuid.uuid4().hex}.jpg"
    try:
        async with asyncio.timeout(LOCK_WAIT_SECONDS):
            await pause.inside.wait()
        patching = asyncio.create_task(
            scene.committed.client.patch(
                "/v1/auth/me",
                json={"photo_key": key},
                headers=headers_for(scene.pro_user_id, UserRole.PRO),
            )
        )
        # The photo write waits behind the offer's first lock, whichever it is.
        async with scene.sessions() as monitor, asyncio.timeout(LOCK_WAIT_SECONDS):
            while not await monitor.scalar(BLOCKED_BY, {"holder": held["offer"]}):
                await monitor.rollback()  # pg_stat_activity is a per-transaction snapshot
    finally:
        pause.go.set()
    offered, patched = await asyncio.wait_for(
        asyncio.gather(offering, patching, return_exceptions=True), 3 * LOCK_WAIT_SECONDS
    )

    if offer == "by_hand":
        assert getattr(offered, "status_code", offered) == 200, offered
    else:
        assert offered == "sent", offered
    assert getattr(patched, "status_code", patched) == 200, patched
    async with scene.sessions() as session:
        photo = await session.scalar(
            select(ProProfile.photo_key).where(ProProfile.id == scene.pro_id)
        )
    assert photo == key
    assert await request_row(scene) == (RequestStatus.FINDING_PRO, False, 1)
