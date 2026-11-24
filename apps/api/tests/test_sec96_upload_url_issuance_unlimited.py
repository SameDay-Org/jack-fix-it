"""#96 skeptic repro: POST /v1/uploads issues upload URLs without any limit.

The secure behaviour asserted here: one signed-in account asking for a burst of maximum-size
upload URLs is stopped (429) before it gets hundreds of them, and the orphan sweep deletes by
default so the files those URLs create do not stay in the bucket for ever. Both failed on
develop before #529.

Moved into the suite with #529: the token carries `session_id` (#161's signature), and the fake
storage lists an empty bucket for the pending uploads' ceiling, which now refuses most of the
burst (413) before the limit's 429.
"""

import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import ObjectPage, PresignedUpload, get_storage
from app.modules.auth import security
from app.modules.users.models import User
from app.modules.users.types import UserRole
from tests.conftest import TEST_JWT_SECRET, make_settings

BURST = 200


@dataclass
class FakeStorage:
    puts: list[tuple[str, str, int, int]] = field(default_factory=list)

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
        return f"https://storage.example.invalid/get/{key}"

    def list_older_than(self, prefix: str, before: datetime) -> Iterator[ObjectPage]:
        yield ObjectPage(objects=[], newer=0)


@pytest.fixture
def settings() -> Settings:
    # The deployed defaults: no upload overrides, so video max is the 100 MiB default.
    return make_settings()


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


async def test_one_account_cannot_get_hundreds_of_max_size_upload_urls(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    settings: Settings,
) -> None:
    user = User(
        email=f"sec96-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.CUSTOMER
    )
    db_session.add(user)
    await db_session.flush()
    token = security.create_access_token(
        user_id=user.id,
        role=UserRole.CUSTOMER,
        session_id=None,
        secret=TEST_JWT_SECRET,
        ttl_seconds=900,
        now=datetime.now(UTC),
    )
    headers = {"Authorization": f"Bearer {token}"}
    size = settings.upload_max_video_bytes
    assert size == 100 * 2**20
    body = {"purpose": "request_media", "content_type": "video/mp4", "size_bytes": size}

    statuses: list[int] = []
    keys: set[str] = set()
    for _ in range(BURST):
        response = await db_client.post("/v1/uploads", json=body, headers=headers)
        statuses.append(response.status_code)
        if response.status_code == 201:
            keys.add(response.json()["key"])

    granted_bytes = len(keys) * size
    # Secure: a burst from one account is rate limited before it gets all BURST URLs.
    assert 429 in statuses, (
        f"{statuses.count(201)}/{BURST} answered 201 with {len(keys)} distinct keys, never 429: "
        f"one account got PUT URLs for {granted_bytes / 2**30:.1f} GiB in one burst"
    )


def test_orphan_sweep_deletes_by_default() -> None:
    # Secure: with no ORPHAN_UPLOAD_MODE set (docs/railway.md lists none), orphans are deleted.
    default_mode = Settings.model_fields["orphan_upload_mode"].default
    assert default_mode == "delete", (
        f"orphan_upload_mode defaults to {default_mode!r}: unreferenced uploads are never deleted"
    )
