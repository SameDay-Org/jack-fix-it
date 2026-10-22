"""Schema of waitlist_entries (D8.4, #46, ADR 0007)."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.waitlist.models import WaitlistEntry, WaitlistSource
from tests.test_schema_core import assert_rejected


def entry(
    zip_code: str = "00009",
    email: str | None = "a@example.com",
    phone: str | None = None,
    **kw: object,
) -> WaitlistEntry:
    return WaitlistEntry(
        zip_code=zip_code, email=email, phone=phone, source=WaitlistSource.WEB, **kw
    )


async def test_email_or_phone_required(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, entry(email=None, phone=None))


async def test_email_lowercase(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, entry(email="A@Example.com"))


async def test_one_entry_per_email_per_zip(db_session: AsyncSession) -> None:
    db_session.add(entry())
    await db_session.flush()

    await assert_rejected(db_session, entry())
    db_session.add(entry(zip_code="00010"))  # another ZIP is fine
    await db_session.flush()


async def test_one_entry_per_phone_per_zip(db_session: AsyncSession) -> None:
    db_session.add(entry(email=None, phone="+14075550123"))
    await db_session.flush()

    await assert_rejected(db_session, entry(email=None, phone="+14075550123"))


async def test_partial_uniques_ignore_missing_contacts(db_session: AsyncSession) -> None:
    # Many phone-only entries have no email, and vice versa: NULLs never collide.
    db_session.add_all(
        [
            entry(email=None, phone="+14075550101"),
            entry(email=None, phone="+14075550102"),
            entry(email="x@example.com"),
            entry(email="y@example.com"),
        ]
    )
    await db_session.flush()


async def test_foreign_keys_must_exist(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, entry(category_id=uuid.uuid4()))
    await assert_rejected(db_session, entry(email="b@example.com", user_id=uuid.uuid4()))


async def test_source_check_and_locale_default(db_session: AsyncSession) -> None:
    row = entry(email="c@example.com")
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.locale == "en"
    with pytest.raises(IntegrityError):
        await db_session.execute(text("UPDATE waitlist_entries SET source = 'sms'"))
