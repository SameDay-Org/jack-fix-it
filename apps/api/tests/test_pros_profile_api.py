"""The pro's own profile over HTTP: GET and PATCH /v1/pros/me (D6.1, #36)."""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import PresignedUpload, get_storage
from app.modules.auth import security
from app.modules.categories.models import Category
from app.modules.pros.models import ProCategory, ProProfile
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import TEST_JWT_SECRET, Committed, make_settings
from tests.test_auth_api import register

# Distinct from the defaults, so the tests prove the values come from settings.
MAX_CATEGORIES = 2
MAX_AREAS = 3
PHOTO_TTL = 120
BIO = "Licensed plumber, twelve years fixing leaks"
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
INVALID_MEDIA = {"error": {"code": "invalid_media", "message": "The attached media is invalid."}}
INVALID_CATEGORY = {
    "error": {"code": "invalid_category", "message": "The category is not available."}
}
INVALID_AREA = {
    "error": {"code": "invalid_service_area", "message": "The service area is not available."}
}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}


@dataclass
class FakeStorage:
    gets: list[tuple[str, int]] = field(default_factory=list)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - not used here
        raise AssertionError("the profile never uploads")

    def presign_get(self, key: str, expires_in: int) -> str:
        self.gets.append((key, expires_in))
        return f"https://storage.example.invalid/get/{key}?sig=fake"


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        pro_max_categories=MAX_CATEGORIES,
        pro_max_service_areas=MAX_AREAS,
        download_url_ttl_seconds=PHOTO_TTL,
    )


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@dataclass(frozen=True)
class Caller:
    id: uuid.UUID
    headers: dict[str, str]

    def photo_key(self, purpose: str = "profile_photo", extension: str = ".jpg") -> str:
        return f"u/{self.id}/{purpose}/{uuid.uuid4().hex}{extension}"


async def make_caller(session: AsyncSession, role: UserRole = UserRole.PRO) -> Caller:
    user = User(email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role)
    session.add(user)
    await session.flush()
    token = security.create_access_token(
        user_id=user.id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return Caller(id=user.id, headers={"Authorization": f"Bearer {token}"})


async def make_categories(
    session: AsyncSession, *slugs: str, active: bool = True
) -> list[Category]:
    # Fixture categories only.
    rows = [
        Category(slug=slug, names={"en": f"{slug} en", "es": f"{slug} es"}, active=active)
        for slug in slugs
    ]
    session.add_all(rows)
    await session.flush()
    return rows


async def make_areas(session: AsyncSession, *zips: str, active: bool = True) -> list[ServiceArea]:
    # Fixture areas only: no real region, city or ZIP.
    rows = [
        ServiceArea(region="Test Region", city="Testville", state="ZZ", zip_code=z, active=active)
        for z in zips
    ]
    session.add_all(rows)
    await session.flush()
    return rows


async def get_me(client: httpx.AsyncClient, caller: Caller) -> httpx.Response:
    return await client.get("/v1/pros/me", headers=caller.headers)


async def patch_me(client: httpx.AsyncClient, caller: Caller, **body: Any) -> httpx.Response:
    return await client.patch("/v1/pros/me", json=body, headers=caller.headers)


async def profile_count(session: AsyncSession, user_id: uuid.UUID) -> int:
    statement = select(func.count()).select_from(ProProfile).where(ProProfile.user_id == user_id)
    return (await session.scalar(statement)) or 0


# GET


async def test_get_creates_pending_profile_once(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)

    first = await get_me(db_client, pro)
    second = await get_me(db_client, pro)

    assert first.status_code == second.status_code == 200
    assert (
        first.json()
        == second.json()
        == {
            "bio": None,
            "years_of_experience": None,
            "photo": None,
            "verification_status": "pending",
            "payouts_enabled": False,
            "categories": [],
            "service_areas": [],
        }
    )
    assert await profile_count(db_session, pro.id) == 1


async def test_concurrent_first_calls_do_not_500(
    committed: Committed, storage: FakeStorage
) -> None:
    # Real connections and commits: both first calls race to create the profile.
    body = (await register(committed.client, email=committed.email, role="pro")).json()
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    user_id = uuid.UUID(body["user"]["id"])
    try:
        responses = await asyncio.gather(
            *(committed.client.get("/v1/pros/me", headers=headers) for _ in range(4))
        )

        assert [response.status_code for response in responses] == [200] * 4
        async with committed.sessions() as session:
            assert await profile_count(session, user_id) == 1
    finally:
        async with committed.sessions() as session:
            await session.execute(delete(ProProfile).where(ProProfile.user_id == user_id))
            await session.commit()


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.AGENT, UserRole.ADMIN])
async def test_customer_agent_admin_403(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, role: UserRole
) -> None:
    caller = await make_caller(db_session, role)

    responses = [await get_me(db_client, caller), await patch_me(db_client, caller, bio="x")]

    for response in responses:
        assert response.status_code == 403
        assert response.json() == FORBIDDEN
    assert await profile_count(db_session, caller.id) == 0


async def test_unauthenticated_is_401(db_client: httpx.AsyncClient, storage: FakeStorage) -> None:
    for response in (
        await db_client.get("/v1/pros/me"),
        await db_client.patch("/v1/pros/me", json={"bio": "x"}),
    ):
        assert response.status_code == 401


# PATCH


async def test_patch_updates_only_given_fields(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    [category] = await make_categories(db_session, "test-plumbing")
    [area] = await make_areas(db_session, "00001")
    full = await patch_me(
        db_client,
        pro,
        bio=f"  {BIO}  ",
        years_of_experience=12,
        category_ids=[str(category.id)],
        service_area_ids=[str(area.id)],
    )

    years_only = await patch_me(db_client, pro, years_of_experience=13)
    cleared = await patch_me(db_client, pro, bio="")

    assert full.status_code == 200
    assert full.json()["bio"] == BIO  # trimmed
    assert years_only.json() == {**full.json(), "years_of_experience": 13}
    assert cleared.json() == {**years_only.json(), "bio": None}
    assert (await patch_me(db_client, pro, bio=None, years_of_experience=None)).json() == {
        **cleared.json(),
        "years_of_experience": None,
    }


async def test_patch_creates_the_profile_if_missing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)

    response = await patch_me(db_client, pro, years_of_experience=3)

    assert response.status_code == 200
    assert response.json()["verification_status"] == "pending"
    assert await profile_count(db_session, pro.id) == 1


async def test_replace_semantics_for_sets(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    alpha, beta = await make_categories(db_session, "test-alpha", "test-beta")
    one, two, three = await make_areas(db_session, "00003", "00001", "00002")

    first = await patch_me(
        db_client,
        pro,
        category_ids=[str(beta.id), str(alpha.id)],
        service_area_ids=[str(one.id), str(two.id), str(three.id)],
    )
    replaced = await patch_me(
        db_client, pro, category_ids=[str(beta.id)], service_area_ids=[str(three.id)]
    )
    emptied = await patch_me(db_client, pro, category_ids=[], service_area_ids=[])

    assert [c["slug"] for c in first.json()["categories"]] == ["test-alpha", "test-beta"]
    assert [a["zip_code"] for a in first.json()["service_areas"]] == ["00001", "00002", "00003"]
    assert first.json()["categories"][0] == {
        "id": str(alpha.id),
        "slug": "test-alpha",
        "names": {"en": "test-alpha en", "es": "test-alpha es"},
    }
    assert first.json()["service_areas"][0] == {
        "id": str(two.id),
        "zip_code": "00001",
        "city": "Testville",
        "state": "ZZ",
        "region": "Test Region",
    }
    assert [c["id"] for c in replaced.json()["categories"]] == [str(beta.id)]
    assert [a["id"] for a in replaced.json()["service_areas"]] == [str(three.id)]
    assert emptied.json()["categories"] == emptied.json()["service_areas"] == []
    pairs = await db_session.scalar(select(func.count()).select_from(ProCategory))
    assert pairs == 0


async def test_patch_rejects_inactive_category_and_area(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    [active] = await make_categories(db_session, "test-on")
    [inactive] = await make_categories(db_session, "test-off", active=False)
    [area] = await make_areas(db_session, "00001")
    [off_area] = await make_areas(db_session, "00002", active=False)
    await patch_me(db_client, pro, category_ids=[str(active.id)], service_area_ids=[str(area.id)])

    responses = {
        "inactive_category": await patch_me(
            db_client, pro, bio=BIO, category_ids=[str(active.id), str(inactive.id)]
        ),
        "unknown_category": await patch_me(db_client, pro, category_ids=[str(uuid.uuid4())]),
        "inactive_area": await patch_me(db_client, pro, service_area_ids=[str(off_area.id)]),
        "unknown_area": await patch_me(db_client, pro, service_area_ids=[str(uuid.uuid4())]),
    }

    assert responses["inactive_category"].json() == INVALID_CATEGORY
    assert responses["unknown_category"].json() == INVALID_CATEGORY
    assert responses["inactive_area"].json() == INVALID_AREA
    assert responses["unknown_area"].json() == INVALID_AREA
    assert all(response.status_code == 422 for response in responses.values())
    # Validated before any write: the bio sent with the bad category did not land.
    after = (await get_me(db_client, pro)).json()
    assert after["bio"] is None
    assert [c["id"] for c in after["categories"]] == [str(active.id)]
    assert [a["id"] for a in after["service_areas"]] == [str(area.id)]


async def test_limits_from_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    categories = await make_categories(
        db_session, *(f"test-{n}" for n in range(MAX_CATEGORIES + 1))
    )
    areas = await make_areas(db_session, *(f"0000{n}" for n in range(MAX_AREAS + 1)))
    category_ids = [str(c.id) for c in categories]
    area_ids = [str(a.id) for a in areas]

    too_many_categories = await patch_me(db_client, pro, category_ids=category_ids)
    too_many_areas = await patch_me(db_client, pro, service_area_ids=area_ids)
    at_max = await patch_me(
        db_client,
        pro,
        category_ids=category_ids[:MAX_CATEGORIES],
        service_area_ids=area_ids[:MAX_AREAS],
    )

    assert too_many_categories.json() == too_many_areas.json() == VALIDATION_ERROR
    assert at_max.status_code == 200
    assert len(at_max.json()["categories"]) == MAX_CATEGORIES
    assert len(at_max.json()["service_areas"]) == MAX_AREAS


async def test_duplicate_ids_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    [category] = await make_categories(db_session, "test-dup")
    [area] = await make_areas(db_session, "00001")

    for body in (
        {"category_ids": [str(category.id)] * 2},
        {"service_area_ids": [str(area.id)] * 2},
    ):
        response = await patch_me(db_client, pro, **body)
        assert response.status_code == 422
        assert response.json() == VALIDATION_ERROR


@pytest.mark.parametrize(
    "body",
    [
        {"verification_status": "approved"},
        {"payouts_enabled": True},
        {"rating_avg": "5.00"},
        {"jobs_count": 99},
        {"stripe_account_id": "acct_test"},
        {"user_id": str(uuid.uuid4())},
        {"id": str(uuid.uuid4())},
    ],
    ids=lambda body: next(iter(body)),
)
async def test_patch_rejects_forbidden_fields(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    body: dict[str, Any],
) -> None:
    pro = await make_caller(db_session)

    response = await patch_me(db_client, pro, bio=BIO, **body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    after = (await get_me(db_client, pro)).json()
    assert (after["bio"], after["verification_status"], after["payouts_enabled"]) == (
        None,
        "pending",
        False,
    )


@pytest.mark.parametrize(
    "body",
    [
        {"bio": "x" * 1001},
        {"bio": "leak\x00here"},
        {"years_of_experience": -1},
        {"years_of_experience": 81},
        {"category_ids": None},
        {"service_area_ids": ["not-a-uuid"]},
    ],
    ids=["long_bio", "nul_bio", "negative_years", "too_many_years", "null_set", "bad_uuid"],
)
async def test_patch_validates_fields(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    body: dict[str, Any],
) -> None:
    pro = await make_caller(db_session)

    response = await patch_me(db_client, pro, **body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


async def test_bio_bounds_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)

    response = await patch_me(db_client, pro, bio="x" * 1000, years_of_experience=80)

    assert response.status_code == 200


# Photo


async def test_patch_rejects_other_users_photo_key(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)
    anas_key = ana.photo_key()

    rejected = {
        "other_user": await patch_me(db_client, bruno, photo_key=anas_key),
        "wrong_purpose": await patch_me(db_client, bruno, photo_key=bruno.photo_key("job_photo")),
        "document_type": await patch_me(
            db_client, bruno, photo_key=bruno.photo_key(extension=".pdf")
        ),
        "malformed": await patch_me(db_client, bruno, photo_key="../" + bruno.photo_key()),
        "overlong": await patch_me(db_client, bruno, photo_key=bruno.photo_key() + "0" * 600),
    }

    for name, response in rejected.items():
        assert response.status_code == 422, name
        assert response.json() == INVALID_MEDIA, name
    assert anas_key not in json.dumps([r.text for r in rejected.values()])
    assert (await get_me(db_client, bruno)).json()["photo"] is None


async def test_photo_presigned_url_in_response(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session)
    key = pro.photo_key(extension=".png")

    patched = await patch_me(db_client, pro, photo_key=key)
    read = await get_me(db_client, pro)
    cleared = await patch_me(db_client, pro, photo_key=None)

    for response in (patched, read):
        photo = response.json()["photo"]
        assert photo["url"] == f"https://storage.example.invalid/get/{key}?sig=fake"
        delta = datetime.fromisoformat(photo["expires_at"]) - datetime.now(UTC)
        assert timedelta(seconds=PHOTO_TTL - 5) < delta <= timedelta(seconds=PHOTO_TTL)
    assert storage.gets == [(key, PHOTO_TTL), (key, PHOTO_TTL)]
    assert cleared.json()["photo"] is None
    stored = await db_session.scalar(
        select(ProProfile.photo_key)
        .where(ProProfile.user_id == pro.id)
        .execution_options(populate_existing=True)
    )
    assert stored is None


async def test_each_pro_edits_only_their_own_profile(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)

    await patch_me(db_client, ana, bio=BIO)
    brunos = await patch_me(db_client, bruno, years_of_experience=2)

    assert brunos.json()["bio"] is None
    assert (await get_me(db_client, ana)).json()["years_of_experience"] is None
    assert (await get_me(db_client, ana)).json()["bio"] == BIO


async def test_no_pii_in_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    pro = await make_caller(db_session)
    key = pro.photo_key()

    with caplog.at_level(logging.DEBUG):
        await get_me(db_client, pro)
        await patch_me(db_client, pro, bio=BIO, photo_key=key)
        await patch_me(db_client, pro, photo_key="u/someone/else.jpg")

    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records)
    for secret in (BIO, key, "sig=fake", "someone"):
        assert secret not in output
    [created] = [r for r in caplog.records if r.message == "pro_profile_created"]
    [updated] = [r for r in caplog.records if r.message == "pro_profile_updated"]
    assert getattr(created, "user_id", None) == str(pro.id)
    assert getattr(updated, "fields", None) == ["bio", "photo_key"]


async def test_a_category_turned_off_stays_on_the_profile(
    db_session: AsyncSession, db_client: httpx.AsyncClient, storage: FakeStorage
) -> None:
    # Turning a category off later keeps it on the profiles that list it: what a pro must do
    # then (re-verification) is not defined yet. Only a new PATCH must use active ones.
    pro = await make_caller(db_session)
    [category] = await make_categories(db_session, "test-kept")
    await patch_me(db_client, pro, category_ids=[str(category.id)])
    await db_session.execute(
        update(Category).where(Category.id == category.id).values(active=False)
    )

    profile = (await get_me(db_client, pro)).json()

    assert [c["id"] for c in profile["categories"]] == [str(category.id)]
