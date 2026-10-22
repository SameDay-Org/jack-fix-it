"""Schema of request_media (D8.1, #42, ADR 0007)."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.addresses.models import Address
from app.modules.requests.models import (
    MediaSafeStatus,
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    ServiceRequest,
)
from app.modules.users.models import User, UserRole
from tests.test_schema_core import assert_rejected


@pytest.fixture
async def request_id(db_session: AsyncSession) -> uuid.UUID:
    user = User(email="customer@x.com", password_hash="x", role=UserRole.CUSTOMER)
    db_session.add(user)
    await db_session.flush()
    address = Address(
        user_id=user.id, line1="1 Main St", city="Orlando", state="FL", zip_code="32801"
    )
    db_session.add(address)
    await db_session.flush()
    request = ServiceRequest(
        customer_id=user.id,
        address_id=address.id,
        description="Fix a leak",
        origin=RequestOrigin.APP,
    )
    db_session.add(request)
    await db_session.flush()
    return request.id


def media(
    request_id: uuid.UUID, key: str, kind: RequestMediaKind = RequestMediaKind.PHOTO
) -> RequestMedia:
    return RequestMedia(request_id=request_id, kind=kind, file_key=key)


async def test_kind_check_rejects_unknown_values(
    db_session: AsyncSession, request_id: uuid.UUID
) -> None:
    db_session.add(media(request_id, "u/a/request_media/1.jpg"))
    await db_session.flush()

    with pytest.raises(IntegrityError):
        await db_session.execute(text("UPDATE request_media SET kind = 'document'"))


async def test_kind_check_accepts_every_value(
    db_session: AsyncSession, request_id: uuid.UUID
) -> None:
    # The migration's CHECK is written by hand; every StrEnum member must pass it.
    db_session.add_all(
        media(request_id, f"u/a/request_media/{kind.value}.jpg", kind) for kind in RequestMediaKind
    )
    await db_session.flush()


async def test_file_key_unique(db_session: AsyncSession, request_id: uuid.UUID) -> None:
    db_session.add(media(request_id, "u/a/request_media/same.jpg"))
    await db_session.flush()

    await assert_rejected(db_session, media(request_id, "u/a/request_media/same.jpg"))


async def test_request_must_exist(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, media(uuid.uuid4(), "u/a/request_media/orphan.jpg"))


# The privacy-safe copy (#173)


async def test_a_new_media_row_is_pending_with_no_safe_copy(
    db_session: AsyncSession, request_id: uuid.UUID
) -> None:
    row = media(request_id, "u/a/request_media/safe-default.jpg")
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert (row.safe_status, row.safe_key, row.safe_content_type) == (
        MediaSafeStatus.PENDING,
        None,
        None,
    )


async def test_safe_status_check_accepts_every_value_and_rejects_others(
    db_session: AsyncSession, request_id: uuid.UUID
) -> None:
    db_session.add(media(request_id, "u/a/request_media/safe-check.jpg"))
    await db_session.flush()

    for status in MediaSafeStatus:
        await db_session.execute(
            text("UPDATE request_media SET safe_status = :status"), {"status": status.value}
        )
    with pytest.raises(IntegrityError):
        await db_session.execute(text("UPDATE request_media SET safe_status = 'served'"))


async def test_a_safe_key_belongs_to_one_media_row(
    db_session: AsyncSession, request_id: uuid.UUID
) -> None:
    first = media(request_id, "u/a/request_media/safe-1.jpg")
    second = media(request_id, "u/a/request_media/safe-2.jpg")
    first.safe_key = second.safe_key = "m/" + "0" * 32 + ".jpg"
    db_session.add(first)
    await db_session.flush()

    db_session.add(second)
    with pytest.raises(IntegrityError):
        await db_session.flush()
