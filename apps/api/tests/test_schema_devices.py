"""Schema of devices (D10.3, #54, ADR 0007)."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.devices.models import Device, DevicePlatform
from app.modules.users.models import User, UserRole
from tests.test_schema_core import assert_rejected


async def make_user(session: AsyncSession) -> uuid.UUID:
    user = User(email=f"u-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
    session.add(user)
    await session.flush()
    return user.id


def device(user_id: uuid.UUID, token: str, platform: DevicePlatform = DevicePlatform.IOS) -> Device:
    return Device(
        user_id=user_id, expo_push_token=token, platform=platform, last_seen_at=datetime.now(UTC)
    )


async def test_token_unique(db_session: AsyncSession) -> None:
    owner = await make_user(db_session)
    db_session.add(device(owner, "ExponentPushToken[a]"))
    await db_session.flush()

    await assert_rejected(db_session, device(await make_user(db_session), "ExponentPushToken[a]"))


async def test_user_must_exist(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, device(uuid.uuid4(), "ExponentPushToken[b]"))


async def test_platform_check(db_session: AsyncSession) -> None:
    owner = await make_user(db_session)
    db_session.add_all(device(owner, f"ExponentPushToken[{p.value}]", p) for p in DevicePlatform)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        await db_session.execute(text("UPDATE devices SET platform = 'windows'"))
