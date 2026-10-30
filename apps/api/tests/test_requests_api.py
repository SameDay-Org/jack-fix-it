"""Service requests over HTTP: create, list and read (D8.1, #42)."""

import asyncio
import base64
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from redis.exceptions import RedisError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import PresignedUpload, get_storage
from app.modules.addresses.models import Address
from app.modules.auth import security
from app.modules.categories.intake import dump_questions
from app.modules.categories.models import Category
from app.modules.categories.service import load_seed_data
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.models import (
    PreferredPeriod,
    RequestMedia,
    RequestStatus,
    ServiceRequest,
)
from app.modules.service_areas.models import ServiceArea
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.service import owned_upload, upload_content_type
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from app.rate_limit import get_rate_limiter
from tests.conftest import TEST_JWT_SECRET, InMemoryRateLimiter, make_settings
from tests.helpers import letter_tag
from tests.test_intake_questions import FIXTURE_QUESTIONS, labels

GLOSSARY = Path(__file__).resolve().parents[3] / "docs" / "glossary.md"
# Distinct from the defaults, so the tests prove the values come from settings.
MEDIA_MAX = 3
INTAKE_MAX_BYTES = 200
CREATE_LIMIT = 3
LIST_DEFAULT = 1
LIST_MAX = 2
MEDIA_TTL = 120
ENQUEUE_TIMEOUT = 0.05
NOW = 1_000.0

DESCRIPTION = "Water leaks under the kitchen sink"
ADDRESS = {"line1": "742 Evergreen Terrace", "city": "Orlando", "state": "FL", "zip_code": "32801"}
INVALID_MEDIA = {"error": {"code": "invalid_media", "message": "The attached media is invalid."}}
INVALID_CATEGORY = {
    "error": {"code": "invalid_category", "message": "The category is not available."}
}
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
INVALID_INTAKE_ANSWERS = {
    "error": {
        "code": "invalid_intake_answers",
        "message": "The answers to the service questions are invalid.",
    }
}
# The required answers of FIXTURE_QUESTIONS.
REQUIRED_ANSWERS: dict[str, Any] = {"rooms": 2, "size": "small"}
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}


@dataclass
class FakeStorage:
    gets: list[tuple[str, int]] = field(default_factory=list)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - not used here
        raise AssertionError("requests never upload")

    def presign_get(self, key: str, expires_in: int) -> str:
        self.gets.append((key, expires_in))
        return f"https://storage.example.invalid/get/{key}?sig=fake"


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        request_media_max_items=MEDIA_MAX,
        request_intake_max_bytes=INTAKE_MAX_BYTES,
        request_create_limit=CREATE_LIMIT,
        request_list_default_limit=LIST_DEFAULT,
        request_list_max_limit=LIST_MAX,
        download_url_ttl_seconds=MEDIA_TTL,
        job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT,
    )


@dataclass
class RecordingQueue:
    """ARQ's enqueue_job, recorded: a known job id is not queued again. `failure` makes every
    call raise it; `hang` makes every call wait for ever (the caller's deadline must end it)."""

    jobs: dict[str, tuple[str, tuple[object, ...]]] = field(default_factory=dict)
    failure: Exception | None = None
    hang: bool = False
    before: list[str] = field(default_factory=list)  # what had happened at each enqueue

    async def enqueue_job(self, function: str, *args: object, _job_id: str | None = None) -> object:
        self.before.append(",".join(EVENTS))
        if self.failure is not None:
            raise self.failure
        if self.hang:
            await asyncio.Event().wait()
        assert _job_id is not None
        if _job_id in self.jobs:
            return None
        self.jobs[_job_id] = (function, args)
        return object()


# What the session did so far in a create: "commit" entries, read by RecordingQueue.
EVENTS: list[str] = []


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    EVENTS.clear()
    return recorder


@pytest.fixture
async def served(db_session: AsyncSession) -> None:
    """The fixture address's ZIP as an active service area (#46): only served ZIPs create."""
    db_session.add(
        ServiceArea(region="Test Region", city="Orlando", state="FL", zip_code=ADDRESS["zip_code"])
    )
    await db_session.flush()


@pytest.fixture
def storage(app: FastAPI, served: None) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    # A fixed clock, so no test straddles two rate-limit windows.
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return fake


@dataclass(frozen=True)
class Caller:
    id: uuid.UUID
    headers: dict[str, str]

    def media_key(self, extension: str = ".jpg", purpose: str = "request_media") -> str:
        return f"u/{self.id}/{purpose}/{uuid.uuid4().hex}{extension}"


async def make_caller(
    session: AsyncSession, role: UserRole = UserRole.CUSTOMER, locale: str = "en"
) -> Caller:
    user = User(
        email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com",
        password_hash="x",
        role=role,
        locale=locale,
    )
    session.add(user)
    await session.flush()
    token = security.create_access_token(
        user_id=user.id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return Caller(id=user.id, headers={"Authorization": f"Bearer {token}"})


async def make_category(
    session: AsyncSession,
    active: bool = True,
    questions: list[dict[str, Any]] | None = None,
) -> uuid.UUID:
    category = Category(
        slug=f"test-{letter_tag()}",
        names={"en": "Test", "es": "Prueba"},
        active=active,
        intake_questions=questions or [],
    )
    session.add(category)
    await session.flush()
    return category.id


def body(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {"description": DESCRIPTION, "address": dict(ADDRESS)}
    values.update(overrides)
    return values


async def create(client: httpx.AsyncClient, caller: Caller, **overrides: Any) -> httpx.Response:
    return await client.post("/v1/requests", json=body(**overrides), headers=caller.headers)


async def count_rows(
    session: AsyncSession, model: type[Any], user_column: Any, user_id: uuid.UUID
) -> int:
    statement = select(func.count()).select_from(model).where(user_column == user_id)
    return (await session.scalar(statement)) or 0


# Create


async def test_customer_creates_request_with_address_media_and_gets_public_code(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    category_id = await make_category(db_session, questions=FIXTURE_QUESTIONS)
    photo, video = ana.media_key(".jpg"), ana.media_key(".mp4")
    tomorrow = (datetime.now(UTC).date() + timedelta(days=1)).isoformat()

    response = await create(
        db_client,
        ana,
        category_id=str(category_id),
        address={**ADDRESS, "line2": "Apt 2", "zip_code": "32801-1234"},
        preferred_date=tomorrow,
        intake_answers={"rooms": 2, "size": "large", "pets": True},
        media_keys=[photo, video],
    )

    assert response.status_code == 201
    out = response.json()
    assert re.fullmatch(r"JF-[0-9]{6,}", out["public_code"])
    assert out["status"] == "received"
    assert out["customer_status"] == "customerStatus.requestReceived"
    assert out["category_id"] == str(category_id)
    assert out["description"] == DESCRIPTION
    assert out["address"] == {**ADDRESS, "line2": "Apt 2", "zip_code": "32801-1234"}
    assert out["preferred_date"] == tomorrow
    assert out["intake_answers"] == {"rooms": 2, "size": "large", "pets": True}
    # Media of one request share created_at, so their order is not the upload order.
    assert sorted(m["kind"] for m in out["media"]) == ["photo", "video"]
    # The address belongs to the caller.
    row = await db_session.get(ServiceRequest, uuid.UUID(out["id"]))
    assert row is not None
    address = await db_session.get(Address, row.address_id)
    assert address is not None
    assert address.user_id == ana.id
    assert set(out) == {
        "id",
        "public_code",
        "status",
        "customer_status",
        "category_id",
        "description",
        "address",
        "preferred_date",
        "preferred_period",
        "intake_answers",
        "media",
        "created_at",
    }


async def test_category_optional_and_inactive_category_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    inactive = await make_category(db_session, active=False)

    without = await create(db_client, ana)
    with_inactive = await create(db_client, ana, category_id=str(inactive))
    with_unknown = await create(db_client, ana, category_id=str(uuid.uuid4()))

    assert without.status_code == 201
    assert without.json()["category_id"] is None
    for response in (with_inactive, with_unknown):
        assert response.status_code == 422
        assert response.json() == INVALID_CATEGORY


async def test_status_received_origin_app_language_from_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    maria = await make_caller(db_session, locale="es")

    response = await create(db_client, maria, utm={"source": "instagram", "campaign": "launch"})

    row = await db_session.get(ServiceRequest, uuid.UUID(response.json()["id"]))
    assert row is not None
    assert row.status is RequestStatus.RECEIVED
    assert row.origin.value == "app"
    assert row.language == "es"
    assert row.urgency is None
    assert row.preferred_contact is None
    assert row.utm == {"source": "instagram", "campaign": "launch"}


@pytest.mark.parametrize("field_name", ["urgency", "preferred_contact", "status", "origin"])
async def test_urgency_and_preferred_contact_not_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, field_name: str
) -> None:
    # Rejected (422), not ignored: their values come with the request flow (#45), and fields
    # the server sets cannot be sent either.
    ana = await make_caller(db_session)

    response = await create(db_client, ana, **{field_name: "anything"})

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await count_rows(db_session, ServiceRequest, ServiceRequest.customer_id, ana.id) == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"description": "   "},
        {"description": "x" * 2001},
        {"address": {**ADDRESS, "state": "fl"}},
        {"address": {**ADDRESS, "state": "FLA"}},
        {"address": {**ADDRESS, "zip_code": "3280"}},
        {"address": {**ADDRESS, "zip_code": "32801-12"}},
        {"address": {**ADDRESS, "zip_code": "".join(chr(0xFF10 + int(d)) for d in "32801")}},
        {"address": {**ADDRESS, "line1": "  "}},
        {"address": {**ADDRESS, "city": ""}},
        {"address": {key: value for key, value in ADDRESS.items() if key != "line1"}},
        {"address": {**ADDRESS, "country": "US"}},
    ],
    ids=[
        "blank_description",
        "long_description",
        "lowercase_state",
        "three_letter_state",
        "short_zip",
        "bad_zip4",
        "fullwidth_zip",
        "blank_line1",
        "empty_city",
        "missing_line1",
        "unknown_address_field",
    ],
)
async def test_description_and_address_validation(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    overrides: dict[str, Any],
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, **overrides)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


async def test_description_is_trimmed_and_bounds_accepted(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)

    trimmed = await create(db_client, ana, description="  Fix it  ")
    longest = await create(db_client, ana, description="x" * 2000)

    assert trimmed.json()["description"] == "Fix it"
    assert longest.status_code == 201


async def test_preferred_date_in_past_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    today = datetime.now(UTC).date()

    past = await create(db_client, ana, preferred_date=(today - timedelta(days=1)).isoformat())
    same_day = await create(db_client, ana, preferred_date=today.isoformat())

    assert past.status_code == 422
    assert past.json() == VALIDATION_ERROR
    assert same_day.status_code == 201


# Preferred period (#237)


async def stored_period(session: AsyncSession, request_id: str) -> PreferredPeriod | None:
    statement = select(ServiceRequest.preferred_period).where(
        ServiceRequest.id == uuid.UUID(request_id)
    )
    return (await session.execute(statement)).scalar_one()


async def test_create_with_date_defaults_period_to_flexible(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    tomorrow = (datetime.now(UTC).date() + timedelta(days=1)).isoformat()

    absent = await create(db_client, ana, preferred_date=tomorrow)
    explicit_null = await create(db_client, ana, preferred_date=tomorrow, preferred_period=None)

    for response in (absent, explicit_null):
        assert response.status_code == 201
        out = response.json()
        assert out["preferred_date"] == tomorrow
        assert out["preferred_period"] == "flexible"
        assert await stored_period(db_session, out["id"]) is PreferredPeriod.FLEXIBLE


@pytest.mark.parametrize("period", list(PreferredPeriod))
async def test_create_with_date_and_period_stores_it(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    period: PreferredPeriod,
) -> None:
    ana = await make_caller(db_session)
    tomorrow = (datetime.now(UTC).date() + timedelta(days=1)).isoformat()

    response = await create(db_client, ana, preferred_date=tomorrow, preferred_period=period.value)

    assert response.status_code == 201
    request_id = response.json()["id"]
    assert response.json()["preferred_period"] == period.value
    assert await stored_period(db_session, request_id) is period
    # The customer's detail returns it too.
    detail = await db_client.get(f"/v1/requests/{request_id}", headers=ana.headers)
    assert detail.status_code == 200
    assert (detail.json()["preferred_date"], detail.json()["preferred_period"]) == (
        tomorrow,
        period.value,
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"preferred_period": "flexible"},
        {"preferred_date": None, "preferred_period": None},
        {"preferred_date": None, "preferred_period": "flexible"},
    ],
    ids=["absent", "flexible", "explicit-nulls", "null-date-flexible"],
)
async def test_create_without_date_period_absent_or_flexible_is_null(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    overrides: dict[str, str | None],
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, **overrides)

    assert response.status_code == 201
    out = response.json()
    assert (out["preferred_date"], out["preferred_period"]) == (None, None)
    assert await stored_period(db_session, out["id"]) is None
    detail = await db_client.get(f"/v1/requests/{out['id']}", headers=ana.headers)
    assert detail.json()["preferred_period"] is None


@pytest.mark.parametrize("period", ["morning", "afternoon", "evening"])
async def test_create_without_date_specific_period_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, period: str
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, preferred_period=period)
    explicit_null = await create(db_client, ana, preferred_date=None, preferred_period=period)

    # The same error a past date gets (InvalidRequestError).
    assert response.status_code == explicit_null.status_code == 422
    assert response.json() == explicit_null.json() == VALIDATION_ERROR
    assert await count_rows(db_session, ServiceRequest, ServiceRequest.customer_id, ana.id) == 0
    assert await count_rows(db_session, Address, Address.user_id, ana.id) == 0


@pytest.mark.parametrize("period", ["night", "Morning", "", 1, ["morning"]])
async def test_unknown_period_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, period: object
) -> None:
    ana = await make_caller(db_session)
    tomorrow = (datetime.now(UTC).date() + timedelta(days=1)).isoformat()

    response = await create(db_client, ana, preferred_date=tomorrow, preferred_period=period)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await count_rows(db_session, ServiceRequest, ServiceRequest.customer_id, ana.id) == 0


async def test_intake_answers_size_limit(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    notes = {"key": "notes", "type": "text", "required": False, "labels": labels("Notes"),
             "max_length": 1000}  # fmt: skip
    category_id = str(await make_category(db_session, questions=[notes]))

    too_big = await create(
        db_client, ana, category_id=category_id, intake_answers={"notes": "x" * INTAKE_MAX_BYTES}
    )
    fits = await create(db_client, ana, category_id=category_id, intake_answers={"notes": "x" * 50})
    not_an_object = await create(db_client, ana, category_id=category_id, intake_answers=["a", "b"])

    assert too_big.status_code == 422
    assert too_big.json() == VALIDATION_ERROR
    assert fits.status_code == 201
    assert not_an_object.status_code == 422


@pytest.mark.parametrize(
    "overrides",
    [
        {"description": "leak\x00here"},
        {"address": {**ADDRESS, "line1": "742\x00Evergreen"}},
        {"address": {**ADDRESS, "line2": "Apt\x002"}},
        {"address": {**ADDRESS, "city": "Or\x00lando"}},
        {"utm": {"source": "ig\x00"}},
        {"intake_answers": {"notes": "x\x00y"}},
        {"intake_answers": {"no\x00tes": "x"}},
        {"intake_answers": {"nested": [{"deep": "\x00"}]}},
        {"intake_answers": {"rooms": float("nan")}},
        {"intake_answers": {"rooms": float("inf")}},
        {"intake_answers": {"notes": "\ud800"}},
    ],
    ids=[
        "nul_description",
        "nul_line1",
        "nul_line2",
        "nul_city",
        "nul_utm",
        "nul_intake_value",
        "nul_intake_key",
        "nul_intake_nested",
        "nan_intake",
        "infinity_intake",
        "lone_surrogate_intake",
    ],
)
async def test_values_postgres_cannot_store_are_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    overrides: dict[str, Any],
) -> None:
    # Refused before any write, not a 500 from the database.
    ana = await make_caller(db_session)
    # Serialized here: httpx refuses NaN and lone surrogates, a raw client does not.
    raw = json.dumps(body(**overrides))

    response = await db_client.post(
        "/v1/requests",
        content=raw,
        headers={**ana.headers, "Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


# Media


async def test_media_key_of_other_user_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)
    anas_key = ana.media_key()

    response = await create(db_client, bruno, media_keys=[bruno.media_key(), anas_key])

    assert response.status_code == 422
    assert response.json() == INVALID_MEDIA
    assert anas_key not in response.text
    assert str(ana.id) not in response.text


@pytest.mark.parametrize(
    ("purpose", "extension"),
    [
        ("job_photo", ".jpg"),
        ("profile_photo", ".jpg"),
        ("pro_document", ".pdf"),
        # A request_media key with an extension that purpose never issues.
        ("request_media", ".pdf"),
    ],
)
async def test_media_key_wrong_purpose_rejected(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    purpose: str,
    extension: str,
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, media_keys=[ana.media_key(extension, purpose)])

    assert response.status_code == 422
    assert response.json() == INVALID_MEDIA


@pytest.mark.parametrize(
    "key_template",
    [
        "../u/{id}/request_media/{hex}.jpg",
        "u/{id}/request_media/{hex}.jpg/x",
        "u/{id}/request_media/{hex}" + "0" * 300 + ".jpg",
        "not a key",
        "",
    ],
)
async def test_malformed_media_key_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, key_template: str
) -> None:
    ana = await make_caller(db_session)
    key = key_template.format(id=ana.id, hex=uuid.uuid4().hex)

    response = await create(db_client, ana, media_keys=[key])

    assert response.status_code == 422
    assert response.json() == INVALID_MEDIA


async def test_too_many_media_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)

    too_many = await create(
        db_client, ana, media_keys=[ana.media_key() for _ in range(MEDIA_MAX + 1)]
    )
    at_max = await create(db_client, ana, media_keys=[ana.media_key() for _ in range(MEDIA_MAX)])

    assert too_many.status_code == 422
    assert too_many.json() == INVALID_MEDIA
    assert at_max.status_code == 201


async def test_duplicate_media_key_rejected(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    key = ana.media_key()

    response = await create(db_client, ana, media_keys=[key, key])

    assert response.status_code == 422
    assert response.json() == INVALID_MEDIA


@pytest.mark.parametrize(
    ("extension", "kind"),
    [
        (".jpg", "photo"),
        (".png", "photo"),
        (".webp", "photo"),
        (".heic", "photo"),
        (".mp4", "video"),
        (".mov", "video"),
    ],
)
async def test_media_kind_from_extension(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    extension: str,
    kind: str,
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, media_keys=[ana.media_key(extension)])

    assert response.status_code == 201
    assert [m["kind"] for m in response.json()["media"]] == [kind]


@pytest.mark.parametrize(
    "utm",
    [{"source": "ig", "referrer": "x"}, {"source": "x" * 101}, {"campaign": 5}],
    ids=["unknown_key", "too_long", "not_a_string"],
)
async def test_utm_keys_whitelisted(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    utm: dict[str, Any],
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, utm=utm)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


async def test_transaction_rolls_back_on_failure(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    key = ana.media_key()
    assert (await create(db_client, ana, media_keys=[key])).status_code == 201

    # The key passes every check, but it is already attached: the insert fails after the
    # address and the request were written, and all of it must roll back.
    reused = await create(db_client, ana, media_keys=[ana.media_key(), key])

    assert reused.status_code == 422
    assert reused.json() == INVALID_MEDIA
    assert await count_rows(db_session, ServiceRequest, ServiceRequest.customer_id, ana.id) == 1
    assert await count_rows(db_session, Address, Address.user_id, ana.id) == 1
    media = (await db_session.scalars(select(RequestMedia))).all()
    assert [m.file_key for m in media] == [key]


async def test_create_rate_limited_per_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)

    for _ in range(CREATE_LIMIT):
        assert (await create(db_client, ana)).status_code == 201
    limited = await create(db_client, ana)

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert int(limited.headers["Retry-After"]) >= 1
    assert (await create(db_client, bruno)).status_code == 201


# List and read


async def test_list_only_own_newest_first_with_cursor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)
    created = [
        (await create(db_client, ana, media_keys=media)).json()
        for media in ([], [ana.media_key()], [ana.media_key(), ana.media_key()])
    ]
    brunos = (await create(db_client, bruno)).json()
    # One test transaction gives every row the same now(): spread them out, oldest first.
    base = datetime(2026, 10, 1, tzinfo=UTC)
    for minutes, request in enumerate(created):
        await db_session.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == uuid.UUID(request["id"]))
            .values(created_at=base + timedelta(minutes=minutes))
        )

    storage.gets.clear()

    first = (await db_client.get("/v1/requests", headers=ana.headers)).json()
    second = (
        await db_client.get(
            "/v1/requests",
            params={"cursor": first["next_cursor"], "limit": LIST_MAX},
            headers=ana.headers,
        )
    ).json()
    capped = (await db_client.get("/v1/requests", params={"limit": 99}, headers=ana.headers)).json()
    brunos_list = (await db_client.get("/v1/requests", headers=bruno.headers)).json()

    newest_first = [request["id"] for request in reversed(created)]
    assert [item["id"] for item in first["items"]] == newest_first[:LIST_DEFAULT]
    assert [item["id"] for item in second["items"]] == newest_first[LIST_DEFAULT:]
    assert second["next_cursor"] is None
    assert [item["id"] for item in capped["items"]] == newest_first[:LIST_MAX]
    assert [item["media_count"] for item in second["items"]] == [1, 0]
    assert [item["media_count"] for item in first["items"]] == [2]
    assert set(first["items"][0]) == {
        "id",
        "public_code",
        "status",
        "customer_status",
        "category_id",
        "created_at",
        "media_count",
    }
    assert [item["id"] for item in brunos_list["items"]] == [brunos["id"]]
    assert storage.gets == []  # the list never presigns
    assert "sig=" not in json.dumps(first)


def encoded_cursor(raw: str) -> str:
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    "cursor",
    [
        "not-base64!",
        "Zm9v",
        "MjAyNnx4",
        encoded_cursor(f"2026-10-01T00:00:00|{uuid.UUID(int=1)}"),  # naive
        # Valid ISO timestamps that leave the database's range once in UTC.
        encoded_cursor(f"0001-01-01T00:00:00+05:00|{uuid.UUID(int=1)}"),
        encoded_cursor(f"9999-12-31T23:59:59-05:00|{uuid.UUID(int=1)}"),
    ],
    ids=["not_base64", "no_separator", "bad_parts", "naive", "before_min", "after_max"],
)
async def test_list_rejects_malformed_cursor(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, cursor: str
) -> None:
    ana = await make_caller(db_session)

    response = await db_client.get("/v1/requests", params={"cursor": cursor}, headers=ana.headers)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


async def test_detail_own_200_other_customer_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    bruno = await make_caller(db_session)
    request_id = (await create(db_client, ana)).json()["id"]

    own = await db_client.get(f"/v1/requests/{request_id}", headers=ana.headers)
    others = await db_client.get(f"/v1/requests/{request_id}", headers=bruno.headers)
    unknown = await db_client.get(f"/v1/requests/{uuid.uuid4()}", headers=bruno.headers)
    malformed = await db_client.get("/v1/requests/not-a-uuid", headers=ana.headers)

    assert own.status_code == 200
    assert own.json()["id"] == request_id
    for response in (others, unknown):
        assert response.status_code == 404
        assert response.json() == NOT_FOUND
    assert others.text == unknown.text
    assert malformed.status_code == 422


@pytest.mark.parametrize("role", [UserRole.PRO, UserRole.AGENT, UserRole.ADMIN])
async def test_pro_agent_admin_get_403(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, role: UserRole
) -> None:
    ana = await make_caller(db_session)
    request_id = (await create(db_client, ana)).json()["id"]
    caller = await make_caller(db_session, role)

    responses = [
        await create(db_client, caller),
        await db_client.get("/v1/requests", headers=caller.headers),
        await db_client.get(f"/v1/requests/{request_id}", headers=caller.headers),
    ]

    for response in responses:
        assert response.status_code == 403
        assert response.json() == FORBIDDEN


async def test_unauthenticated_is_401(db_client: httpx.AsyncClient, storage: FakeStorage) -> None:
    responses = [
        await db_client.post("/v1/requests", json=body()),
        await db_client.get("/v1/requests"),
        await db_client.get(f"/v1/requests/{uuid.uuid4()}"),
    ]

    for response in responses:
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_token"


async def test_detail_media_has_presigned_urls(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)
    photo, video = ana.media_key(".png"), ana.media_key(".mov")
    request_id = (await create(db_client, ana, media_keys=[photo, video])).json()["id"]
    storage.gets.clear()

    detail = (await db_client.get(f"/v1/requests/{request_id}", headers=ana.headers)).json()

    assert sorted(m["url"] for m in detail["media"]) == sorted(
        f"https://storage.example.invalid/get/{key}?sig=fake" for key in (photo, video)
    )
    assert sorted(storage.gets) == sorted([(photo, MEDIA_TTL), (video, MEDIA_TTL)])
    for media in detail["media"]:
        delta = datetime.fromisoformat(media["expires_at"]) - datetime.now(UTC)
        assert timedelta(seconds=MEDIA_TTL - 5) < delta <= timedelta(seconds=MEDIA_TTL)


async def test_no_pii_in_logs(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await make_caller(db_session)
    key = ana.media_key()

    with caplog.at_level(logging.DEBUG):
        created = (await create(db_client, ana, media_keys=[key])).json()
        await create(db_client, ana, media_keys=[key])  # rejected: key reused
        await create(db_client, ana, address={**ADDRESS, "state": "fl"})  # rejected
        await db_client.get("/v1/requests", headers=ana.headers)
        await db_client.get(f"/v1/requests/{created['id']}", headers=ana.headers)

    formatter = JsonFormatter()
    output = "\n".join(formatter.format(record) for record in caplog.records)
    for secret in (DESCRIPTION, ADDRESS["line1"], ADDRESS["zip_code"], key, "sig=fake"):
        assert secret not in output
    [record] = [r for r in caplog.records if r.message == "request_created"]
    payload = json.loads(formatter.format(record))
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
        "service_request_id",
        "user_id",
        "media_count",
    }
    assert payload["service_request_id"] == created["id"]
    assert payload.get("request_id") != created["id"]  # the HTTP correlation id is kept
    assert payload["media_count"] == 1


# Customer-visible status


def test_customer_status_mapping_is_total_and_uses_glossary_keys() -> None:
    text = GLOSSARY.read_text(encoding="utf-8")
    section = text.split("## Customer-visible statuses", 1)[1].split("\n## ", 1)[0]
    keys = set(re.findall(r"`(customerStatus\.\w+)`", section))
    expected = {
        "received": "customerStatus.requestReceived",
        "reviewing": "customerStatus.reviewing",
        "finding_pro": "customerStatus.findingAPro",
        "quote_ready": "customerStatus.quoteReady",
        "accepted": "customerStatus.quoteReady",
        "expired": "customerStatus.cancelled",
        "cancelled": "customerStatus.cancelled",
    }

    assert len(keys) == 11
    assert {status.value: REQUEST_CUSTOMER_STATUS[status] for status in RequestStatus} == expected
    assert set(REQUEST_CUSTOMER_STATUS.values()) <= keys


# Dispatch trigger (D9.1, #48)


async def test_create_request_enqueues_after_commit_and_enqueue_failure_does_not_fail_create(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await make_caller(db_session)
    commit = AsyncSession.commit

    async def recorded_commit(self: AsyncSession) -> None:
        await commit(self)
        EVENTS.append("commit")

    monkeypatch.setattr(AsyncSession, "commit", recorded_commit)

    # 1. Queued once, after the request's commit, under a job id of the request.
    created = await create(db_client, ana)
    assert created.status_code == 201
    request_id = created.json()["id"]
    assert queue.jobs == {f"dispatch:{request_id}": ("dispatch_request", (request_id,))}
    assert queue.before == ["commit"]

    # 2. Redis fails, or never answers: the request is still created, and the failure logged.
    for broken in (RecordingQueue(failure=RedisError("down")), RecordingQueue(hang=True)):
        queue.failure, queue.hang = broken.failure, broken.hang
        with caplog.at_level(logging.ERROR):
            response = await asyncio.wait_for(create(db_client, ana), timeout=5)
        assert response.status_code == 201
        [record] = [r for r in caplog.records if r.message == "dispatch_enqueue_failed"]
        assert record.__dict__["service_request_id"] == response.json()["id"]
        caplog.clear()


# Intake answers (D8.3, #44), against FIXTURE_QUESTIONS: one question of each type.


async def create_with_answers(
    client: httpx.AsyncClient, session: AsyncSession, answers: dict[str, Any]
) -> httpx.Response:
    caller = await make_caller(session)
    category_id = await make_category(session, questions=FIXTURE_QUESTIONS)
    return await create(client, caller, category_id=str(category_id), intake_answers=answers)


async def test_valid_answers_stored_normalized(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    answers = {
        "rooms": 6,
        "size": "large",
        "extras": ["windows", "oven"],
        "pets": False,
        "notes": "  ring the bell  ",
    }

    response = await create_with_answers(db_client, db_session, answers)
    required_only = await create_with_answers(db_client, db_session, REQUIRED_ANSWERS)

    assert response.status_code == 201
    stored = {**answers, "notes": "ring the bell"}
    assert response.json()["intake_answers"] == stored
    row = await db_session.get(ServiceRequest, uuid.UUID(response.json()["id"]))
    assert row is not None
    assert row.intake_answers == stored
    assert required_only.status_code == 201
    assert required_only.json()["intake_answers"] == REQUIRED_ANSWERS


async def assert_refused(
    client: httpx.AsyncClient, session: AsyncSession, answers: dict[str, Any]
) -> None:
    before = await session.scalar(select(func.count()).select_from(ServiceRequest))

    response = await create_with_answers(client, session, answers)

    assert response.status_code == 422
    assert response.json() == INVALID_INTAKE_ANSWERS
    # Refused before any write.
    assert await session.scalar(select(func.count()).select_from(ServiceRequest)) == before


@pytest.mark.parametrize("missing", ["rooms", "size"])
async def test_missing_required_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, missing: str
) -> None:
    answers = {k: v for k, v in REQUIRED_ANSWERS.items() if k != missing}
    await assert_refused(db_client, db_session, answers)


async def test_unknown_key_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    await assert_refused(db_client, db_session, {**REQUIRED_ANSWERS, "garage": True})


@pytest.mark.parametrize("value", [0, 7, True, 2.0, "2", None], ids=repr)
async def test_integer_out_of_range_or_bool_or_float_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, value: Any
) -> None:
    await assert_refused(db_client, db_session, {**REQUIRED_ANSWERS, "rooms": value})


@pytest.mark.parametrize("value", ["medium", "Small", ["small"], 1], ids=repr)
async def test_choice_not_in_options_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, value: Any
) -> None:
    await assert_refused(db_client, db_session, {**REQUIRED_ANSWERS, "size": value})


@pytest.mark.parametrize(
    "value",
    [["oven", "oven"], [], ["oven", "fridge", "windows"], ["dishwasher"], "oven", [1]],
    ids=["duplicate", "below_min", "above_max", "not_an_option", "not_a_list", "not_text"],
)
async def test_multi_choice_duplicates_or_count_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, value: Any
) -> None:
    await assert_refused(db_client, db_session, {**REQUIRED_ANSWERS, "extras": value})


@pytest.mark.parametrize("value", ["   ", "x" * 21, 5, ["x"]], ids=repr)
async def test_text_blank_or_too_long_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, value: Any
) -> None:
    await assert_refused(db_client, db_session, {**REQUIRED_ANSWERS, "notes": value})


async def test_boolean_must_be_a_boolean_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    await assert_refused(db_client, db_session, {**REQUIRED_ANSWERS, "pets": "yes"})


async def test_answers_without_category_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)

    response = await create(db_client, ana, intake_answers={"rooms": 2})
    empty = await create(db_client, ana, intake_answers={})

    assert response.status_code == 422
    assert response.json() == INVALID_INTAKE_ANSWERS
    assert empty.status_code == 201


async def test_broken_category_questions_422_invalid_category(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await make_caller(db_session)
    broken = await make_category(db_session, questions=[{"key": "rooms", "type": "number"}])

    with caplog.at_level(logging.INFO):
        response = await create(
            db_client, ana, category_id=str(broken), intake_answers={"rooms": 2}
        )
    without_category = await create(db_client, ana)

    assert response.status_code == 422
    assert response.json() == INVALID_CATEGORY
    assert await count_rows(db_session, ServiceRequest, ServiceRequest.customer_id, ana.id) == 1
    [record] = [r for r in caplog.records if r.message == "category_intake_invalid"]
    assert record.__dict__["category_id"] == str(broken)
    # The customer can still send it without a category: the BDC classifies it.
    assert without_category.status_code == 201


async def test_error_body_and_logs_never_echo_values(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    answers = {
        "rooms": "probe-value-rooms",
        "size": "small",
        "notes": "probe-value-notes-too-long",
        "probe_key_unknown": "probe-value-unknown",
    }

    with caplog.at_level(logging.DEBUG):
        response = await create_with_answers(db_client, db_session, answers)

    assert response.status_code == 422
    assert response.json() == INVALID_INTAKE_ANSWERS
    [record] = [r for r in caplog.records if r.message == "intake_answers_invalid"]
    assert record.__dict__["failed"] == ["rooms", "notes"]
    assert record.__dict__["unknown"] == 1
    output = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert "probe" not in output
    assert "probe" not in response.text


def test_openapi_documents_invalid_intake_answers(app: FastAPI) -> None:
    operation = app.openapi()["paths"]["/v1/requests"]["post"]

    assert "invalid_intake_answers" in operation["responses"]["422"]["description"]


async def test_request_with_jobs_answer_validates(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # The seeded painting question (D8.3): required multi_choice, at least one job.
    [painting] = [entry for entry in load_seed_data() if entry.slug == "painting"]
    category_id = str(
        await make_category(db_session, questions=dump_questions(painting.intake_questions))
    )

    async def answer(jobs: Any) -> httpx.Response:
        answers = {} if jobs is None else {"jobs": jobs}
        caller = await make_caller(db_session)  # one each: request creation is rate limited
        return await create(db_client, caller, category_id=category_id, intake_answers=answers)

    valid = await answer(["interior", "ceilings"])
    assert valid.status_code == 201
    assert valid.json()["intake_answers"] == {"jobs": ["interior", "ceilings"]}
    for refused in ([], ["roofing"], ["interior", "interior"], "interior", None):
        response = await answer(refused)
        assert response.status_code == 422, refused
        assert response.json() == INVALID_INTAKE_ANSWERS


# Served ZIPs only (#46)

ZIP_NOT_SERVED = {
    "error": {"code": "zip_not_served", "message": "This ZIP code is not served yet."}
}


@pytest.mark.parametrize("zip_code", ["00009", "00008"], ids=["unknown", "inactive"])
async def test_unserved_zip_is_422_and_writes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, zip_code: str
) -> None:
    # A fixture area turned off: served only while active.
    db_session.add(
        ServiceArea(
            region="Test Region", city="Testville", state="ZZ", zip_code="00008", active=False
        )
    )
    await db_session.flush()
    ana = await make_caller(db_session)

    response = await create(db_client, ana, address={**ADDRESS, "zip_code": zip_code})

    assert response.status_code == 422
    assert response.json() == ZIP_NOT_SERVED
    assert await count_rows(db_session, ServiceRequest, ServiceRequest.customer_id, ana.id) == 0
    assert await count_rows(db_session, Address, Address.user_id, ana.id) == 0


async def test_served_zip_plus_4_is_created(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await make_caller(db_session)

    response = await create(
        db_client, ana, address={**ADDRESS, "zip_code": f"{ADDRESS['zip_code']}-4321"}
    )

    assert response.status_code == 201
    assert response.json()["address"]["zip_code"] == f"{ADDRESS['zip_code']}-4321"


# Privacy-safe media copies (#173): queued after the commit, after dispatch.


async def test_request_create_enqueues_sanitize_after_commit(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ana = await make_caller(db_session)
    commit = AsyncSession.commit

    async def recorded_commit(self: AsyncSession) -> None:
        await commit(self)
        EVENTS.append("commit")

    monkeypatch.setattr(AsyncSession, "commit", recorded_commit)

    created = await create(db_client, ana, media_keys=[ana.media_key(), ana.media_key(".mp4")])

    assert created.status_code == 201
    request_id = created.json()["id"]
    assert list(queue.jobs.items()) == [
        (f"dispatch:{request_id}", ("dispatch_request", (request_id,))),
        (f"sanitize:{request_id}", ("sanitize_request_media", (request_id,))),
    ]
    assert queue.before == ["commit", "commit"]  # both after the commit, dispatch first


async def test_a_request_without_media_queues_no_sanitize(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
) -> None:
    created = await create(db_client, await make_caller(db_session))

    assert created.status_code == 201
    assert [job_id.split(":")[0] for job_id in queue.jobs] == ["dispatch"]


async def test_enqueue_failure_does_not_fail_request(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    queue: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await make_caller(db_session)
    queue.failure = RedisError("down")

    with caplog.at_level(logging.ERROR):
        response = await create(db_client, ana, media_keys=[ana.media_key()])

    assert response.status_code == 201
    request_id = response.json()["id"]
    [record] = [r for r in caplog.records if r.message == "sanitize_enqueue_failed"]
    assert record.__dict__["service_request_id"] == request_id
    media = (await db_session.scalars(select(RequestMedia))).all()
    assert [m.safe_status.value for m in media if str(m.request_id) == request_id] == ["pending"]


async def test_owned_upload_rejects_safe_keys(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # A customer cannot attach a safe copy (or guess one) to a new request.
    ana = await make_caller(db_session)
    safe_key = "m/" + uuid.uuid4().hex + ".jpg"

    response = await create(db_client, ana, media_keys=[safe_key])

    assert response.status_code == 422
    assert response.json() == INVALID_MEDIA
    assert owned_upload(safe_key, ana.id, UploadPurpose.REQUEST_MEDIA) is None
    assert upload_content_type(safe_key) is None
