"""The photos and videos of a pro's opportunity detail (#173 part 2, D9.2).

Pros get the privacy-safe copies only, signed from their opaque m/ keys; the original key
(u/<customer id>/...) is never signed for them. The storage spy below checks that after every
test of this module.
"""

import logging
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.requests.media_copies import SAFE_KEY_PREFIX, safe_key_for
from app.modules.requests.models import MediaSafeStatus, RequestMedia, RequestMediaKind
from tests.conftest import make_settings
from tests.test_opportunities_api import BASE, T0, World, build_world, dispatch, make_request
from tests.test_requests_api import FakeStorage

TTL = 123  # not the default 300, so the tests prove the setting is read


@pytest.fixture
def settings() -> Settings:
    return make_settings(download_url_ttl_seconds=TTL)


@pytest.fixture
def storage(app: FastAPI) -> Iterator[FakeStorage]:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    yield fake
    # Whatever the test did, nothing but a safe copy's key was signed.
    unsafe = [key for key, _ in fake.gets if not key.startswith(SAFE_KEY_PREFIX)]
    assert unsafe == []
    assert not [key for key, _ in fake.gets if key.startswith("u/")]


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


@dataclass(frozen=True)
class Media:
    id: uuid.UUID
    status: MediaSafeStatus
    file_key: str
    safe_key: str | None


async def add_media(
    session: AsyncSession,
    world: World,
    request_id: uuid.UUID,
    kind: RequestMediaKind,
    status: MediaSafeStatus,
    *,
    created_at: datetime,
    media_id: uuid.UUID | None = None,
    safe_key: str | None = None,
) -> Media:
    """A media row as part 1 can leave it: a ready row has its m/ key and content type, unless
    `safe_key` forces another key. A failed one has them too (the worst case: a copy written,
    then refused), so only its status can keep it from a pro."""
    media_id = media_id or uuid.uuid4()
    extension, content_type = (
        (".mp4", "video/mp4") if kind is RequestMediaKind.VIDEO else (".jpg", "image/jpeg")
    )
    file_key = f"u/{world.customer_id}/request_media/{media_id.hex}{extension}"
    copied = status is not MediaSafeStatus.PENDING
    key = (
        safe_key
        if safe_key is not None
        else (safe_key_for(media_id, extension) if copied else None)
    )
    session.add(
        RequestMedia(
            id=media_id,
            request_id=request_id,
            kind=kind,
            file_key=file_key,
            safe_status=status,
            safe_key=key,
            safe_content_type=content_type if copied else None,
            created_at=created_at,
        )
    )
    await session.flush()
    return Media(media_id, status, file_key, key)


async def open_detail(
    client: httpx.AsyncClient, world: World, dispatch_id: uuid.UUID
) -> httpx.Response:
    return await client.get(f"{BASE}/{dispatch_id}", headers=world.me.caller.headers)


def descending_ids(count: int) -> list[uuid.UUID]:
    """Ids in the reverse of their creation order, so only created_at can give that order."""
    return sorted((uuid.uuid4() for _ in range(count)), reverse=True)


async def test_detail_lists_ready_safe_media_in_order(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    request_id = await make_request(db_session, world)
    kinds = [RequestMediaKind.PHOTO, RequestMediaKind.VIDEO, RequestMediaKind.PHOTO]
    rows = [
        await add_media(
            db_session,
            world,
            request_id,
            kind,
            MediaSafeStatus.READY,
            created_at=T0 + timedelta(seconds=n),
            media_id=media_id,
        )
        for n, (kind, media_id) in enumerate(zip(kinds, descending_ids(3), strict=True))
    ]
    dispatch_id = await dispatch(db_session, request_id, world.me)

    before = datetime.now(UTC)
    response = await open_detail(db_client, world, dispatch_id)
    after = datetime.now(UTC)

    assert response.status_code == 200
    body = response.json()
    assert body["media_pending"] == 0
    assert [item["kind"] for item in body["media"]] == ["photo", "video", "photo"]
    assert [item["content_type"] for item in body["media"]] == [
        "image/jpeg",
        "video/mp4",
        "image/jpeg",
    ]
    assert storage.gets == [(row.safe_key, TTL) for row in rows]
    for item, row in zip(body["media"], rows, strict=True):
        assert row.safe_key is not None
        assert row.safe_key.startswith(SAFE_KEY_PREFIX)
        assert item["url"] == f"https://storage.example.invalid/get/{row.safe_key}?sig=fake"
        expires_at = datetime.fromisoformat(item["expires_at"])
        assert before + timedelta(seconds=TTL) <= expires_at <= after + timedelta(seconds=TTL)
        assert set(item) == {"kind", "content_type", "url", "expires_at"}


async def test_pending_is_counted_and_failed_is_hidden(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world)
    statuses = [
        MediaSafeStatus.FAILED,
        MediaSafeStatus.PENDING,
        MediaSafeStatus.READY,
        MediaSafeStatus.FAILED,
        MediaSafeStatus.PENDING,
        MediaSafeStatus.PENDING,
    ]
    rows = [
        await add_media(
            db_session,
            world,
            request_id,
            RequestMediaKind.PHOTO,
            status,
            created_at=T0 + timedelta(seconds=n),
        )
        for n, status in enumerate(statuses)
    ]
    # Another request's media are not this one's.
    other = await make_request(db_session, world)
    await add_media(
        db_session, world, other, RequestMediaKind.PHOTO, MediaSafeStatus.READY, created_at=T0
    )
    await add_media(
        db_session, world, other, RequestMediaKind.PHOTO, MediaSafeStatus.PENDING, created_at=T0
    )
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.INFO):
        body = (await open_detail(db_client, world, dispatch_id)).json()

    assert body["media_pending"] == 3
    [ready] = [row for row in rows if row.status is MediaSafeStatus.READY]
    assert [item["url"] for item in body["media"]] == [
        f"https://storage.example.invalid/get/{ready.safe_key}?sig=fake"
    ]
    assert storage.gets == [(ready.safe_key, TTL)]
    # The failed rows hold m/ keys: their status hid them, not the signer's refusal.
    assert not [r for r in caplog.records if r.message == "pro_media_key_refused"]


async def test_only_safe_keys_are_signed(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world)
    first = await add_media(
        db_session, world, request_id, RequestMediaKind.PHOTO, MediaSafeStatus.READY, created_at=T0
    )
    # A ready row whose safe key is not a safe copy's: a bug or a bad write must not sign it.
    forced = await add_media(
        db_session,
        world,
        request_id,
        RequestMediaKind.PHOTO,
        MediaSafeStatus.READY,
        created_at=T0 + timedelta(seconds=1),
        safe_key=f"u/{world.customer_id}/request_media/forced.jpg",
    )
    last = await add_media(
        db_session,
        world,
        request_id,
        RequestMediaKind.VIDEO,
        MediaSafeStatus.READY,
        created_at=T0 + timedelta(seconds=2),
    )
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.INFO):
        response = await open_detail(db_client, world, dispatch_id)

    assert response.status_code == 200
    body = response.json()
    assert [item["kind"] for item in body["media"]] == ["photo", "video"]
    assert storage.gets == [(first.safe_key, TTL), (last.safe_key, TTL)]
    assert body["description"]  # the rest of the detail is served
    [refused] = [r for r in caplog.records if r.message == "pro_media_key_refused"]
    assert refused.levelno == logging.ERROR
    assert refused.__dict__["media_id"] == str(forced.id)
    standard = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime", "request_id"}
    assert set(refused.__dict__) - standard == {"media_id"}
    output = "\n".join(r.getMessage() + str(r.__dict__) for r in caplog.records)
    assert "forced.jpg" not in output
    assert str(world.customer_id) not in output


async def test_a_ready_row_without_its_key_or_type_is_refused(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id = await make_request(db_session, world)
    served = await add_media(
        db_session, world, request_id, RequestMediaKind.PHOTO, MediaSafeStatus.READY, created_at=T0
    )
    no_key = RequestMedia(
        request_id=request_id,
        kind=RequestMediaKind.PHOTO,
        file_key=f"u/{world.customer_id}/request_media/no-key.jpg",
        safe_status=MediaSafeStatus.READY,
        safe_content_type="image/jpeg",
    )
    no_type = RequestMedia(
        request_id=request_id,
        kind=RequestMediaKind.PHOTO,
        file_key=f"u/{world.customer_id}/request_media/no-type.jpg",
        safe_status=MediaSafeStatus.READY,
        safe_key=f"{SAFE_KEY_PREFIX}{uuid.uuid4().hex}.jpg",
    )
    db_session.add_all([no_key, no_type])
    await db_session.flush()
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.INFO):
        body = (await open_detail(db_client, world, dispatch_id)).json()

    assert storage.gets == [(served.safe_key, TTL)]
    assert len(body["media"]) == 1
    refused = {
        r.__dict__["media_id"] for r in caplog.records if r.message == "pro_media_key_refused"
    }
    assert refused == {str(no_key.id), str(no_type.id)}


def _strings(value: object) -> list[str]:
    """Every key and string value anywhere in a JSON document."""
    if isinstance(value, dict):
        return [s for key, item in value.items() for s in (key, *_strings(item))]
    if isinstance(value, list):
        return [s for item in value for s in _strings(item)]
    return [value] if isinstance(value, str) else []


async def test_no_customer_id_or_original_key_in_pro_responses(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    request_id = await make_request(db_session, world)
    rows = [
        await add_media(db_session, world, request_id, kind, status, created_at=T0)
        for kind, status in [
            (RequestMediaKind.PHOTO, MediaSafeStatus.READY),
            (RequestMediaKind.VIDEO, MediaSafeStatus.READY),
            (RequestMediaKind.PHOTO, MediaSafeStatus.PENDING),
            (RequestMediaKind.VIDEO, MediaSafeStatus.FAILED),
        ]
    ]
    dispatch_id = await dispatch(db_session, request_id, world.me)

    detail = await open_detail(db_client, world, dispatch_id)
    listing = await db_client.get(BASE, headers=world.me.caller.headers)

    assert detail.status_code == listing.status_code == 200
    assert len(detail.json()["media"]) == 2  # the walk below covers signed media
    for response in (detail, listing):
        for text in _strings(response.json()):
            for secret in (str(world.customer_id), world.customer_id.hex, "u/", "request_media"):
                assert secret not in text, (secret, text)
            for row in rows:
                assert row.file_key not in text
                assert row.id.hex not in text  # the original's file name is the media id
    # The list shows no media at all (detail only, #173).
    assert all("media" not in item for item in listing.json()["items"])


async def test_detail_media_is_one_query(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, storage: FakeStorage
) -> None:
    statements: list[str] = []

    def count(*args: object) -> None:
        statement = args[2]
        assert isinstance(statement, str)
        statements.append(statement)

    async def statements_for(media_count: int) -> list[str]:
        request_id = await make_request(db_session, world)
        for n in range(media_count):
            await add_media(
                db_session,
                world,
                request_id,
                RequestMediaKind.PHOTO,
                MediaSafeStatus.READY if n % 2 == 0 else MediaSafeStatus.PENDING,
                created_at=T0 + timedelta(seconds=n),
            )
        dispatch_id = await dispatch(db_session, request_id, world.me)
        statements.clear()
        response = await open_detail(db_client, world, dispatch_id)
        assert response.status_code == 200
        assert len(response.json()["media"]) + response.json()["media_pending"] == media_count
        return list(statements)

    engine = (await db_session.connection()).sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        one = await statements_for(1)
        five = await statements_for(5)
    finally:
        event.remove(engine, "before_cursor_execute", count)

    assert len(one) == len(five)
    assert sum("FROM request_media" in s for s in five) == 1
