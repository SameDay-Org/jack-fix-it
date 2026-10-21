"""Presigned upload and download URLs over HTTP (D6.2 API part, #35)."""

import json
import logging
import re
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db import get_session
from app.integrations.storage import PresignedUpload, get_storage
from app.modules.auth import security
from app.modules.users.models import User
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import TEST_JWT_SECRET, TEST_STORAGE_SETTINGS, make_app, make_settings

# Distinct from the defaults, so the tests prove the values come from settings.
UPLOAD_TTL = 120
DOWNLOAD_TTL = 60
MAX_IMAGE = 1_000
MAX_VIDEO = 5_000
MAX_DOCUMENT = 2_000
LIMITS = {
    "upload_url_ttl_seconds": UPLOAD_TTL,
    "download_url_ttl_seconds": DOWNLOAD_TTL,
    "upload_max_image_bytes": MAX_IMAGE,
    "upload_max_video_bytes": MAX_VIDEO,
    "upload_max_document_bytes": MAX_DOCUMENT,
}
IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"]
FORBIDDEN = {
    "error": {"code": "upload_forbidden", "message": "You cannot upload files for this purpose."}
}
INVALID = {"error": {"code": "upload_invalid", "message": "The upload request is invalid."}}
NOT_FOUND = {"error": {"code": "upload_not_found", "message": "File not found."}}
KEY_SHAPE = r"u/{user_id}/{purpose}/[0-9a-f]{{32}}\{ext}"


@dataclass
class FakeStorage:
    puts: list[tuple[str, str, int, int]] = field(default_factory=list)
    gets: list[tuple[str, int]] = field(default_factory=list)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:
        self.puts.append((key, content_type, content_length, expires_in))
        headers: Mapping[str, str] = {
            "Content-Type": content_type,
            "Content-Length": str(content_length),
        }
        return PresignedUpload(url=f"https://storage.example.invalid/put/{key}", headers=headers)

    def presign_get(self, key: str, expires_in: int) -> str:
        self.gets.append((key, expires_in))
        return f"https://storage.example.invalid/get/{key}"


@pytest.fixture
def settings() -> Settings:
    return make_settings(**LIMITS)


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@dataclass(frozen=True)
class Caller:
    id: uuid.UUID
    headers: dict[str, str]


async def make_caller(session: AsyncSession, role: UserRole) -> Caller:
    user = User(email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=role)
    session.add(user)
    await session.flush()
    token = security.create_access_token(
        user_id=user.id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return Caller(id=user.id, headers={"Authorization": f"Bearer {token}"})


async def ask_upload(
    client: httpx.AsyncClient, caller: Caller, purpose: str, content_type: str, size: int
) -> httpx.Response:
    body = {"purpose": purpose, "content_type": content_type, "size_bytes": size}
    return await client.post("/v1/uploads", json=body, headers=caller.headers)


async def ask_download(client: httpx.AsyncClient, caller: Caller, key: str) -> httpx.Response:
    return await client.post("/v1/uploads/download-url", json={"key": key}, headers=caller.headers)


def assert_key(key: str, caller: Caller, purpose: str, ext: str) -> None:
    pattern = KEY_SHAPE.format(user_id=caller.id, purpose=purpose, ext=ext)
    assert re.fullmatch(pattern, key), key


def assert_expires_in(expires_at: str, seconds: int) -> None:
    delta = datetime.fromisoformat(expires_at) - datetime.now(UTC)
    assert timedelta(seconds=seconds - 5) < delta <= timedelta(seconds=seconds)


# Upload URLs


@pytest.mark.parametrize(
    ("content_type", "size", "ext"),
    [
        ("image/jpeg", MAX_IMAGE, ".jpg"),
        ("image/heic", 1, ".heic"),
        ("video/mp4", MAX_VIDEO, ".mp4"),
        ("video/quicktime", 10, ".mov"),
    ],
)
async def test_customer_gets_put_url_for_request_media(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    content_type: str,
    size: int,
    ext: str,
) -> None:
    customer = await make_caller(db_session, UserRole.CUSTOMER)

    response = await ask_upload(db_client, customer, "request_media", content_type, size)

    assert response.status_code == 201
    body = response.json()
    assert_key(body["key"], customer, "request_media", ext)
    assert body["upload_url"] == f"https://storage.example.invalid/put/{body['key']}"
    assert body["headers"] == {"Content-Type": content_type, "Content-Length": str(size)}
    assert_expires_in(body["expires_at"], UPLOAD_TTL)
    assert storage.puts == [(body["key"], content_type, size, UPLOAD_TTL)]


@pytest.mark.parametrize(
    ("purpose", "content_type", "size", "ext"),
    [
        ("job_photo", "image/png", MAX_IMAGE, ".png"),
        ("pro_document", "application/pdf", MAX_DOCUMENT, ".pdf"),
        # A document photo gets the document limit, not the image one.
        ("pro_document", "image/jpeg", MAX_DOCUMENT, ".jpg"),
        ("profile_photo", "image/webp", MAX_IMAGE, ".webp"),
    ],
)
async def test_pro_gets_put_url_for_job_photo_and_pro_document(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    purpose: str,
    content_type: str,
    size: int,
    ext: str,
) -> None:
    pro = await make_caller(db_session, UserRole.PRO)

    response = await ask_upload(db_client, pro, purpose, content_type, size)

    assert response.status_code == 201
    assert_key(response.json()["key"], pro, purpose, ext)


async def test_customer_gets_put_url_for_profile_photo(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    customer = await make_caller(db_session, UserRole.CUSTOMER)

    response = await ask_upload(db_client, customer, "profile_photo", "image/jpeg", 1)

    assert response.status_code == 201


@pytest.mark.parametrize(
    ("role", "purposes"),
    [
        (UserRole.CUSTOMER, ["job_photo", "pro_document"]),
        (UserRole.PRO, ["request_media"]),
        (UserRole.AGENT, ["request_media", "job_photo", "pro_document", "profile_photo"]),
        (UserRole.ADMIN, ["request_media", "job_photo", "pro_document", "profile_photo"]),
    ],
)
async def test_role_not_allowed_for_purpose_is_403(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    role: UserRole,
    purposes: list[str],
) -> None:
    caller = await make_caller(db_session, role)

    for purpose in purposes:
        response = await ask_upload(db_client, caller, purpose, "image/jpeg", 1)
        assert response.status_code == 403, purpose
        assert response.json() == FORBIDDEN

    assert storage.puts == []


@pytest.mark.parametrize(
    ("role", "purpose", "content_type"),
    [
        (UserRole.CUSTOMER, "request_media", "application/pdf"),
        (UserRole.CUSTOMER, "request_media", "image/svg+xml"),
        (UserRole.CUSTOMER, "request_media", "text/html"),
        (UserRole.CUSTOMER, "request_media", "IMAGE/JPEG"),
        (UserRole.CUSTOMER, "request_media", "image/jpeg; charset=utf-8"),
        (UserRole.PRO, "job_photo", "video/mp4"),
        (UserRole.PRO, "profile_photo", "application/pdf"),
    ],
)
async def test_type_not_allowed_is_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    role: UserRole,
    purpose: str,
    content_type: str,
) -> None:
    caller = await make_caller(db_session, role)

    response = await ask_upload(db_client, caller, purpose, content_type, 1)

    assert response.status_code == 422
    assert response.json() == INVALID
    assert storage.puts == []


@pytest.mark.parametrize(
    ("role", "purpose", "content_type", "maximum"),
    [
        (UserRole.CUSTOMER, "request_media", "image/jpeg", MAX_IMAGE),
        (UserRole.CUSTOMER, "request_media", "video/mp4", MAX_VIDEO),
        (UserRole.PRO, "pro_document", "application/pdf", MAX_DOCUMENT),
        (UserRole.PRO, "job_photo", "image/jpeg", MAX_IMAGE),
    ],
    ids=["image", "video", "document", "job_photo"],
)
async def test_size_zero_and_over_max_is_422(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    role: UserRole,
    purpose: str,
    content_type: str,
    maximum: int,
) -> None:
    caller = await make_caller(db_session, role)

    for size in (0, -1, maximum + 1):
        response = await ask_upload(db_client, caller, purpose, content_type, size)
        assert response.status_code == 422, size
        assert response.json() == INVALID
    assert (await ask_upload(db_client, caller, purpose, content_type, maximum)).status_code == 201
    assert [put[2] for put in storage.puts] == [maximum]


async def test_key_is_namespaced_random_and_ignores_client_input(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    customer = await make_caller(db_session, UserRole.CUSTOMER)
    other = await make_caller(db_session, UserRole.CUSTOMER)
    body = {
        "purpose": "request_media",
        "content_type": "image/png",
        "size_bytes": 10,
        # Never used: the key comes only from the caller, the purpose and the type.
        "filename": "../../evil.exe",
        "key": f"u/{other.id}/request_media/{'0' * 32}.png",
        "path": "/etc/passwd",
        "extension": ".exe",
    }

    keys = []
    for _ in range(2):
        response = await db_client.post("/v1/uploads", json=body, headers=customer.headers)
        assert response.status_code == 201
        keys.append(response.json()["key"])

    for key in keys:
        assert_key(key, customer, "request_media", ".png")
        assert "evil" not in key
        assert str(other.id) not in key
    assert keys[0] != keys[1]


# Download URLs


async def test_download_url_for_own_key(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    pro = await make_caller(db_session, UserRole.PRO)
    key = (await ask_upload(db_client, pro, "pro_document", "application/pdf", 10)).json()["key"]

    response = await ask_download(db_client, pro, key)

    assert response.status_code == 200
    assert response.json()["url"] == f"https://storage.example.invalid/get/{key}"
    assert_expires_in(response.json()["expires_at"], DOWNLOAD_TTL)
    assert storage.gets == [(key, DOWNLOAD_TTL)]


async def test_download_url_for_another_users_key_is_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    owner = await make_caller(db_session, UserRole.CUSTOMER)
    intruder = await make_caller(db_session, UserRole.CUSTOMER)
    key = (await ask_upload(db_client, owner, "request_media", "image/jpeg", 10)).json()["key"]

    response = await ask_download(db_client, intruder, key)
    # Even a well-formed key nobody ever uploaded reads the same.
    unknown = f"u/{uuid.uuid4()}/request_media/{'a' * 32}.jpg"
    response_unknown_owner = await ask_download(db_client, intruder, unknown)

    assert response.status_code == response_unknown_owner.status_code == 404
    assert response.json() == response_unknown_owner.json() == NOT_FOUND
    assert str(owner.id) not in response.text
    assert storage.gets == []


async def test_staff_cannot_read_a_users_key_here(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # Staff reads come later through the feature services (#124), not this endpoint.
    customer = await make_caller(db_session, UserRole.CUSTOMER)
    admin = await make_caller(db_session, UserRole.ADMIN)
    key = (await ask_upload(db_client, customer, "request_media", "image/jpeg", 10)).json()["key"]

    assert (await ask_download(db_client, admin, key)).status_code == 404


@pytest.mark.parametrize(
    "template",
    [
        "../u/{id}/request_media/{hex}.jpg",
        "u/{id}/request_media/../{hex}.jpg",
        "u/{id}/../{other}/request_media/{hex}.jpg",
        "/u/{id}/request_media/{hex}.jpg",
        "x/{id}/request_media/{hex}.jpg",
        "u/{id}/request_media/extra/{hex}.jpg",
        "u/{id}/request_media/{hex}.jpg/",
        "u/{id}/request_media/{hex}.exe",
        "u/{id}/request_media/{hex}",
        "u/{id}/avatars/{hex}.jpg",
        "u/{id}/request_media/{upper}.jpg",
        "u/{id}/request_media/{hex}.jpg\n",
        "u/{id_upper}/request_media/{hex}.jpg",
        "",
    ],
)
async def test_malformed_key_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, template: str
) -> None:
    caller = await make_caller(db_session, UserRole.CUSTOMER)
    key = template.format(
        id=caller.id,
        id_upper=str(caller.id).upper(),
        other=uuid.uuid4(),
        hex="0123456789abcdef0123456789abcdef",
        upper="0123456789ABCDEF0123456789ABCDEF",
    )

    response = await ask_download(db_client, caller, key)

    assert response.status_code == 422
    assert storage.gets == []


# Auth and configuration


async def test_unauthenticated_is_401(db_client: httpx.AsyncClient, storage: FakeStorage) -> None:
    upload = await db_client.post(
        "/v1/uploads",
        json={"purpose": "request_media", "content_type": "image/jpeg", "size_bytes": 1},
    )
    download = await db_client.post("/v1/uploads/download-url", json={"key": "u/x"})

    for response in (upload, download):
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "invalid_token"
    assert storage.puts == []
    assert storage.gets == []


async def test_missing_storage_config_is_generic_500(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    # No get_storage override and no S3_* settings, as in development without storage.
    customer = await make_caller(db_session, UserRole.CUSTOMER)

    response = await ask_upload(db_client, customer, "request_media", "image/jpeg", 1)

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error."}
    }
    assert any(record.message == "unhandled_error" for record in caplog.records)


@pytest.fixture
async def real_storage_client(db_session: AsyncSession) -> AsyncIterator[httpx.AsyncClient]:
    """The app with real S3Storage signing (dummy credentials; no network call)."""
    app = make_app(make_settings(**LIMITS, **TEST_STORAGE_SETTINGS))

    async def test_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = test_session
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


async def test_logs_have_no_urls_or_signatures(
    real_storage_client: httpx.AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    customer = await make_caller(db_session, UserRole.CUSTOMER)
    caplog.clear()

    # DEBUG, as an operator chasing an incident might set LOG_LEVEL.
    with caplog.at_level(logging.DEBUG):
        upload = await ask_upload(real_storage_client, customer, "request_media", "image/png", 10)
        key = upload.json()["key"]
        download = await ask_download(real_storage_client, customer, key)

    assert upload.status_code == 201
    assert download.status_code == 200
    # Real presigned URLs, with the signature in them.
    assert "X-Amz-Signature=" in upload.json()["upload_url"]
    assert "X-Amz-Signature=" in download.json()["url"]
    formatter = JsonFormatter()
    issued = [r for r in caplog.records if r.message == "upload_url_issued"]
    assert len(issued) == 1
    payload = json.loads(formatter.format(issued[0]))
    assert set(payload) - {"timestamp", "level", "logger", "message", "request_id"} == {
        "user_id",
        "purpose",
        "content_type",
        "size_bytes",
    }
    output = "\n".join(formatter.format(r) for r in caplog.records)
    for secret in (
        "X-Amz",
        "storage.example.invalid",
        key,
        key.rsplit("/", 1)[-1],
        upload.json()["upload_url"],
        download.json()["url"],
        str(TEST_STORAGE_SETTINGS["s3_access_key_id"]),
        str(TEST_STORAGE_SETTINGS["s3_secret_access_key"]),
    ):
        assert secret not in output
