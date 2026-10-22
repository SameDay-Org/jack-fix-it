"""A pro's verification documents over HTTP: POST and GET /v1/pros/me/documents (#37)."""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.categories.models import Category
from app.modules.pros.models import ProDocument, ProDocumentStatus
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import make_settings
from tests.test_pros_profile_api import Caller, FakeStorage, make_caller, make_categories, patch_me

URL_TTL = 90  # not the default (300), so the tests prove it comes from the setting
INVALID_MEDIA = {"error": {"code": "invalid_media", "message": "The attached media is invalid."}}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}


@pytest.fixture
def settings() -> Settings:
    return make_settings(download_url_ttl_seconds=URL_TTL)


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


def doc_key(caller: Caller, purpose: str = "pro_document", extension: str = ".pdf") -> str:
    return f"u/{caller.id}/{purpose}/{uuid.uuid4().hex}{extension}"


async def submit(
    client: httpx.AsyncClient, caller: Caller, doc_type: str, key: str | None = None, **extra: Any
) -> httpx.Response:
    body = {"doc_type": doc_type, "file_key": key or doc_key(caller), **extra}
    return await client.post("/v1/pros/me/documents", json=body, headers=caller.headers)


async def listing(client: httpx.AsyncClient, caller: Caller) -> dict[str, Any]:
    response = await client.get("/v1/pros/me/documents", headers=caller.headers)
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


async def test_upload_id_and_insurance_then_missing_types_empty(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    before = await listing(db_client, pro)

    id_doc = await submit(db_client, pro, "id", expires_on="2030-01-31")
    insurance = await submit(db_client, pro, "insurance")
    after = await listing(db_client, pro)

    assert before == {
        "documents": [],
        "history": [],
        "required_types": ["id", "insurance"],
        "missing_types": ["id", "insurance"],
    }
    assert id_doc.status_code == insurance.status_code == 201
    body = id_doc.json()
    assert (body["doc_type"], body["status"], body["expires_on"]) == ("id", "pending", "2030-01-31")
    assert body["rejection_reason"] is None
    assert after["missing_types"] == []
    assert {d["doc_type"] for d in after["documents"]} == {"id", "insurance"}


async def test_license_required_only_when_a_category_requires_it(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    plain, licensed = await make_categories(db_session, "test-plain", "test-licensed")
    await db_session.execute(
        update(Category).where(Category.id == licensed.id).values(requires_license=True)
    )
    await patch_me(db_client, pro, category_ids=[str(plain.id)])
    without = await listing(db_client, pro)

    await patch_me(db_client, pro, category_ids=[str(plain.id), str(licensed.id)])
    with_license = await listing(db_client, pro)
    await submit(db_client, pro, "license")
    after_license = await listing(db_client, pro)

    assert without["required_types"] == ["id", "insurance"]
    assert with_license["required_types"] == ["id", "license", "insurance"]
    assert with_license["missing_types"] == ["id", "license", "insurance"]
    assert after_license["missing_types"] == ["id", "insurance"]


async def test_resubmission_supersedes_pending_same_type(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    first = (await submit(db_client, pro, "id")).json()
    other_type = (await submit(db_client, pro, "insurance")).json()

    second = (await submit(db_client, pro, "id")).json()

    rows = {row.id: row for row in await documents_of(db_session)}
    assert rows[uuid.UUID(first["id"])].status is ProDocumentStatus.SUPERSEDED
    assert rows[uuid.UUID(second["id"])].status is ProDocumentStatus.PENDING
    assert rows[uuid.UUID(other_type["id"])].status is ProDocumentStatus.PENDING
    listed = await listing(db_client, pro)
    assert {d["id"] for d in listed["documents"]} == {second["id"], other_type["id"]}
    assert listed["history"] == []


async def test_approved_history_kept(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    approved = (await submit(db_client, pro, "insurance")).json()
    rejected = (await submit(db_client, pro, "id")).json()
    # The admin review (#41) is not built yet: set the outcomes directly. One test transaction
    # gives every row the same now(), so the older documents get earlier dates.
    for doc_id, status, reason, day in (
        (approved["id"], "approved", None, 1),
        (rejected["id"], "rejected", "Blurry photo", 2),
    ):
        await db_session.execute(
            update(ProDocument)
            .where(ProDocument.id == uuid.UUID(doc_id))
            .values(
                status=status,
                rejection_reason=reason,
                created_at=datetime(2026, 1, day, tzinfo=UTC),
            )
        )

    renewed = (await submit(db_client, pro, "insurance")).json()
    listed = await listing(db_client, pro)

    statuses = {row.id: row.status for row in await documents_of(db_session)}
    assert statuses[uuid.UUID(approved["id"])] is ProDocumentStatus.APPROVED
    latest = {d["doc_type"]: d for d in listed["documents"]}
    assert latest["insurance"]["id"] == renewed["id"]
    assert latest["id"]["status"] == "rejected"
    assert latest["id"]["rejection_reason"] == "Blurry photo"
    assert [d["id"] for d in listed["history"]] == [approved["id"]]
    # A rejected ID does not cover its type; the pending insurance does.
    assert listed["missing_types"] == ["id"]


@pytest.mark.parametrize(
    "key_for",
    [
        lambda me, other: doc_key(other),
        lambda me, other: doc_key(me, "profile_photo", ".jpg"),
        lambda me, other: doc_key(me, "pro_document", ".mp4"),
        lambda me, other: "../" + doc_key(me),
        lambda me, other: doc_key(me) + "0" * 300,
    ],
    ids=["other_user", "wrong_purpose", "video", "malformed", "overlong"],
)
async def test_other_users_key_or_wrong_purpose_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    key_for: Any,
) -> None:
    me = await make_caller(db_session)
    other = await make_caller(db_session)
    key = key_for(me, other)

    response = await submit(db_client, me, "id", key)

    assert response.status_code == 422
    assert response.json() == INVALID_MEDIA
    assert key not in response.text


async def test_reused_key_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    key = doc_key(pro)
    assert (await submit(db_client, pro, "id", key)).status_code == 201

    again = await submit(db_client, pro, "insurance", key)

    assert again.status_code == 422
    assert again.json() == INVALID_MEDIA
    # The failed submission superseded nothing: the ID is still pending.
    [row] = await documents_of(db_session)
    assert row.status is ProDocumentStatus.PENDING


async def test_past_expiry_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    today = datetime.now(UTC).date()

    past = await submit(
        db_client, pro, "insurance", expires_on=(today - timedelta(days=1)).isoformat()
    )
    same_day = await submit(db_client, pro, "insurance", expires_on=today.isoformat())

    assert past.status_code == 422
    assert past.json() == VALIDATION_ERROR
    assert same_day.status_code == 201


@pytest.mark.parametrize(
    "extra",
    [
        {"status": "approved"},
        {"rejection_reason": "n/a"},
        {"reviewed_by": str(uuid.uuid4())},
        {"reviewed_at": "2026-10-22T00:00:00Z"},
        {"pro_id": str(uuid.uuid4())},
    ],
    ids=lambda extra: next(iter(extra)),
)
async def test_forbidden_fields_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    extra: dict[str, str],
) -> None:
    pro = await make_caller(db_session)

    response = await submit(db_client, pro, "id", **extra)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await documents_of(db_session) == []


async def test_unknown_type_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)

    response = await submit(db_client, pro, "passport")

    assert response.status_code == 422


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.AGENT, UserRole.ADMIN])
async def test_customer_agent_admin_403(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, role: UserRole
) -> None:
    caller = await make_caller(db_session, role)

    for response in (
        await submit(db_client, caller, "id"),
        await db_client.get("/v1/pros/me/documents", headers=caller.headers),
    ):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"


async def test_each_pro_sees_only_their_documents(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)
    await submit(db_client, ana, "id")

    assert (await listing(db_client, bruno))["documents"] == []


async def test_presigned_urls_use_settings_ttl(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    key = doc_key(pro, extension=".png")

    submitted = (await submit(db_client, pro, "id", key)).json()
    [listed] = (await listing(db_client, pro))["documents"]

    for body in (submitted, listed):
        assert body["url"] == f"https://storage.example.invalid/get/{key}?sig=fake"
        delta = datetime.fromisoformat(body["expires_at"]) - datetime.now(UTC)
        assert timedelta(seconds=URL_TTL - 5) < delta <= timedelta(seconds=URL_TTL)
    assert storage.gets == [(key, URL_TTL), (key, URL_TTL)]


async def test_no_pii_in_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pro = await make_caller(db_session)
    key = doc_key(pro)

    with caplog.at_level(logging.DEBUG):
        await submit(db_client, pro, "id", key, expires_on="2031-05-17")
        await listing(db_client, pro)

    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for secret in (key, "sig=fake", "2031-05-17"):
        assert secret not in output
    [record] = [r for r in caplog.records if r.message == "pro_document_submitted"]
    payload = json.loads(JsonFormatter().format(record))
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
        "user_id",
        "document_id",
        "doc_type",
        "superseded",
    }


async def documents_of(session: AsyncSession) -> list[ProDocument]:
    from sqlalchemy import select

    statement = select(ProDocument).execution_options(populate_existing=True)
    return list((await session.scalars(statement)).all())
