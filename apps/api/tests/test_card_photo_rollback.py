"""A failure to sign the ID photo (#250) must not follow a durable change (#290, Gatekeeper
round 1): the refresh rotation, a PATCH of the card fields and a phone verification prepare
the photo before they commit or consume anything. Here the real lazy storage provider fails,
two ways, on real per-request sessions: nothing is left behind, the client keeps a usable
refresh token and the SMS code is still unspent, so each call succeeds once the storage is back.
"""

import logging
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.sms_verify import get_phone_verifier
from app.integrations.storage import StorageNotConfiguredError
from app.modules.pros.models import ProProfile
from app.modules.users.models import User
from tests.conftest import TEST_STORAGE_SETTINGS, Committed, make_settings
from tests.test_auth_api import register
from tests.test_auth_refresh import family_count, get_row, refresh
from tests.test_me_card_fields import CITY, PHOTO_TTL, STATE, FakeStorage, logged
from tests.test_phone_verify_api import CODE, PHONE, FakeVerifier

GENERIC_500 = {"error": {"code": "internal_error", "message": "Internal server error."}}
# How the storage breaks: S3_* unset, as in development without a storage, or an endpoint
# Settings accepts and boto3 refuses while building the client. Both surface on the first
# signature, as a request that needs a URL resolves the provider lazily.
BROKEN_STORAGE: dict[str, dict[str, object]] = {
    "unconfigured": {},
    "invalid_endpoint": TEST_STORAGE_SETTINGS | {"s3_endpoint_url": "invalid-endpoint"},
}


@pytest.fixture(params=list(BROKEN_STORAGE))
def settings(request: pytest.FixtureRequest) -> Settings:
    # No grace window (#152): a 200 on a retried refresh can then only come from a token that
    # was never spent, not from the replay of a successor the client never received.
    return make_settings(
        download_url_ttl_seconds=PHOTO_TTL,
        refresh_reuse_grace_seconds=0,
        **BROKEN_STORAGE[request.param],
    )


@pytest.fixture
def failure(settings: Settings) -> type[Exception]:
    """What the storage raises under these settings."""
    return StorageNotConfiguredError if settings.s3_endpoint_url is None else ValueError


def bearer(body: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {body['access_token']}"}


async def sign_up_with_photo(committed: Committed, app: FastAPI) -> tuple[dict[str, Any], str]:
    """Registers the fixture's user and sets its ID photo while the storage still works; then
    the storage is gone again. Returns the registration body (tokens, user) and the key."""
    response = await register(committed.client, email=committed.email)
    assert response.status_code == 201, response.text
    body = response.json()
    key = f"u/{body['user']['id']}/profile_photo/{uuid.uuid4().hex}.jpg"
    app.state.storage = FakeStorage()
    patched = await committed.client.patch(
        "/v1/auth/me", json={"photo_key": key}, headers=bearer(body)
    )
    assert patched.status_code == 200, patched.text
    app.state.storage = None  # back to the lazy provider, which fails on the next signature
    return body, key


async def user_row(session: AsyncSession, body: dict[str, Any]) -> User:
    user = await session.get(User, uuid.UUID(body["user"]["id"]))
    assert user is not None
    return user


async def pro_profile_row(session: AsyncSession, body: dict[str, Any]) -> ProProfile | None:
    statement = select(ProProfile).where(ProProfile.user_id == uuid.UUID(body["user"]["id"]))
    return (await session.scalars(statement)).one_or_none()


def assert_storage_failed(
    caplog: pytest.LogCaptureFixture, failure: type[Exception], *secrets: str
) -> None:
    """The 500 was the storage's exception, logged once as unhandled_error without any of the
    secrets (keys, card fields, numbers and codes never reach a log)."""
    [error] = [record for record in caplog.records if record.message == "unhandled_error"]
    assert error.exc_info is not None
    assert isinstance(error.exc_info[1], failure)
    output = logged(caplog)
    for secret in secrets:
        assert secret not in output


async def verify_phone(client: httpx.AsyncClient, body: dict[str, Any]) -> httpx.Response:
    return await client.post(
        "/v1/auth/phone/verify", json={"phone": PHONE, "code": CODE}, headers=bearer(body)
    )


async def test_refresh_with_a_failing_photo_spends_nothing(
    committed: Committed,
    app: FastAPI,
    failure: type[Exception],
    caplog: pytest.LogCaptureFixture,
) -> None:
    body, key = await sign_up_with_photo(committed, app)
    old = body["refresh_token"]

    with caplog.at_level(logging.DEBUG):
        failed = await refresh(committed.client, old)

    assert failed.status_code == 500
    assert failed.json() == GENERIC_500
    assert_storage_failed(caplog, failure, key, old)
    async with committed.sessions() as session:
        row = await get_row(session, old)
        assert (row.revoked_at, row.replaced_by_id) == (None, None)
        assert await family_count(session, row.family_id) == 1  # no successor was issued
    # The storage recovers: the only token the client has still rotates, outside any grace
    # window, and the family is intact.
    app.state.storage = FakeStorage()
    retried = await refresh(committed.client, old)
    assert retried.status_code == 200, retried.text
    assert retried.json()["user"]["photo"]["url"].endswith(f"{key}?sig=fake")
    assert not any(record.message == "auth_refresh_reuse_detected" for record in caplog.records)
    async with committed.sessions() as session:
        row = await get_row(session, old)
        assert row.revoked_at is not None
        assert row.replaced_by_id is not None
        assert await family_count(session, row.family_id) == 2


@pytest.mark.parametrize("role", ["customer", "pro"])
async def test_patch_me_with_a_failing_photo_saves_nothing(
    committed: Committed, failure: type[Exception], caplog: pytest.LogCaptureFixture, role: str
) -> None:
    body = (await register(committed.client, email=committed.email, role=role)).json()
    key = f"u/{body['user']['id']}/profile_photo/{uuid.uuid4().hex}.jpg"
    fields = {"home_city": CITY, "home_state": STATE, "photo_key": key}

    with caplog.at_level(logging.DEBUG):
        failed = await committed.client.patch("/v1/auth/me", json=fields, headers=bearer(body))

    assert failed.status_code == 500
    assert failed.json() == GENERIC_500
    assert_storage_failed(caplog, failure, CITY, STATE, key)
    assert not any(record.message == "user_updated" for record in caplog.records)
    async with committed.sessions() as session:
        user = await user_row(session, body)
        assert (user.home_city, user.home_state, user.photo_key) == (None, None, None)
        # A pro's selfie would also have created their public profile: rolled back with it.
        assert await pro_profile_row(session, body) is None


async def test_phone_verify_with_a_failing_photo_consumes_nothing(
    committed: Committed,
    app: FastAPI,
    failure: type[Exception],
    caplog: pytest.LogCaptureFixture,
) -> None:
    body, key = await sign_up_with_photo(committed, app)
    verifier = FakeVerifier()
    app.dependency_overrides[get_phone_verifier] = lambda: verifier

    with caplog.at_level(logging.DEBUG):
        failed = await verify_phone(committed.client, body)

    assert failed.status_code == 500
    assert failed.json() == GENERIC_500
    assert_storage_failed(caplog, failure, key, PHONE, CODE)
    assert verifier.checked == []  # the code was never asked about, so it is still unspent
    assert not any(record.message == "phone_verified" for record in caplog.records)
    async with committed.sessions() as session:
        user = await user_row(session, body)
        assert (user.phone, user.phone_verified_at) == (None, None)
    # The storage recovers: the same code verifies the number, once.
    app.state.storage = FakeStorage()
    verified = await verify_phone(committed.client, body)
    assert verified.status_code == 200, verified.text
    assert verified.json()["phone_verified"] is True
    assert verified.json()["photo"]["url"].endswith(f"{key}?sig=fake")
    assert verifier.checked == [(PHONE, CODE)]
