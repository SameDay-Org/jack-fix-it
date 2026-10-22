"""Schema of pro_documents (D6.3, #37, ADR 0007)."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pros.models import ProDocument, ProDocumentStatus, ProDocumentType
from tests.test_schema_core import assert_rejected
from tests.test_schema_pro_profile import make_pro


def document(
    pro_id: uuid.UUID, key: str, doc_type: ProDocumentType = ProDocumentType.ID, **kw: object
) -> ProDocument:
    return ProDocument(pro_id=pro_id, doc_type=doc_type, file_key=key, **kw)


async def test_status_defaults_to_pending(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)
    row = document(pro.id, "k1")
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.status is ProDocumentStatus.PENDING


async def test_type_and_status_checks(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)
    # Every enum value passes the hand-written CHECKs.
    db_session.add_all(
        document(pro.id, f"t-{t.value}-{s.value}", doc_type=t, status=s)
        for t in ProDocumentType
        for s in ProDocumentStatus
    )
    await db_session.flush()

    for statement in (
        "UPDATE pro_documents SET doc_type = 'passport'",
        "UPDATE pro_documents SET status = 'expired'",
    ):
        savepoint = await db_session.begin_nested()
        with pytest.raises(IntegrityError):
            await db_session.execute(text(statement))
        await savepoint.rollback()


async def test_file_key_unique(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)
    db_session.add(document(pro.id, "same"))
    await db_session.flush()

    await assert_rejected(db_session, document(pro.id, "same"))


async def test_foreign_keys_must_exist(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)

    await assert_rejected(db_session, document(uuid.uuid4(), "orphan"))
    await assert_rejected(db_session, document(pro.id, "reviewer", reviewed_by=uuid.uuid4()))
