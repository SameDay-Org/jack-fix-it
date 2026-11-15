"""Staff review of pros in the panel (D7.4, #41): the BDC and admins list the pros by
verification status, read one with their documents, review each document, then approve or
reject the profile. Only an approved profile (with payouts enabled) receives requests.

- The list carries the public name only ("María P."), counts and statuses: never an email, a
  phone, a last name or an address.
- The detail shows the pro's legal name (first and last, to match the ID document) and hands
  out short-lived URLs of the documents (IDs among them). Every detail read writes an
  audit_log row and commits it before answering, so neither is shown unaudited. Review
  answers never carry a URL or the legal name.
- A document review locks the document row. Only a pending document is reviewed; the same
  decision again answers the document as first decided and writes nothing; any other is a 409.
- A profile decision locks the profile row (the pro's own edits wait for it). An approval
  needs an approved, non-expired document of every required type, one category and one service
  area: else a 422 that lists what is missing, in fixed words. A rejection needs a reason, kept
  on the profile for the pro to read; an approval clears it. A rejected pro can be approved
  later. The same decision with the same reason again changes and writes nothing.
- Each change writes one audit_log row (the actor, before, after and the reason) in the same
  transaction: a failed audit write changes nothing.

Logs carry ids, statuses and counts: never a name, a reason, a storage key or a URL. The list
never carries the legal name.
"""

import base64
import binascii
import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import ForbiddenError
from app.integrations.storage import Storage
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    ActorNotStaffError,
    AuditAction,
    AuditEntity,
    AuditEntityType,
    ReaderNotStaffError,
)
from app.modules.categories.service import CategoryService
from app.modules.pros.documents import latest_and_history, required_types, uncovered_types
from app.modules.pros.errors import (
    DocumentNotPendingError,
    InvalidProListError,
    ProDocumentNotFoundError,
    ProNotApprovableError,
    ProNotFoundError,
)
from app.modules.pros.models import (
    ProDocument,
    ProDocumentStatus,
    ProDocumentType,
    ProProfile,
    ProVerificationStatus,
)
from app.modules.pros.repository import (
    Before,
    DocumentSummary,
    ProDocumentRepository,
    ProProfileRepository,
)
from app.modules.pros.schemas import (
    ApprovalBlocker,
    ApprovalBlockerKind,
    ProReviewIn,
    StaffDocumentCounts,
    StaffDocumentOut,
    StaffDocumentReviewOut,
    StaffProDecisionOut,
    StaffProItem,
    StaffProOut,
    StaffProPage,
    StaffProStatusCounts,
)
from app.modules.service_areas.service import ServiceAreaService
from app.modules.uploads.schemas import PhotoOut
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProReviewConfig:
    list_default_limit: int
    list_max_limit: int
    url_ttl_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ProReviewConfig":
        return cls(
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            url_ttl_seconds=settings.download_url_ttl_seconds,
        )


class ProReviewService:
    def __init__(
        self,
        session: AsyncSession,
        categories: CategoryService,
        service_areas: ServiceAreaService,
        storage: Storage,
        config: ProReviewConfig,
    ) -> None:
        self._session = session
        self._profiles = ProProfileRepository(session)
        self._documents = ProDocumentRepository(session)
        self._categories = categories
        self._service_areas = service_areas
        self._storage = storage
        self._config = config
        self._users = UserService(session)
        self._audit = AuditService(session)

    async def staff_list(
        self, *, status: ProVerificationStatus, limit: int | None, cursor: str | None
    ) -> StaffProPage:
        """The pros in `status`, newest profile first, and how many each status has. A fixed
        number of queries, whatever the page holds."""
        before = _decode_cursor(cursor) if cursor else None
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        rows = await self._profiles.staff_page(status=status, limit=size + 1, before=before)
        page, more = rows[:size], len(rows) > size
        pro_ids = [profile.id for profile in page]
        names = await self._users.public_names({profile.user_id for profile in page})
        category_ids = await self._profiles.category_ids_of(pro_ids)
        categories = await self._categories.summaries(
            {category_id for ids in category_ids.values() for category_id in ids}
        )
        areas = await self._profiles.service_area_counts(pro_ids)
        documents = await self._documents.summaries(pro_ids)
        counts = await self._profiles.count_by_status()
        items = []
        for profile in page:
            own = set(category_ids.get(profile.id, ()))
            summary = documents.get(profile.id, DocumentSummary())
            items.append(
                StaffProItem(
                    id=profile.id,
                    name=names.get(profile.user_id),
                    verification_status=profile.verification_status,
                    payouts_enabled=profile.payouts_enabled,
                    categories=[c for c in categories if c.id in own],  # by slug
                    zip_count=areas.get(profile.id, 0),
                    documents=StaffDocumentCounts(
                        pending=summary.pending,
                        approved=summary.approved,
                        rejected=summary.rejected,
                    ),
                    submitted_at=summary.oldest_pending_at,
                    created_at=profile.created_at,
                )
            )
        return StaffProPage(
            items=items,
            next_cursor=_encode_cursor(page[-1]) if more and page else None,
            counts=StaffProStatusCounts(
                pending=counts.get(ProVerificationStatus.PENDING, 0),
                approved=counts.get(ProVerificationStatus.APPROVED, 0),
                rejected=counts.get(ProVerificationStatus.REJECTED, 0),
            ),
        )

    async def staff_get(self, staff: UserAccount, pro_id: uuid.UUID) -> StaffProOut:
        """One pro with their legal name and their documents' URLs; the read is audited
        first."""
        profile = await self._profiles.get_by_id(pro_id)
        if profile is None:
            raise ProNotFoundError
        detail = await self._detail(profile)
        shown = [document.id for document in (*detail.documents, *detail.history)]
        # Committed before the answer: an audit write that fails answers 500, so neither the
        # legal name nor a document is shown unaudited.
        try:
            await self._audit.record_read(
                staff.id,
                AuditAction.PRO_REVIEW_READ,
                AuditEntity(AuditEntityType.PRO_PROFILE, pro_id),
                {
                    "documents": len(shown),
                    "document_ids": ",".join(str(document_id) for document_id in shown),
                },
            )
        except ReaderNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "pro_read_by_staff",
            extra={"pro_id": str(pro_id), "staff_id": str(staff.id), "documents": len(shown)},
        )
        return detail

    async def review_document(
        self, staff: UserAccount, pro_id: uuid.UUID, document_id: uuid.UUID, data: ProReviewIn
    ) -> StaffDocumentReviewOut:
        """Approves or rejects a pending document of the pro, audited, and commits."""
        document = await self._documents.get_of_pro_for_update(pro_id, document_id)
        if document is None:
            raise ProDocumentNotFoundError
        target = ProDocumentStatus(data.decision.value)
        if document.status == target:
            await self._session.commit()  # a replay: nothing changed, only the row lock goes
            return _review_out(document)
        if document.status != ProDocumentStatus.PENDING:
            raise DocumentNotPendingError
        document = await self._documents.set_review(
            document_id, target, reason=data.reason, reviewed_by=staff.id
        )
        try:
            # In the change's transaction: an audit write that fails rolls the change back.
            await self._audit.record_staff_action(
                staff.id,
                AuditAction.PRO_DOCUMENT_REVIEW,
                AuditEntity(AuditEntityType.PRO_DOCUMENT, document_id),
                {"status": ProDocumentStatus.PENDING.value},
                {
                    "status": target.value,
                    "pro_id": str(pro_id),
                    "doc_type": document.doc_type.value,
                },
                reason=data.reason,
            )
        except ActorNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "pro_document_reviewed",
            extra={
                "pro_id": str(pro_id),
                "document_id": str(document_id),
                "staff_id": str(staff.id),
                "doc_type": document.doc_type.value,
                "to_status": target.value,
            },
        )
        return _review_out(document)

    async def decide(
        self, staff: UserAccount, pro_id: uuid.UUID, data: ProReviewIn
    ) -> StaffProDecisionOut:
        """Approves or rejects the profile, audited, and commits. An approval is refused
        (ProNotApprovableError) while something it requires is missing."""
        profile = await self._profiles.get_by_id(pro_id, lock=True)
        if profile is None:
            raise ProNotFoundError
        target = ProVerificationStatus(data.decision.value)
        previous = profile.verification_status
        if previous == target and profile.rejection_reason == data.reason:
            await self._session.commit()  # a replay: nothing changed, only the row lock goes
            return _decision_out(profile)
        if target == ProVerificationStatus.APPROVED:
            category_ids = await self._profiles.category_ids(pro_id)
            blockers = _blockers(
                await self._required_types(category_ids),
                await self._documents.current_of(pro_id),
                has_category=bool(category_ids),
                has_service_area=bool(await self._profiles.service_area_ids(pro_id)),
                today=datetime.now(UTC).date(),
            )
            if blockers:
                logger.info(
                    "pro_approval_refused",
                    extra={
                        "pro_id": str(pro_id),
                        "staff_id": str(staff.id),
                        "blockers": len(blockers),
                    },
                )
                raise ProNotApprovableError(_blockers_message(blockers))
        profile = await self._profiles.set_verification(
            pro_id, target, reason=data.reason, reviewed_by=staff.id
        )
        try:
            # In the change's transaction: an audit write that fails rolls the change back.
            await self._audit.record_staff_action(
                staff.id,
                AuditAction.PRO_PROFILE_SET_VERIFICATION,
                AuditEntity(AuditEntityType.PRO_PROFILE, pro_id),
                {"verification_status": previous.value},
                {"verification_status": target.value},
                reason=data.reason,
            )
        except ActorNotStaffError:
            await self._session.rollback()
            raise ForbiddenError from None
        await self._session.commit()
        logger.info(
            "pro_verification_decided",
            extra={
                "pro_id": str(pro_id),
                "staff_id": str(staff.id),
                "from_status": previous.value,
                "to_status": target.value,
            },
        )
        return _decision_out(profile)

    async def _required_types(self, category_ids: Sequence[uuid.UUID]) -> list[ProDocumentType]:
        return required_types(
            needs_license=await self._categories.any_requires_license(category_ids)
        )

    async def _detail(self, profile: ProProfile) -> StaffProOut:
        ttl = self._config.url_ttl_seconds
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
        category_ids = await self._profiles.category_ids(profile.id)
        area_ids = await self._profiles.service_area_ids(profile.id)
        current = await self._documents.current_of(profile.id)
        required = await self._required_types(category_ids)
        latest, history = latest_and_history(current)
        names = await self._users.public_names({profile.user_id})

        def document_out(document: ProDocument) -> StaffDocumentOut:
            return StaffDocumentOut(
                **_review_out(document).model_dump(),
                url=self._storage.presign_get(document.file_key, ttl),
                expires_at=expires_at,
            )

        photo = None
        if profile.photo_key is not None:
            photo = PhotoOut(
                url=self._storage.presign_get(profile.photo_key, ttl), expires_at=expires_at
            )
        return StaffProOut(
            **_decision_out(profile).model_dump(),
            user_id=profile.user_id,
            name=names.get(profile.user_id),
            legal_name=await self._users.legal_name(profile.user_id),
            payouts_enabled=profile.payouts_enabled,
            bio=profile.bio,
            years_of_experience=profile.years_of_experience,
            photo=photo,
            categories=await self._categories.summaries(category_ids),
            service_areas=await self._service_areas.get_many(area_ids),
            documents=[document_out(document) for document in latest],
            history=[document_out(document) for document in history],
            required_types=required,
            missing_types=uncovered_types(required, current),
            approval_blockers=_blockers(
                required,
                current,
                has_category=bool(category_ids),
                has_service_area=bool(area_ids),
                today=datetime.now(UTC).date(),
            ),
            created_at=profile.created_at,
        )


def _blockers(
    required: Sequence[ProDocumentType],
    current: Sequence[ProDocument],
    *,
    has_category: bool,
    has_service_area: bool,
    today: date,
) -> list[ApprovalBlocker]:
    """What an approval still needs: an approved document of every required type that has not
    expired (no expiry date, or one that is today or later, UTC), a category and an area."""
    blockers: list[ApprovalBlocker] = []
    for doc_type in required:
        approved = [
            document
            for document in current
            if document.doc_type == doc_type and document.status == ProDocumentStatus.APPROVED
        ]
        if not approved:
            blockers.append(
                ApprovalBlocker(kind=ApprovalBlockerKind.DOCUMENT_MISSING, doc_type=doc_type)
            )
        elif all(d.expires_on is not None and d.expires_on < today for d in approved):
            blockers.append(
                ApprovalBlocker(kind=ApprovalBlockerKind.DOCUMENT_EXPIRED, doc_type=doc_type)
            )
    if not has_category:
        blockers.append(ApprovalBlocker(kind=ApprovalBlockerKind.NO_CATEGORY, doc_type=None))
    if not has_service_area:
        blockers.append(ApprovalBlocker(kind=ApprovalBlockerKind.NO_SERVICE_AREA, doc_type=None))
    return blockers


def _blockers_message(blockers: Sequence[ApprovalBlocker]) -> str:
    """What the 422 says, e.g. "The pro cannot be approved yet: id document missing, no
    service area." Fixed words only: the document types and the blocker kinds."""
    words = {
        ApprovalBlockerKind.DOCUMENT_MISSING: "document missing",
        ApprovalBlockerKind.DOCUMENT_EXPIRED: "document expired",
        ApprovalBlockerKind.NO_CATEGORY: "no category",
        ApprovalBlockerKind.NO_SERVICE_AREA: "no service area",
    }
    parts = [
        words[b.kind] if b.doc_type is None else f"{b.doc_type.value} {words[b.kind]}"
        for b in blockers
    ]
    return f"The pro cannot be approved yet: {', '.join(parts)}."


def _review_out(document: ProDocument) -> StaffDocumentReviewOut:
    return StaffDocumentReviewOut(
        id=document.id,
        doc_type=document.doc_type,
        status=document.status,
        rejection_reason=document.rejection_reason,
        expires_on=document.expires_on,
        created_at=document.created_at,
        reviewed_at=document.reviewed_at,
    )


def _decision_out(profile: ProProfile) -> StaffProDecisionOut:
    return StaffProDecisionOut(
        id=profile.id,
        verification_status=profile.verification_status,
        rejection_reason=profile.rejection_reason,
        reviewed_at=profile.reviewed_at,
    )


def _encode_cursor(profile: ProProfile) -> str:
    raw = f"{profile.created_at.isoformat()}|{profile.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> Before:
    """A cursor only positions the page: the list is open to staff anyway."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, pro_id = raw.split("|")
        decoded = datetime.fromisoformat(created_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(pro_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidProListError from None
