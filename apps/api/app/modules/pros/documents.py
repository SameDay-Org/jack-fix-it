"""A pro's verification documents (D6.3, #37): photo ID, insurance, and a license when one of
their categories requires it. The admin reviews them (#41).

A pro only ever submits and reads their own documents: the caller is the key. A submission
checks everything first, then, in one transaction, ensures the profile, marks a pending
document of the same type superseded and stores the new one; reviewed ones stay as history.
Documents are sensitive: logs carry ids and the document type only, never a key or a URL.
"""

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import Storage
from app.modules.categories.service import CategoryService
from app.modules.pros.errors import InvalidDocumentError, InvalidMediaError
from app.modules.pros.models import ProDocument, ProDocumentStatus, ProDocumentType
from app.modules.pros.repository import ProDocumentRepository, ProProfileRepository
from app.modules.pros.schemas import DocumentOut, DocumentsOut, DocumentSubmission
from app.modules.uploads.keys import owned_upload
from app.modules.uploads.schemas import UploadPurpose
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

ALWAYS_REQUIRED: Final = (ProDocumentType.ID, ProDocumentType.INSURANCE)
# A document of these statuses covers its type; a rejected one does not.
_COVERING: Final = frozenset({ProDocumentStatus.PENDING, ProDocumentStatus.APPROVED})


def required_types(*, needs_license: bool) -> list[ProDocumentType]:
    """ID and insurance always; a license when any of the pro's categories requires one."""
    required = list(ALWAYS_REQUIRED)
    if needs_license:
        required.insert(1, ProDocumentType.LICENSE)
    return required


def latest_and_history(
    current: Sequence[ProDocument],
) -> tuple[list[ProDocument], list[ProDocument]]:
    """(the latest document of each type, the older ones) of a pro's documents given newest
    first, superseded ones left out (ProDocumentRepository.current_of)."""
    latest: dict[ProDocumentType, ProDocument] = {}
    history: list[ProDocument] = []
    for document in current:
        if document.doc_type in latest:
            history.append(document)
        else:
            latest[document.doc_type] = document
    return list(latest.values()), history


def expired(document: ProDocument, today: date) -> bool:
    """Whether the document's expiry date has passed: it is before `today` (UTC). A document
    without one never expires."""
    return document.expires_on is not None and document.expires_on < today


def uncovered_types(
    required: Sequence[ProDocumentType],
    current: Sequence[ProDocument],
    *,
    today: date | None = None,
) -> list[ProDocumentType]:
    """The required types with no pending or approved document. Given `today` (the staff
    detail, #41), an approved document that has expired no longer covers its type: it counts as
    missing again (Foreman decision on #41), as the approval reads it. The pro's own list
    (list_own) passes no date and reads no expiry."""
    covered = {
        d.doc_type
        for d in current
        if d.status in _COVERING
        and not (today is not None and d.status == ProDocumentStatus.APPROVED and expired(d, today))
    }
    return [doc_type for doc_type in required if doc_type not in covered]


class ProDocumentService:
    def __init__(
        self,
        session: AsyncSession,
        categories: CategoryService,
        storage: Storage,
        url_ttl_seconds: int,
    ) -> None:
        self._session = session
        self._profiles = ProProfileRepository(session)
        self._documents = ProDocumentRepository(session)
        self._categories = categories
        self._storage = storage
        self._url_ttl = url_ttl_seconds

    async def submit(self, user: UserAccount, data: DocumentSubmission) -> DocumentOut:
        if owned_upload(data.file_key, user.id, UploadPurpose.PRO_DOCUMENT) is None:
            raise InvalidMediaError
        if data.expires_on is not None and data.expires_on < datetime.now(UTC).date():
            raise InvalidDocumentError

        # One transaction from here: the profile (when absent), the superseding and the new
        # document commit together. The profile row lock serializes two submissions of a pro.
        await self._profiles.insert_if_missing(user.id)
        profile = await self._profiles.get_by_user_id(user.id, lock=True)
        if profile is None:  # pragma: no cover - ensured just above, in this transaction
            raise RuntimeError("pro profile missing after insert")
        superseded = await self._documents.supersede_pending(profile.id, data.doc_type)
        savepoint = await self._session.begin_nested()
        try:
            document = await self._documents.add(
                ProDocument(
                    pro_id=profile.id,
                    doc_type=data.doc_type,
                    file_key=data.file_key,
                    expires_on=data.expires_on,
                )
            )
        except IntegrityError:
            # The key is already a document (unique file_key): one upload, one document.
            await savepoint.rollback()
            raise InvalidMediaError from None
        await savepoint.commit()
        await self._session.commit()
        logger.info(
            "pro_document_submitted",
            extra={
                "user_id": str(user.id),
                "document_id": str(document.id),
                "doc_type": data.doc_type.value,
                "superseded": superseded,
            },
        )
        return self._out(document)

    async def list_own(self, user: UserAccount) -> DocumentsOut:
        profile = await self._profiles.get_by_user_id(user.id)
        current = await self._documents.current_of(profile.id) if profile is not None else []
        latest, history = latest_and_history(current)
        required = await self._required_types(profile.id if profile is not None else None)
        return DocumentsOut(
            documents=[self._out(d) for d in latest],
            history=[self._out(d) for d in history],
            required_types=required,
            missing_types=uncovered_types(required, current),
        )

    async def _required_types(self, pro_id: uuid.UUID | None) -> list[ProDocumentType]:
        needs_license = False
        if pro_id is not None:
            category_ids = await self._profiles.category_ids(pro_id)
            needs_license = await self._categories.any_requires_license(category_ids)
        return required_types(needs_license=needs_license)

    def _out(self, document: ProDocument) -> DocumentOut:
        return DocumentOut(
            id=document.id,
            doc_type=document.doc_type,
            status=document.status,
            rejection_reason=document.rejection_reason,
            expires_on=document.expires_on,
            created_at=document.created_at,
            url=self._storage.presign_get(document.file_key, self._url_ttl),
            expires_at=datetime.now(UTC) + timedelta(seconds=self._url_ttl),
        )
