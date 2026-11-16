"""Staff review of pros (D7.4, #41): GET /v1/admin/pros, GET /v1/admin/pros/{id},
POST .../documents/{id}/review and POST .../decision."""

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.addresses.models import Address
from app.modules.audit.repository import AuditRepository
from app.modules.audit.service import AuditService
from app.modules.audit.types import ActorNotStaffError
from app.modules.categories.models import Category
from app.modules.pros.models import (
    ProCategory,
    ProDocument,
    ProDocumentStatus,
    ProDocumentType,
    ProProfile,
    ProServiceArea,
    ProVerificationStatus,
)
from app.modules.pros.service import ProService
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.audit_helpers import AuditRow, audit_rows
from tests.conftest import make_settings
from tests.job_world import JobWorld, Party, Pro, build_world, headers_for
from tests.test_pros_profile_api import FakeStorage, make_areas, make_categories

STAFF = "/v1/admin/pros"
URL_TTL = 90  # not the default (300), so the tests prove it comes from the setting
PAGE = 2  # the list's default page size here, from the setting
FIRST, LAST = "Lucía", "Reviewlast"
EMAIL: Final = "probe-pro-41@example.com"
PHONE: Final = "+13055550141"
STREET: Final = "41 Probe Street"
BIO: Final = "probe-bio-41"
REASON: Final = "The photo is blurry zqxj-reason-41."
# A reason in which staff pasted contacts (#406 Vault B1): the pro reads it masked, as the chat
# masks them (app.redaction).
LEAKY_REASON: Final = (
    "Blurry ID. Email reviewer41@example.invalid, call +1 305 555 0146 or visit"
    " https://docs41.example.invalid/id"
)
MASKED_REASON: Final = "Blurry ID. Email •••, call ••• or visit •••"
REASON_CONTACTS: Final = ("reviewer41@example", "555 0146", "5550146", "docs41.example")
CONTACT_LEAKS = (LAST, EMAIL, PHONE, STREET)
TODAY = datetime.now(UTC).date()

FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
PRO_NOT_FOUND = {"error": {"code": "pro_not_found", "message": "Pro not found."}}
DOCUMENT_NOT_FOUND = {"error": {"code": "document_not_found", "message": "Document not found."}}
NOT_PENDING = {
    "error": {
        "code": "document_not_pending",
        "message": "Only a pending document can be reviewed.",
    }
}
ITEM_KEYS = {
    "id",
    "name",
    "verification_status",
    "payouts_enabled",
    "categories",
    "zip_count",
    "documents",
    "submitted_at",
    "created_at",
}
APPROVE = {"decision": "approved"}
REJECT = {"decision": "rejected", "reason": REASON}


@pytest.fixture
def settings() -> Settings:
    return make_settings(download_url_ttl_seconds=URL_TTL, request_list_default_limit=PAGE)


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@pytest.fixture
async def world(db_session: AsyncSession, storage: FakeStorage) -> JobWorld:
    return await build_world(db_session)  # its two pros are approved


async def make_pro(
    session: AsyncSession,
    *,
    status: ProVerificationStatus = ProVerificationStatus.PENDING,
    payouts_enabled: bool = False,
    age: timedelta = timedelta(0),
    **user_fields: Any,
) -> Pro:
    """A pro with a profile in `status`, created `age` ago by the database clock."""
    user = User(email=f"pro-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
    for name, value in user_fields.items():
        setattr(user, name, value)
    session.add(user)
    await session.flush()
    now = (await session.execute(select(func.now()))).scalar_one()
    profile = ProProfile(
        user_id=user.id,
        verification_status=status,
        payouts_enabled=payouts_enabled,
        created_at=now - age,
    )
    session.add(profile)
    await session.flush()
    return Pro(user.id, headers_for(user.id, UserRole.PRO), profile.id)


async def add_document(
    session: AsyncSession,
    pro: Pro,
    doc_type: ProDocumentType,
    status: ProDocumentStatus = ProDocumentStatus.PENDING,
    *,
    expires_on: date | None = None,
    age: timedelta = timedelta(0),
) -> ProDocument:
    now = (await session.execute(select(func.now()))).scalar_one()
    document = ProDocument(
        pro_id=pro.profile_id,
        doc_type=doc_type,
        file_key=f"u/{pro.id}/pro_document/{uuid.uuid4().hex}.pdf",
        status=status,
        expires_on=expires_on,
        created_at=now - age,
    )
    session.add(document)
    await session.flush()
    return document


async def serve(session: AsyncSession, pro: Pro, *, zips: int = 1) -> tuple[uuid.UUID, uuid.UUID]:
    """Gives the pro one category and `zips` areas; returns (category id, first area id)."""
    [category] = await make_categories(session, f"test-{uuid.uuid4().hex[:8]}")
    areas = await make_areas(session, *(uuid.uuid4().hex[:5] for _ in range(zips)))
    session.add(ProCategory(pro_id=pro.profile_id, category_id=category.id))
    session.add_all(ProServiceArea(pro_id=pro.profile_id, service_area_id=a.id) for a in areas)
    await session.flush()
    return category.id, areas[0].id


async def ready_pro(session: AsyncSession, **fields: Any) -> tuple[Pro, uuid.UUID, uuid.UUID]:
    """A pending pro an approval accepts: ID and insurance approved, a category, an area."""
    pro = await make_pro(session, **fields)
    category_id, area_id = await serve(session, pro)
    await add_document(session, pro, ProDocumentType.ID, ProDocumentStatus.APPROVED)
    await add_document(session, pro, ProDocumentType.INSURANCE, ProDocumentStatus.APPROVED)
    return pro, category_id, area_id


async def profile_of(session: AsyncSession, pro: Pro) -> ProProfile:
    statement = (
        select(ProProfile)
        .where(ProProfile.id == pro.profile_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


async def document_of(session: AsyncSession, document_id: uuid.UUID) -> ProDocument:
    statement = (
        select(ProDocument)
        .where(ProDocument.id == document_id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one()


def review_url(pro: Pro, document: ProDocument) -> str:
    return f"{STAFF}/{pro.profile_id}/documents/{document.id}/review"


def decision_url(pro: Pro) -> str:
    return f"{STAFF}/{pro.profile_id}/decision"


def ids(response: httpx.Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


# --- Who may call ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", STAFF),
        ("GET", f"{STAFF}/{uuid.uuid4()}"),
        ("POST", f"{STAFF}/{uuid.uuid4()}/documents/{uuid.uuid4()}/review"),
        ("POST", f"{STAFF}/{uuid.uuid4()}/decision"),
    ],
)
async def test_no_token_is_401(db_client: httpx.AsyncClient, method: str, path: str) -> None:
    response = await db_client.request(method, path, json=APPROVE)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("who", ["customer", "pro", "the_pro_reviewed"])
async def test_the_apps_users_are_refused_even_the_pro_reviewed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, who: str
) -> None:
    pro, _, _ = await ready_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.LICENSE)
    caller: Party = pro if who == "the_pro_reviewed" else getattr(world, who)

    responses = [
        await db_client.get(STAFF, headers=caller.headers),
        await db_client.get(f"{STAFF}/{pro.profile_id}", headers=caller.headers),
        await db_client.post(review_url(pro, document), json=APPROVE, headers=caller.headers),
        await db_client.post(decision_url(pro), json=APPROVE, headers=caller.headers),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(403, FORBIDDEN)] * 4
    assert all(r.headers["cache-control"] == "no-store" for r in responses)
    assert (await document_of(db_session, document.id)).status is ProDocumentStatus.PENDING
    assert (await profile_of(db_session, pro)).verification_status is ProVerificationStatus.PENDING
    assert await audit_rows(db_session) == []


@pytest.mark.parametrize("staff", ["agent", "admin"])
async def test_agents_and_admins_review_and_decide(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, staff: str
) -> None:
    headers = getattr(world, staff).headers
    pro, _, _ = await ready_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.LICENSE)

    responses = [
        await db_client.get(STAFF, headers=headers),
        await db_client.get(f"{STAFF}/{pro.profile_id}", headers=headers),
        await db_client.post(review_url(pro, document), json=APPROVE, headers=headers),
        await db_client.post(decision_url(pro), json=APPROVE, headers=headers),
    ]

    assert [r.status_code for r in responses] == [200] * 4, [r.text for r in responses]
    assert all(r.headers["cache-control"] == "no-store" for r in responses)


# --- The list --------------------------------------------------------------------------------


async def test_the_list_shows_pending_pros_newest_first_with_counts_and_no_contact(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    older = await make_pro(db_session, age=timedelta(hours=2))
    newer = await make_pro(
        db_session, first_name=FIRST, last_name=LAST, email=EMAIL, phone=PHONE, payouts_enabled=True
    )
    db_session.add(
        Address(user_id=newer.id, line1=STREET, city="Orlando", state="FL", zip_code="32801")
    )
    await db_session.execute(
        update(ProProfile).where(ProProfile.id == newer.profile_id).values(bio=BIO)
    )
    category_id, _ = await serve(db_session, newer, zips=3)
    oldest = await add_document(db_session, newer, ProDocumentType.ID, age=timedelta(hours=5))
    await add_document(db_session, newer, ProDocumentType.INSURANCE, age=timedelta(hours=1))
    await add_document(db_session, newer, ProDocumentType.LICENSE, ProDocumentStatus.APPROVED)
    await add_document(
        db_session, newer, ProDocumentType.ID, ProDocumentStatus.REJECTED, age=timedelta(days=2)
    )
    await add_document(
        db_session, newer, ProDocumentType.ID, ProDocumentStatus.SUPERSEDED, age=timedelta(days=9)
    )

    response = await db_client.get(STAFF, headers=world.agent.headers)

    assert ids(response) == [str(newer.profile_id), str(older.profile_id)]
    body = response.json()
    first, second = body["items"]
    assert set(first) == ITEM_KEYS
    assert (first["name"], first["verification_status"], first["payouts_enabled"]) == (
        f"{FIRST} R.",
        "pending",
        True,
    )
    assert [c["id"] for c in first["categories"]] == [str(category_id)]
    assert first["zip_count"] == 3
    assert first["documents"] == {"pending": 2, "approved": 1, "rejected": 1}
    assert datetime.fromisoformat(first["submitted_at"]) == oldest.created_at
    assert (second["name"], second["categories"], second["zip_count"]) == (None, [], 0)
    assert second["documents"] == {"pending": 0, "approved": 0, "rejected": 0}
    assert second["submitted_at"] is None
    # The world's two approved pros are counted, not listed.
    assert body["counts"] == {"pending": 2, "approved": 2, "rejected": 0}
    assert body["next_cursor"] is None
    for leak in (*CONTACT_LEAKS, BIO):
        assert leak not in response.text


async def test_the_list_filters_by_status(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pending = await make_pro(db_session)
    rejected = await make_pro(db_session, status=ProVerificationStatus.REJECTED)
    staff = world.admin.headers

    default = await db_client.get(STAFF, headers=staff)
    by_status = {
        status: await db_client.get(STAFF, params={"status": status}, headers=staff)
        for status in ("pending", "approved", "rejected")
    }
    unknown = await db_client.get(STAFF, params={"status": "superseded"}, headers=staff)

    assert ids(default) == ids(by_status["pending"]) == [str(pending.profile_id)]
    assert ids(by_status["rejected"]) == [str(rejected.profile_id)]
    assert set(ids(by_status["approved"])) == {
        str(world.pro.profile_id),
        str(world.other_pro.profile_id),
    }
    assert {r.json()["counts"]["rejected"] for r in by_status.values()} == {1}
    assert (unknown.status_code, unknown.json()) == (422, VALIDATION_ERROR)


async def test_the_list_pages_with_a_cursor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pros = [await make_pro(db_session, age=timedelta(minutes=n)) for n in range(5)]
    expected = [str(pro.profile_id) for pro in pros]  # newest first
    staff = world.agent.headers

    first = await db_client.get(STAFF, headers=staff)  # the setting's page size
    second = await db_client.get(
        STAFF, params={"cursor": first.json()["next_cursor"], "limit": 2}, headers=staff
    )
    third = await db_client.get(
        STAFF, params={"cursor": second.json()["next_cursor"], "limit": 2}, headers=staff
    )
    capped = await db_client.get(STAFF, params={"limit": 10_000}, headers=staff)

    assert (ids(first), ids(second), ids(third)) == (expected[:2], expected[2:4], expected[4:])
    assert third.json()["next_cursor"] is None
    assert ids(capped) == expected
    for bad in ("not-a-cursor", "x" * 201):
        refused = await db_client.get(STAFF, params={"cursor": bad}, headers=staff)
        assert (refused.status_code, refused.json()) == (422, VALIDATION_ERROR)
    refused = await db_client.get(STAFF, params={"limit": 0}, headers=staff)
    assert (refused.status_code, refused.json()) == (422, VALIDATION_ERROR)


# --- The detail ------------------------------------------------------------------------------


async def test_the_detail_shows_the_profile_and_documents_and_audits_the_read(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, storage: FakeStorage
) -> None:
    pro = await make_pro(db_session, first_name=FIRST, last_name=LAST, email=EMAIL, phone=PHONE)
    await db_session.execute(
        update(ProProfile)
        .where(ProProfile.id == pro.profile_id)
        .values(bio=BIO, years_of_experience=9, photo_key=f"u/{pro.id}/profile_photo/p.jpg")
    )
    category_id, area_id = await serve(db_session, pro)
    await db_session.execute(
        update(Category).where(Category.id == category_id).values(requires_license=True)
    )
    old_id = await add_document(
        db_session, pro, ProDocumentType.ID, ProDocumentStatus.REJECTED, age=timedelta(days=1)
    )
    new_id = await add_document(db_session, pro, ProDocumentType.ID, expires_on=TODAY)
    await add_document(
        db_session, pro, ProDocumentType.ID, ProDocumentStatus.SUPERSEDED, age=timedelta(days=3)
    )
    storage.gets.clear()

    response = await db_client.get(f"{STAFF}/{pro.profile_id}", headers=world.agent.headers)

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["id"], body["user_id"]) == (str(pro.profile_id), str(pro.id))
    assert (body["name"], body["bio"], body["years_of_experience"]) == (f"{FIRST} R.", BIO, 9)
    assert body["legal_name"] == f"{FIRST} {LAST}"
    assert (body["verification_status"], body["rejection_reason"], body["reviewed_at"]) == (
        "pending",
        None,
        None,
    )
    assert body["photo"]["url"].startswith("https://storage.example.invalid/get/u/")
    assert [c["id"] for c in body["categories"]] == [str(category_id)]
    assert [a["id"] for a in body["service_areas"]] == [str(area_id)]
    assert [(d["id"], d["status"], d["expires_on"]) for d in body["documents"]] == [
        (str(new_id.id), "pending", TODAY.isoformat())
    ]
    assert [(d["id"], d["status"]) for d in body["history"]] == [(str(old_id.id), "rejected")]
    assert body["documents"][0]["url"].endswith(f"{new_id.file_key}?sig=fake")
    assert body["required_types"] == ["id", "license", "insurance"]
    assert body["missing_types"] == ["license", "insurance"]
    assert body["approval_blockers"] == [
        {"kind": "document_missing", "doc_type": "id"},
        {"kind": "document_missing", "doc_type": "license"},
        {"kind": "document_missing", "doc_type": "insurance"},
    ]
    # Every URL is short-lived by the setting, and no superseded file gets one.
    assert {ttl for _, ttl in storage.gets} == {URL_TTL}
    assert len(storage.gets) == 3
    for leak in (EMAIL, PHONE):
        assert leak not in response.text
    assert await audit_rows(db_session) == [
        AuditRow(
            actor_user_id=world.agent.id,
            action="pro_profile.read_for_review",
            entity_type="pro_profile",
            entity_id=pro.profile_id,
            before={},
            after={"documents": 2, "document_ids": f"{new_id.id},{old_id.id}"},
            reason=None,
        )
    ]


async def test_a_detail_without_documents_is_audited_too(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await make_pro(db_session)

    response = await db_client.get(f"{STAFF}/{pro.profile_id}", headers=world.admin.headers)

    assert response.status_code == 200
    body = response.json()
    assert (body["documents"], body["history"], body["photo"]) == ([], [], None)
    assert (body["name"], body["legal_name"]) == (None, None)
    assert body["approval_blockers"] == [
        {"kind": "document_missing", "doc_type": "id"},
        {"kind": "document_missing", "doc_type": "insurance"},
        {"kind": "no_category", "doc_type": None},
        {"kind": "no_service_area", "doc_type": None},
    ]
    assert await audit_rows(db_session) == [
        AuditRow(
            actor_user_id=world.admin.id,
            action="pro_profile.read_for_review",
            entity_type="pro_profile",
            entity_id=pro.profile_id,
            before={},
            after={"documents": 0, "document_ids": ""},
            reason=None,
        )
    ]


async def expired_insurance_pro(session: AsyncSession) -> Pro:
    """A pro with a category, an area, an approved ID and an approved insurance that expired
    yesterday (Foreman decision on #41: it no longer covers its type)."""
    pro = await make_pro(session)
    await serve(session, pro)
    await add_document(session, pro, ProDocumentType.ID, ProDocumentStatus.APPROVED)
    await add_document(
        session,
        pro,
        ProDocumentType.INSURANCE,
        ProDocumentStatus.APPROVED,
        expires_on=TODAY - timedelta(days=1),
        age=timedelta(days=400),
    )
    return pro


async def test_the_detail_counts_an_expired_approved_document_as_missing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await expired_insurance_pro(db_session)

    response = await db_client.get(f"{STAFF}/{pro.profile_id}", headers=world.agent.headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["missing_types"] == ["insurance"]
    assert body["approval_blockers"] == [{"kind": "document_expired", "doc_type": "insurance"}]


async def test_the_detail_counts_a_type_covered_again_by_a_valid_replacement(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await expired_insurance_pro(db_session)
    # Approved and valid through today (an expiry date of today has not passed yet).
    await add_document(
        db_session, pro, ProDocumentType.INSURANCE, ProDocumentStatus.APPROVED, expires_on=TODAY
    )

    response = await db_client.get(f"{STAFF}/{pro.profile_id}", headers=world.agent.headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["missing_types"] == []
    assert body["approval_blockers"] == []


@pytest.mark.parametrize("who", ["customer", "pro", "the_pro_reviewed"])
async def test_only_the_staff_detail_carries_the_legal_name(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, who: str
) -> None:
    pro = await make_pro(db_session, first_name=FIRST, last_name=LAST, email=EMAIL, phone=PHONE)
    first_only = await make_pro(db_session, first_name="Solo")
    caller: Party = pro if who == "the_pro_reviewed" else getattr(world, who)
    staff = world.agent.headers
    one = f"{STAFF}/{pro.profile_id}"

    listed = [
        await db_client.get(STAFF, params={"status": status}, headers=staff)
        for status in ("pending", "approved", "rejected")
    ]
    detail = await db_client.get(one, headers=staff)
    partial = await db_client.get(f"{STAFF}/{first_only.profile_id}", headers=staff)
    refused = [
        await db_client.get(STAFF, headers=caller.headers),
        await db_client.get(one, headers=caller.headers),
    ]

    # The list: first name and last initial, in every tab; never the last name.
    assert [r.status_code for r in listed] == [200] * 3
    assert f"{FIRST} R." in listed[0].text
    assert all(LAST not in r.text and "legal_name" not in r.text for r in listed)
    # The detail: the name as on the account, to match the ID document. No email or phone.
    assert (detail.status_code, detail.json()["legal_name"]) == (200, f"{FIRST} {LAST}")
    assert (detail.json()["name"], partial.json()["legal_name"]) == (f"{FIRST} R.", "Solo")
    assert EMAIL not in detail.text
    assert PHONE not in detail.text
    # The app's users get neither, not even the pro's own.
    assert [(r.status_code, r.json()) for r in refused] == [(403, FORBIDDEN)] * 2
    assert all(LAST not in r.text for r in refused)
    # Each staff detail read is audited; a refused one writes nothing.
    assert [(row.actor_user_id, row.action) for row in await audit_rows(db_session)] == [
        (world.agent.id, "pro_profile.read_for_review")
    ] * 2


async def test_nothing_is_shown_when_the_read_cannot_be_audited(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pro = await make_pro(db_session, first_name=FIRST, last_name=LAST)
    document = await add_document(db_session, pro, ProDocumentType.ID)
    bare = await make_pro(db_session, first_name=FIRST, last_name=LAST)  # no document

    async def fail(self: AuditRepository, **fields: Any) -> None:
        raise RuntimeError("probe failure")

    monkeypatch.setattr(AuditRepository, "add", fail)

    for profile_id in (pro.profile_id, bare.profile_id):
        response = await db_client.get(f"{STAFF}/{profile_id}", headers=world.agent.headers)

        assert response.status_code == 500
        assert response.headers["cache-control"] == "no-store"
        assert document.file_key not in response.text
        assert "storage.example.invalid" not in response.text
        assert LAST not in response.text


async def test_an_unknown_pro_is_404_and_a_bad_id_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    staff = world.agent.headers
    # A user id is not a profile id.
    for unknown in (uuid.uuid4(), world.pro.id):
        read = await db_client.get(f"{STAFF}/{unknown}", headers=staff)
        decided = await db_client.post(f"{STAFF}/{unknown}/decision", json=REJECT, headers=staff)
        assert (read.status_code, read.json()) == (404, PRO_NOT_FOUND)
        assert (decided.status_code, decided.json()) == (404, PRO_NOT_FOUND)
    bad = await db_client.get(f"{STAFF}/not-a-uuid", headers=staff)
    assert (bad.status_code, bad.json()) == (422, VALIDATION_ERROR)
    assert await audit_rows(db_session) == []


# --- Reviewing a document --------------------------------------------------------------------


@pytest.mark.parametrize("body", [APPROVE, REJECT])
async def test_a_review_is_stored_and_audited_and_its_replay_changes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, body: dict[str, str]
) -> None:
    pro = await make_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.ID, expires_on=TODAY)
    decision, reason = body["decision"], body.get("reason")

    first = await db_client.post(review_url(pro, document), json=body, headers=world.agent.headers)
    replay = await db_client.post(
        review_url(pro, document),
        json=body if reason is None else {**body, "reason": "Another reason."},
        headers=world.admin.headers,
    )

    assert first.status_code == 200, first.text
    assert first.json() == replay.json()
    answer = first.json()
    assert set(answer) == {
        "id",
        "doc_type",
        "status",
        "rejection_reason",
        "expires_on",
        "created_at",
        "reviewed_at",
    }
    assert (answer["id"], answer["status"], answer["rejection_reason"]) == (
        str(document.id),
        decision,
        reason,
    )
    stored = await document_of(db_session, document.id)
    assert (stored.status.value, stored.rejection_reason) == (decision, reason)
    assert stored.reviewed_by == world.agent.id  # the first review's, not the replay's
    assert stored.reviewed_at is not None
    assert datetime.fromisoformat(answer["reviewed_at"]) == stored.reviewed_at
    assert await audit_rows(db_session) == [
        AuditRow(
            actor_user_id=world.agent.id,
            action="pro_document.review",
            entity_type="pro_document",
            entity_id=document.id,
            before={"status": "pending"},
            after={"status": decision, "pro_id": str(pro.profile_id), "doc_type": "id"},
            reason=reason,
        )
    ]


async def test_the_pro_reads_why_a_document_was_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await make_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.INSURANCE)

    await db_client.post(review_url(pro, document), json=REJECT, headers=world.agent.headers)
    mine = await db_client.get("/v1/pros/me/documents", headers=pro.headers)

    [listed] = mine.json()["documents"]
    assert (listed["status"], listed["rejection_reason"]) == ("rejected", REASON)
    assert mine.json()["missing_types"] == ["id", "insurance"]


async def test_a_document_rejection_reaches_the_pro_with_its_contacts_masked(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await make_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.ID)

    answer = await db_client.post(
        review_url(pro, document),
        json={"decision": "rejected", "reason": LEAKY_REASON},
        headers=world.agent.headers,
    )
    mine = await db_client.get("/v1/pros/me/documents", headers=pro.headers)

    assert answer.status_code == 200, answer.text
    assert answer.json()["rejection_reason"] == MASKED_REASON
    [listed] = mine.json()["documents"]
    assert listed["rejection_reason"] == MASKED_REASON
    assert (await document_of(db_session, document.id)).rejection_reason == MASKED_REASON
    [row] = await audit_rows(db_session)
    assert row.reason == MASKED_REASON  # no original kept, not even in the audit
    for text in (answer.text, mine.text):
        assert not any(contact in text for contact in REASON_CONTACTS)


async def test_a_profile_rejection_reaches_the_pro_with_its_contacts_masked(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await make_pro(db_session)
    body = {"decision": "rejected", "reason": LEAKY_REASON}

    first = await db_client.post(decision_url(pro), json=body, headers=world.agent.headers)
    replay = await db_client.post(decision_url(pro), json=body, headers=world.admin.headers)
    mine = await db_client.get("/v1/pros/me", headers=pro.headers)

    assert first.status_code == 200, first.text
    assert first.json() == replay.json()
    assert first.json()["rejection_reason"] == MASKED_REASON
    assert mine.json()["rejection_reason"] == MASKED_REASON
    assert (await profile_of(db_session, pro)).rejection_reason == MASKED_REASON
    # The replay of the same text compares masked with masked: a no-op, no second row.
    [row] = await audit_rows(db_session)
    assert (row.actor_user_id, row.reason) == (world.agent.id, MASKED_REASON)
    for text in (first.text, mine.text):
        assert not any(contact in text for contact in REASON_CONTACTS)


@pytest.mark.parametrize(
    "status",
    [ProDocumentStatus.APPROVED, ProDocumentStatus.REJECTED, ProDocumentStatus.SUPERSEDED],
)
async def test_only_a_pending_document_is_reviewed(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    status: ProDocumentStatus,
) -> None:
    pro = await make_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.ID, status)
    other = REJECT if status is ProDocumentStatus.APPROVED else APPROVE

    response = await db_client.post(
        review_url(pro, document), json=other, headers=world.agent.headers
    )

    assert (response.status_code, response.json()) == (409, NOT_PENDING)
    stored = await document_of(db_session, document.id)
    assert (stored.status, stored.rejection_reason, stored.reviewed_by) == (status, None, None)
    assert await audit_rows(db_session) == []


@pytest.mark.parametrize(
    "body",
    [
        {"decision": "rejected"},
        {"decision": "rejected", "reason": None},
        {"decision": "rejected", "reason": ""},
        {"decision": "rejected", "reason": "   "},
        {"decision": "rejected", "reason": "x" * 501},
        {"decision": "rejected", "reason": "nul\x00byte"},
        {"decision": "rejected", "reason": "​​"},  # nothing left once masked
        {"decision": "approved", "reason": REASON},
        {"decision": "pending"},
        {"decision": "superseded"},
        {"reason": REASON},
        {"decision": "approved", "status": "approved"},
        {},
    ],
)
async def test_an_invalid_review_or_decision_is_422_and_changes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld, body: dict[str, Any]
) -> None:
    pro, _, _ = await ready_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.LICENSE)
    staff = world.admin.headers

    review = await db_client.post(review_url(pro, document), json=body, headers=staff)
    decision = await db_client.post(decision_url(pro), json=body, headers=staff)

    assert (review.status_code, review.json()) == (422, VALIDATION_ERROR)
    assert (decision.status_code, decision.json()) == (422, VALIDATION_ERROR)
    assert (await document_of(db_session, document.id)).status is ProDocumentStatus.PENDING
    assert (await profile_of(db_session, pro)).verification_status is ProVerificationStatus.PENDING
    assert await audit_rows(db_session) == []


async def test_the_longest_reason_is_accepted_trimmed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro = await make_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.ID)

    response = await db_client.post(
        review_url(pro, document),
        json={"decision": "rejected", "reason": f"  {'x' * 500}\n"},
        headers=world.agent.headers,
    )

    assert response.status_code == 200
    assert (await document_of(db_session, document.id)).rejection_reason == "x" * 500


async def test_a_document_is_reviewed_only_under_its_own_pro(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro, other = await make_pro(db_session), await make_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.ID)
    staff = world.agent.headers

    responses = [
        await db_client.post(review_url(other, document), json=APPROVE, headers=staff),
        await db_client.post(
            f"{STAFF}/{pro.profile_id}/documents/{uuid.uuid4()}/review", json=APPROVE, headers=staff
        ),
        await db_client.post(
            f"{STAFF}/{uuid.uuid4()}/documents/{document.id}/review", json=APPROVE, headers=staff
        ),
    ]

    assert [(r.status_code, r.json()) for r in responses] == [(404, DOCUMENT_NOT_FOUND)] * 3
    assert (await document_of(db_session, document.id)).status is ProDocumentStatus.PENDING
    assert await audit_rows(db_session) == []


# --- Deciding on the profile -----------------------------------------------------------------


async def test_an_approved_pro_becomes_a_dispatch_candidate_once_payouts_are_enabled(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro, category_id, area_id = await ready_pro(db_session, payouts_enabled=True)
    unpaid, _, unpaid_area = await ready_pro(db_session)
    waiting = await make_pro(db_session, payouts_enabled=True)
    db_session.add(ProCategory(pro_id=waiting.profile_id, category_id=category_id))
    db_session.add(ProServiceArea(pro_id=waiting.profile_id, service_area_id=area_id))
    db_session.add(ProCategory(pro_id=unpaid.profile_id, category_id=category_id))
    await db_session.flush()
    areas = [area_id, unpaid_area]

    async def candidates() -> set[uuid.UUID]:
        found = await ProService(db_session).dispatch_candidates(category_id, areas)
        return {candidate.pro_id for candidate in found}

    before = await candidates()
    approved = await db_client.post(decision_url(pro), json=APPROVE, headers=world.agent.headers)
    also = await db_client.post(decision_url(unpaid), json=APPROVE, headers=world.agent.headers)

    assert before == set()
    assert (approved.status_code, also.status_code) == (200, 200)
    answer = approved.json()
    assert set(answer) == {"id", "verification_status", "rejection_reason", "reviewed_at"}
    assert (answer["id"], answer["verification_status"], answer["rejection_reason"]) == (
        str(pro.profile_id),
        "approved",
        None,
    )
    # Approved with payouts enabled: neither the pro still pending nor the one without payouts.
    assert await candidates() == {pro.profile_id}
    stored = await profile_of(db_session, pro)
    assert (stored.verification_status, stored.reviewed_by) == (
        ProVerificationStatus.APPROVED,
        world.agent.id,
    )
    assert stored.reviewed_at is not None
    # Rows of one test share the transaction's clock: found by entity, not by position.
    [row] = [r for r in await audit_rows(db_session) if r.entity_id == pro.profile_id]
    assert row == AuditRow(
        actor_user_id=world.agent.id,
        action="pro_profile.set_verification",
        entity_type="pro_profile",
        entity_id=pro.profile_id,
        before={"verification_status": "pending"},
        after={"verification_status": "approved"},
        reason=None,
    )


@pytest.mark.parametrize(
    ("gap", "listed"),
    [
        ("no_id", "id document missing"),
        ("id_only_pending", "id document missing"),
        ("id_only_rejected", "id document missing"),
        ("insurance_expired", "insurance document expired"),
        ("license_missing", "license document missing"),
        ("no_category", "no category"),
        ("no_area", "no service area"),
        (
            "nothing",
            "id document missing, insurance document missing, no category, no service area",
        ),
    ],
)
async def test_an_approval_is_refused_with_what_is_missing(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    gap: str,
    listed: str,
) -> None:
    pro = await make_pro(db_session)
    if gap not in ("no_category", "nothing"):
        category = (await make_categories(db_session, f"test-{uuid.uuid4().hex[:8]}"))[0]
        category.requires_license = gap == "license_missing"
        db_session.add(ProCategory(pro_id=pro.profile_id, category_id=category.id))
    if gap not in ("no_area", "nothing"):
        [area] = await make_areas(db_session, uuid.uuid4().hex[:5])
        db_session.add(ProServiceArea(pro_id=pro.profile_id, service_area_id=area.id))
    id_status = {
        "id_only_pending": ProDocumentStatus.PENDING,
        "id_only_rejected": ProDocumentStatus.REJECTED,
    }.get(gap, ProDocumentStatus.APPROVED)
    if gap not in ("no_id", "nothing"):
        await add_document(db_session, pro, ProDocumentType.ID, id_status)
    if gap != "nothing":
        await add_document(
            db_session,
            pro,
            ProDocumentType.INSURANCE,
            ProDocumentStatus.APPROVED,
            expires_on=TODAY - timedelta(days=1) if gap == "insurance_expired" else TODAY,
        )
    await db_session.flush()

    response = await db_client.post(decision_url(pro), json=APPROVE, headers=world.admin.headers)

    assert response.status_code == 422, response.text
    assert response.json() == {
        "error": {
            "code": "pro_not_approvable",
            "message": f"The pro cannot be approved yet: {listed}.",
        }
    }
    stored = await profile_of(db_session, pro)
    assert (stored.verification_status, stored.reviewed_by, stored.reviewed_at) == (
        ProVerificationStatus.PENDING,
        None,
        None,
    )
    assert await audit_rows(db_session) == []


async def test_an_expired_document_does_not_block_while_another_approved_one_is_valid(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro, _, _ = await ready_pro(db_session)
    await add_document(
        db_session,
        pro,
        ProDocumentType.ID,
        ProDocumentStatus.APPROVED,
        expires_on=TODAY - timedelta(days=400),
        age=timedelta(days=500),
    )
    # A newer submission the team rejected does not undo the approved one either.
    await add_document(db_session, pro, ProDocumentType.INSURANCE, ProDocumentStatus.REJECTED)

    response = await db_client.post(decision_url(pro), json=APPROVE, headers=world.admin.headers)

    assert response.status_code == 200, response.text


async def test_a_rejection_is_shown_to_the_pro_and_an_approval_later_clears_it(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro, _, _ = await ready_pro(db_session)
    staff = world.agent.headers

    rejected = await db_client.post(decision_url(pro), json=REJECT, headers=staff)
    replay = await db_client.post(decision_url(pro), json=REJECT, headers=world.admin.headers)
    seen = await db_client.get("/v1/pros/me", headers=pro.headers)
    reworded = await db_client.post(
        decision_url(pro), json={**REJECT, "reason": "Reworded."}, headers=world.admin.headers
    )
    approved = await db_client.post(decision_url(pro), json=APPROVE, headers=staff)
    again = await db_client.post(decision_url(pro), json=APPROVE, headers=world.admin.headers)
    after = await db_client.get("/v1/pros/me", headers=pro.headers)

    assert rejected.status_code == 200, rejected.text
    assert rejected.json() == replay.json()
    assert (rejected.json()["verification_status"], rejected.json()["rejection_reason"]) == (
        "rejected",
        REASON,
    )
    assert (seen.json()["verification_status"], seen.json()["rejection_reason"]) == (
        "rejected",
        REASON,
    )
    assert reworded.json()["rejection_reason"] == "Reworded."
    assert approved.json() == again.json()
    assert (after.json()["verification_status"], after.json()["rejection_reason"]) == (
        "approved",
        None,
    )
    assert (await profile_of(db_session, pro)).reviewed_by == world.agent.id
    # One row per change; the two replays wrote none. The rows share the transaction's clock,
    # so they are compared whatever their order.
    written = [
        (row.actor_user_id, row.before, row.after, row.reason)
        for row in await audit_rows(db_session)
    ]
    expected = [
        (
            world.agent.id,
            {"verification_status": "pending"},
            {"verification_status": "rejected"},
            REASON,
        ),
        (
            world.admin.id,
            {"verification_status": "rejected"},
            {"verification_status": "rejected"},
            "Reworded.",
        ),
        (
            world.agent.id,
            {"verification_status": "rejected"},
            {"verification_status": "approved"},
            None,
        ),
    ]
    assert len(written) == len(expected)
    assert all(change in written for change in expected)


async def test_an_approved_pro_who_is_rejected_stops_being_a_candidate(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: JobWorld
) -> None:
    pro, category_id, area_id = await ready_pro(
        db_session, status=ProVerificationStatus.APPROVED, payouts_enabled=True
    )

    response = await db_client.post(decision_url(pro), json=REJECT, headers=world.admin.headers)

    assert response.status_code == 200
    assert await ProService(db_session).dispatch_candidates(category_id, [area_id]) == []


@pytest.mark.parametrize("failure", ["audit_write_fails", "audit_refuses_the_actor"])
async def test_a_change_that_cannot_be_audited_does_not_happen(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    pro, _, _ = await ready_pro(db_session)
    document = await add_document(db_session, pro, ProDocumentType.LICENSE)
    document_id = document.id  # read now: a rollback expires the fixture
    urls = (review_url(pro, document), decision_url(pro))
    await db_session.commit()  # the service's rollback must not take the fixtures with it

    if failure == "audit_write_fails":

        async def fail(self: AuditRepository, **fields: Any) -> None:
            raise RuntimeError("probe failure")

        monkeypatch.setattr(AuditRepository, "add", fail)
    else:
        # The refusal itself (who counts as active staff) is proven in test_audit_log.py; here,
        # what the routes do with one: the change is rolled back and the answer is 403.

        async def refuse(self: AuditService, *args: Any, **kwargs: Any) -> None:
            raise ActorNotStaffError

        monkeypatch.setattr(AuditService, "record_staff_action", refuse)

    responses = []
    for url in urls:
        responses.append(await db_client.post(url, json=REJECT, headers=world.agent.headers))
        # What the request's own session does when it closes without a commit.
        await db_session.rollback()

    expected = 500 if failure == "audit_write_fails" else 403
    assert [r.status_code for r in responses] == [expected] * 2
    stored = await document_of(db_session, document_id)
    assert (stored.status, stored.rejection_reason, stored.reviewed_by) == (
        ProDocumentStatus.PENDING,
        None,
        None,
    )
    profile = await profile_of(db_session, pro)
    assert (profile.verification_status, profile.rejection_reason, profile.reviewed_by) == (
        ProVerificationStatus.PENDING,
        None,
        None,
    )
    assert await audit_rows(db_session) == []


# --- Logs ------------------------------------------------------------------------------------


async def test_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: JobWorld,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pro, _, _ = await ready_pro(
        db_session, first_name=FIRST, last_name=LAST, email=EMAIL, phone=PHONE
    )
    await db_session.execute(
        update(ProProfile).where(ProProfile.id == pro.profile_id).values(bio=BIO)
    )
    document = await add_document(db_session, pro, ProDocumentType.LICENSE)
    unready = await make_pro(db_session)
    staff = world.agent.headers

    with caplog.at_level(logging.DEBUG):
        await db_client.get(STAFF, headers=staff)
        await db_client.get(f"{STAFF}/{pro.profile_id}", headers=staff)
        await db_client.post(review_url(pro, document), json=REJECT, headers=staff)
        await db_client.post(decision_url(unready), json=APPROVE, headers=staff)
        await db_client.post(decision_url(pro), json=REJECT, headers=staff)

    events = {record.getMessage(): record.__dict__ for record in caplog.records}
    assert events["pro_read_by_staff"]["documents"] == 3
    assert events["pro_document_reviewed"]["to_status"] == "rejected"
    assert events["pro_approval_refused"]["blockers"] == 4
    decided = events["pro_verification_decided"]
    assert (
        decided["pro_id"],
        decided["staff_id"],
        decided["from_status"],
        decided["to_status"],
    ) == (
        str(pro.profile_id),
        str(world.agent.id),
        "pending",
        "rejected",
    )
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    logs = "\n".join(JsonFormatter().format(r) + r.getMessage() for r in caplog.records)
    for leak in (*CONTACT_LEAKS, FIRST, BIO, "zqxj-reason-41", document.file_key, "sig=fake"):
        assert leak not in logs
