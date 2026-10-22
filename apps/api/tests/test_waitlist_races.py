"""POST /v1/waitlist under real concurrency: each request commits on its own connection (#46).

Two joins of one ZIP overlap as far as the code lets them, conflicts are classified by
constraint, and no conflict path logs a contact (PR #164 review, round 1).
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select, text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.modules.auth import security
from app.modules.categories.models import Category
from app.modules.categories.service import CategoryService
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.modules.waitlist.models import WaitlistEntry, WaitlistSource
from app.modules.waitlist.repository import WaitlistRepository
from app.observability import JsonFormatter
from tests.conftest import (
    LOCK_WAIT_DEADLINE_SECONDS,
    TEST_JWT_SECRET,
    backend_pid,
    make_settings,
)

# Fixture values only: no real ZIP or contact.
ZIP = "00079"
EMAIL_A = "race-a@example.com"
EMAIL_B = "race-b@example.com"
PHONE = "+14075550979"
USER_EMAIL = "race-user@example.com"
STEP_DEADLINE_SECONDS = 2 * LOCK_WAIT_DEADLINE_SECONDS


@dataclass(frozen=True)
class World:
    client: httpx.AsyncClient
    sessions: async_sessionmaker[AsyncSession]
    category_id: uuid.UUID


@pytest.fixture
def settings() -> Settings:
    return make_settings(waitlist_join_limit=100, auth_rate_limit_requests=100)


@pytest.fixture
async def world(app: FastAPI, test_database_url: URL) -> AsyncIterator[World]:
    """The app with one real session per request; deletes its rows afterwards."""
    # hide_parameters as in production (app.db), so the log checks see what production logs.
    engine = create_async_engine(test_database_url, hide_parameters=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    app.state.session_factory = sessions
    async with sessions() as session:
        category = Category(
            slug=f"race-{uuid.uuid4().hex[:8]}", names={"en": "Test", "es": "Prueba"}, active=True
        )
        session.add(category)
        await session.commit()
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            yield World(client=client, sessions=sessions, category_id=category.id)
    finally:
        async with sessions() as session:
            await session.execute(delete(WaitlistEntry).where(WaitlistEntry.zip_code == ZIP))
            await session.execute(delete(Category).where(Category.id == category.id))
            await session.execute(delete(User).where(User.email == USER_EMAIL))
            await session.commit()
        await engine.dispose()


async def join(
    client: httpx.AsyncClient, headers: dict[str, str] | None = None, **body: Any
) -> httpx.Response:
    return await client.post(
        "/v1/waitlist", json={"zip_code": ZIP, "source": "web", **body}, headers=headers or {}
    )


async def rows(world: World) -> list[WaitlistEntry]:
    async with world.sessions() as session:
        statement = (
            select(WaitlistEntry)
            .where(WaitlistEntry.zip_code == ZIP)
            .order_by(WaitlistEntry.created_at, WaitlistEntry.id)
        )
        return list((await session.scalars(statement)).all())


async def seed(world: World, *contacts: tuple[str | None, str | None]) -> None:
    """Committed entries of ZIP, locale "en", one per (email, phone)."""
    async with world.sessions() as session:
        session.add_all(
            WaitlistEntry(zip_code=ZIP, email=email, phone=phone, source=WaitlistSource.WEB)
            for email, phone in contacts
        )
        await session.commit()


async def within_deadline[T](awaitable: Awaitable[T]) -> T:
    return await asyncio.wait_for(awaitable, STEP_DEADLINE_SECONDS)


class Overlap:
    """Two joins of one ZIP, overlapping as far as the code allows.

    The first join, right after its matching read, keeps its transaction open until the second
    one has made its own read, or until Postgres reports the second one waiting on a lock the
    first one holds. The second one, after its read, waits for the first one's response, so it
    writes last: the case where a lost insert race used to discard the second one's contacts.
    `second_waited` tells which happened: with the ZIP lock, always the wait.
    """

    def __init__(self, world: World, monkeypatch: pytest.MonkeyPatch) -> None:
        self._sessions = world.sessions
        self._pids: list[int] = []
        self._second_started = asyncio.Event()
        self._first_read = asyncio.Event()
        self._second_read = asyncio.Event()
        self._first_done = asyncio.Event()
        self.second_waited = False
        is_served = ServiceAreaService.is_served
        matching = WaitlistRepository.matching_for_update
        overlap = self

        async def served(self: ServiceAreaService, zip_code: str) -> bool:
            # The request's transaction runs on this connection from here to its commit.
            overlap._pids.append(await backend_pid(self._session))
            if len(overlap._pids) == 2:
                overlap._second_started.set()
            return await is_served(self, zip_code)

        async def read(
            self: WaitlistRepository, zip_code: str, email: str | None, phone: str | None
        ) -> list[WaitlistEntry]:
            found = await matching(self, zip_code, email, phone)
            if not overlap._first_read.is_set():
                overlap._first_read.set()
                await overlap._until_second_read_or_waiting()
            else:
                overlap._second_read.set()
                await within_deadline(overlap._first_done.wait())
            return found

        monkeypatch.setattr(ServiceAreaService, "is_served", served)
        monkeypatch.setattr(WaitlistRepository, "matching_for_update", read)

    async def _until_second_read_or_waiting(self) -> None:
        await within_deadline(self._second_started.wait())
        holder, waiter = self._pids
        query = text("SELECT CAST(:holder AS integer) = ANY(pg_blocking_pids(:waiter))")
        async with self._sessions() as monitor, asyncio.timeout(STEP_DEADLINE_SECONDS):
            while not self._second_read.is_set():
                if await monitor.scalar(query, {"holder": holder, "waiter": waiter}):
                    self.second_waited = True
                    return

    async def run(
        self,
        first: Callable[[], Coroutine[Any, Any, httpx.Response]],
        second: Callable[[], Coroutine[Any, Any, httpx.Response]],
    ) -> tuple[httpx.Response, httpx.Response]:
        first_task = asyncio.create_task(first())
        await within_deadline(self._first_read.wait())
        second_task = asyncio.create_task(second())
        try:
            first_response = await within_deadline(first_task)
        finally:
            self._first_done.set()
        return first_response, await within_deadline(second_task)


async def signed_in_user(world: World) -> tuple[uuid.UUID, dict[str, str]]:
    async with world.sessions() as session:
        user = User(email=USER_EMAIL, password_hash="x", role=UserRole.CUSTOMER)
        session.add(user)
        await session.commit()
    access = security.create_access_token(
        user_id=user.id,
        role=user.role,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    return user.id, {"Authorization": f"Bearer {access}"}


def conflicts(caplog: pytest.LogCaptureFixture) -> list[tuple[Any, Any]]:
    """(constraint, attempt) of each waitlist_conflict log line."""
    return [
        (getattr(record, "constraint", None), getattr(record, "attempt", None))
        for record in caplog.records
        if record.message == "waitlist_conflict"
    ]


def assert_server_error(response: httpx.Response) -> None:
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "internal_error"


# Scenarios: each test below runs one; the log test runs them all.


async def concurrent_new_entries(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    overlap = Overlap(world, monkeypatch)
    first, second = await overlap.run(
        lambda: join(world.client, email=EMAIL_A, locale="en"),
        lambda: join(
            world.client,
            email=EMAIL_A,
            phone=PHONE,
            locale="es",
            category_id=str(world.category_id),
        ),
    )

    assert overlap.second_waited
    assert [first.status_code, second.status_code] == [202, 202]
    [entry] = await rows(world)
    assert (entry.email, entry.phone, entry.category_id, entry.locale) == (
        EMAIL_A,
        PHONE,
        world.category_id,
        "es",
    )


async def concurrent_enrichment(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    await seed(world, (EMAIL_A, None), (EMAIL_B, None))
    overlap = Overlap(world, monkeypatch)

    first, second = await overlap.run(
        lambda: join(world.client, email=EMAIL_A, phone=PHONE),
        lambda: join(world.client, email=EMAIL_B, phone=PHONE, locale="es"),
    )

    assert overlap.second_waited
    assert [first.status_code, second.status_code] == [202, 202]
    by_email = {entry.email: entry for entry in await rows(world)}
    assert set(by_email) == {EMAIL_A, EMAIL_B}
    # The first join gave the phone to A; B keeps no phone, and the second join moved nothing.
    assert (by_email[EMAIL_A].phone, by_email[EMAIL_B].phone) == (PHONE, None)
    assert by_email[EMAIL_B].locale == "es"


async def email_on_a_phone_on_b(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    await seed(world, (EMAIL_A, None), (None, PHONE))

    response = await join(
        world.client, email=EMAIL_A, phone=PHONE, locale="es", category_id=str(world.category_id)
    )

    assert response.status_code == 202
    assert response.content == b""
    found = {(entry.email, entry.phone): entry for entry in await rows(world)}
    assert set(found) == {(EMAIL_A, None), (None, PHONE)}
    for entry in found.values():
        assert (entry.locale, entry.category_id) == ("es", world.category_id)


async def category_deleted_mid_join(
    world: World, monkeypatch: pytest.MonkeyPatch, *, existing: bool
) -> None:
    if existing:
        await seed(world, (EMAIL_A, None))
    is_active = CategoryService.is_active

    async def deleted_right_after_check(self: CategoryService, category_id: uuid.UUID) -> bool:
        active = await is_active(self, category_id)
        async with world.sessions() as other:
            await other.execute(delete(Category).where(Category.id == category_id))
            await other.commit()
        return active

    monkeypatch.setattr(CategoryService, "is_active", deleted_right_after_check)

    response = await join(world.client, email=EMAIL_A, category_id=str(world.category_id))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_category"
    found = [(entry.email, entry.category_id) for entry in await rows(world)]
    assert found == ([(EMAIL_A, None)] if existing else [])


async def category_fk_insert(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    await category_deleted_mid_join(world, monkeypatch, existing=False)


async def category_fk_update(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    await category_deleted_mid_join(world, monkeypatch, existing=True)


async def user_deleted_mid_join(
    world: World, monkeypatch: pytest.MonkeyPatch, *, existing: bool
) -> None:
    """An integrity error the join does not expect: the user's foreign key."""
    if existing:
        await seed(world, (EMAIL_A, None))
    user_id, headers = await signed_in_user(world)
    is_served = ServiceAreaService.is_served

    async def user_deleted_after_auth(self: ServiceAreaService, zip_code: str) -> bool:
        async with world.sessions() as other:
            await other.execute(delete(User).where(User.id == user_id))
            await other.commit()
        return await is_served(self, zip_code)

    monkeypatch.setattr(ServiceAreaService, "is_served", user_deleted_after_auth)

    response = await join(world.client, headers=headers, email=EMAIL_A, phone=PHONE)

    assert_server_error(response)
    found = [(entry.email, entry.phone, entry.user_id) for entry in await rows(world)]
    assert found == ([(EMAIL_A, None, None)] if existing else [])


async def unexpected_insert(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    await user_deleted_mid_join(world, monkeypatch, existing=False)


async def unexpected_update(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    await user_deleted_mid_join(world, monkeypatch, existing=True)


def outside_writer(
    world: World, monkeypatch: pytest.MonkeyPatch, *writes: tuple[str | None, str | None]
) -> None:
    """After each matching read, another connection commits the next entry of `writes`: a writer
    that skips the ZIP lock, so the join's write meets a unique violation."""
    matching = WaitlistRepository.matching_for_update
    pending = list(writes)

    async def read_then_other_writes(
        self: WaitlistRepository, zip_code: str, email: str | None, phone: str | None
    ) -> list[WaitlistEntry]:
        found = await matching(self, zip_code, email, phone)
        if pending:
            await seed(world, pending.pop(0))
        return found

    monkeypatch.setattr(WaitlistRepository, "matching_for_update", read_then_other_writes)


async def duplicate_retried(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    outside_writer(world, monkeypatch, (EMAIL_A, None))

    response = await join(
        world.client, email=EMAIL_A, phone=PHONE, locale="es", category_id=str(world.category_id)
    )

    assert response.status_code == 202
    [entry] = await rows(world)
    assert (entry.email, entry.phone, entry.locale, entry.category_id) == (
        EMAIL_A,
        PHONE,
        "es",
        world.category_id,
    )


async def duplicate_twice(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    # The insert meets A's email; the retry, updating A, meets the phone on its own entry.
    outside_writer(world, monkeypatch, (EMAIL_A, None), (None, PHONE))

    response = await join(world.client, email=EMAIL_A, phone=PHONE)

    assert_server_error(response)
    found = {(entry.email, entry.phone) for entry in await rows(world)}
    assert found == {(EMAIL_A, None), (None, PHONE)}


async def test_concurrent_new_entries_same_zip_both_contacts_saved(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    await concurrent_new_entries(world, monkeypatch)


async def test_concurrent_enrichment_same_phone_no_500_and_one_owner(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    await concurrent_enrichment(world, monkeypatch)


async def test_email_on_a_phone_on_b_refreshes_both_moves_nothing(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    await email_on_a_phone_on_b(world, monkeypatch)


@pytest.mark.parametrize("existing", [False, True], ids=["insert", "update"])
async def test_category_fk_race_is_422_not_202(
    world: World, monkeypatch: pytest.MonkeyPatch, existing: bool
) -> None:
    await category_deleted_mid_join(world, monkeypatch, existing=existing)


@pytest.mark.parametrize("existing", [False, True], ids=["insert", "update"])
async def test_unexpected_integrity_error_is_500_not_202(
    world: World, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, existing: bool
) -> None:
    await user_deleted_mid_join(world, monkeypatch, existing=existing)

    # Not retried: only a contact's unique index is.
    assert conflicts(caplog) == [("fk_waitlist_entries_user_id_users", 1)]


async def test_duplicate_from_a_writer_outside_the_lock_is_reread_and_applied(
    world: World, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    await duplicate_retried(world, monkeypatch)

    assert conflicts(caplog) == [("uq_waitlist_entries_zip_code_email", 1)]


async def test_duplicate_again_after_the_reread_is_500(
    world: World, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    await duplicate_twice(world, monkeypatch)

    assert conflicts(caplog) == [
        ("uq_waitlist_entries_zip_code_email", 1),
        ("uq_waitlist_entries_zip_code_phone", 2),
    ]


SCENARIOS = {
    "new_entries": concurrent_new_entries,
    "enrichment": concurrent_enrichment,
    "email_a_phone_b": email_on_a_phone_on_b,
    "category_fk_insert": category_fk_insert,
    "category_fk_update": category_fk_update,
    "unexpected_insert": unexpected_insert,
    "unexpected_update": unexpected_update,
    "duplicate_retried": duplicate_retried,
    "duplicate_twice": duplicate_twice,
}


@pytest.mark.parametrize("scenario", SCENARIOS)
async def test_no_email_or_phone_in_logs_for_every_conflict_path(
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    scenario: str,
) -> None:
    with caplog.at_level(logging.DEBUG):
        await SCENARIOS[scenario](world, monkeypatch)

    assert caplog.records
    output = "\n".join(JsonFormatter().format(record) for record in caplog.records).lower()
    for contact in (EMAIL_A, EMAIL_B, USER_EMAIL, PHONE, PHONE[2:]):
        assert contact not in output
