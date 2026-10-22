"""A pro's verification documents (D6.3, #37): photo ID, insurance, and a license when one of
their categories requires it. The admin reviews them (#41).

A pro only ever submits and reads their own documents: the caller is the key. A submission
checks everything first, then, in one transaction, ensures the profile, marks a pending
document of the same type superseded and stores the new one; reviewed ones stay as history.
Documents are sensitive: logs carry ids and the document type only, never a key or a URL.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.storage import Storage
from app.modules.categories.service import CategoryService
from app.modules.pros.errors import InvalidDocumentError, InvalidMediaError
from app.modules.pros.models import ProDocument, ProDocumentStatus, ProDocumentType
from app.modules.pros.repository import ProDocumentRepository, ProProfileRepository
from app.modules.pros.schemas import DocumentOut, DocumentsOut, DocumentSubmission
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.service import owned_upload
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

ALWAYS_REQUIRED: Final = (ProDocumentType.ID, ProDocumentType.INSURANCE)
# A document of these statuses covers its type; a rejected one does not.
_COVERING: Final = frozenset({ProDocumentStatus.PENDING, ProDocumentStatus.APPROVED})


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
        latest: dict[ProDocumentType, ProDocument] = {}
        history: list[ProDocument] = []
        for document in current:  # newest first
            if document.doc_type in latest:
                history.append(document)
            else:
                latest[document.doc_type] = document
        required = await self._required_types(profile.id if profile is not None else None)
        covered = {d.doc_type for d in current if d.status in _COVERING}
        return DocumentsOut(
            documents=[self._out(d) for d in latest.values()],
            history=[self._out(d) for d in history],
            required_types=required,
            missing_types=[t for t in required if t not in covered],
        )

    async def _required_types(self, pro_id: uuid.UUID | None) -> list[ProDocumentType]:
        """ID and insurance always; a license when any of the pro's categories requires one."""
        required = list(ALWAYS_REQUIRED)
        if pro_id is not None:
            category_ids = await self._profiles.category_ids(pro_id)
            if await self._categories.any_requires_license(category_ids):
                required.insert(1, ProDocumentType.LICENSE)
        return required

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
