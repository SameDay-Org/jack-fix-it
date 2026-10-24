"""Service requests (D8.1, #42): a customer asks for a service and follows it.

Create validates everything before writing, then stores the address, the request and its
media in one transaction (one savepoint): a failure leaves nothing behind. The server sets
origin (app), language (the caller's locale) and status (received); urgency and preferred
contact are not accepted from the client yet (#45 defines their values).

After the commit, create queues dispatch (#48) for the worker, then, when the request has
media, the privacy-safe copy of its photos and videos (#173); a failed or slow enqueue is
logged and never fails the request (the BDC can dispatch it again).

Customers read only their own requests: another customer's id answers 404 (ensure_owner).
Logs carry the request id, the user id and counts: never the description, the address, media
keys or URLs.
"""

import base64
import binascii
import json
import logging
import uuid
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Final

from pydantic import JsonValue
from redis.exceptions import RedisError
from sqlalchemy import Select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.integrations.storage import Storage
from app.modules.addresses.schemas import AddressArea
from app.modules.addresses.service import AddressService
from app.modules.auth.permissions import ensure_owner
from app.modules.categories.intake import InvalidAnswersError, validate_answers
from app.modules.categories.service import BrokenIntakeQuestionsError, CategoryService
from app.modules.dispatch.service import enqueue_dispatch
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.errors import (
    InvalidCategoryError,
    InvalidIntakeAnswersError,
    InvalidMediaError,
    InvalidRequestError,
    ZipNotServedError,
)
from app.modules.requests.media_copies import enqueue_sanitize
from app.modules.requests.models import (
    RequestMedia,
    RequestMediaKind,
    RequestOrigin,
    RequestStatus,
    ServiceRequest,
)
from app.modules.requests.repository import ServiceRequestRepository
from app.modules.requests.schemas import (
    MediaOut,
    RequestCreate,
    RequestOut,
    RequestPage,
    RequestSummary,
)
from app.modules.service_areas.schemas import zip5
from app.modules.service_areas.service import ServiceAreaService
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.service import owned_upload
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.queue import JobQueue
from app.redaction import KnownValues, redact_text

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RequestConfig:
    intake_max_bytes: int
    media_max_items: int
    list_default_limit: int
    list_max_limit: int
    media_url_ttl_seconds: int
    enqueue_timeout_seconds: float

    @classmethod
    def from_settings(cls, settings: Settings) -> "RequestConfig":
        return cls(
            intake_max_bytes=settings.request_intake_max_bytes,
            media_max_items=settings.request_media_max_items,
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            media_url_ttl_seconds=settings.download_url_ttl_seconds,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
        )


class ServiceRequestService:
    def __init__(
        self,
        session: AsyncSession,
        addresses: AddressService,
        categories: CategoryService,
        service_areas: ServiceAreaService,
        storage: Storage,
        config: RequestConfig,
        queue: JobQueue,
    ) -> None:
        self._session = session
        self._requests = ServiceRequestRepository(session)
        self._addresses = addresses
        self._categories = categories
        self._service_areas = service_areas
        self._storage = storage
        self._config = config
        self._queue = queue

    async def create(self, user: UserAccount, data: RequestCreate) -> RequestOut:
        if data.preferred_date is not None and data.preferred_date < datetime.now(UTC).date():
            raise InvalidRequestError
        if _intake_size(data.intake_answers) > self._config.intake_max_bytes:
            raise InvalidRequestError
        if not await self._service_areas.is_served(data.address.zip_code):
            raise ZipNotServedError
        intake_answers = await self._intake_answers(data.category_id, data.intake_answers)
        media_kinds = self._media_kinds(user, data.media_keys)

        savepoint = await self._session.begin_nested()
        try:
            address_id = await self._addresses.create(user.id, data.address)
            request = await self._requests.add(
                ServiceRequest(
                    customer_id=user.id,
                    category_id=data.category_id,
                    address_id=address_id,
                    description=data.description,
                    intake_answers=intake_answers,
                    preferred_date=data.preferred_date,
                    language=user.locale,
                    origin=RequestOrigin.APP,
                    utm=data.utm.model_dump(exclude_none=True) if data.utm else None,
                )
            )
            await self._requests.add_media(
                [
                    RequestMedia(request_id=request.id, kind=kind, file_key=key)
                    for key, kind in media_kinds
                ]
            )
        except IntegrityError:
            # A media key already attached to another request (uq_request_media_file_key).
            await savepoint.rollback()
            raise InvalidMediaError from None
        await savepoint.commit()
        await self._session.commit()
        logger.info(
            "request_created",
            extra={
                # Not "request_id": that is the HTTP correlation id in every log line.
                "service_request_id": str(request.id),
                "user_id": str(user.id),
                "media_count": len(media_kinds),
            },
        )
        await self._queue_dispatch(request.id)
        if media_kinds:
            await self._queue_sanitize(request.id)
        return await self._detail(request)

    async def _queue_dispatch(self, request_id: uuid.UUID) -> None:
        """Hands the committed request to dispatch. Never fails the create: the request is
        saved, and the BDC can dispatch it again."""
        try:
            await enqueue_dispatch(self._queue, request_id, self._config.enqueue_timeout_seconds)
        except (RedisError, OSError):  # TimeoutError is an OSError
            logger.error("dispatch_enqueue_failed", extra={"service_request_id": str(request_id)})

    async def _queue_sanitize(self, request_id: uuid.UUID) -> None:
        """Hands the committed media to the privacy-safe copy (#173), after dispatch, which it
        never delays. Never fails the create: the rows stay pending."""
        try:
            await enqueue_sanitize(self._queue, request_id, self._config.enqueue_timeout_seconds)
        except (RedisError, OSError):  # TimeoutError is an OSError
            logger.error("sanitize_enqueue_failed", extra={"service_request_id": str(request_id)})

    async def get(self, user: UserAccount, request_id: uuid.UUID) -> RequestOut:
        request = await self._requests.get(request_id)
        if request is None:
            # The same 404 as someone else's request: an id reveals nothing.
            raise NotFoundError
        ensure_owner(request.customer_id, user)
        return await self._detail(request)

    async def list_own(
        self, user: UserAccount, limit: int | None, cursor: str | None
    ) -> RequestPage:
        """Newest first. `limit` above the maximum is capped, not refused."""
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        before = _decode_cursor(cursor) if cursor else None
        rows = await self._requests.page_of_customer(user.id, size + 1, before)
        page, more = rows[:size], len(rows) > size
        counts = await self._requests.media_counts([row.id for row in page])
        items = [
            RequestSummary(
                id=row.id,
                public_code=row.public_code,
                status=row.status,
                customer_status=REQUEST_CUSTOMER_STATUS[row.status],
                category_id=row.category_id,
                created_at=row.created_at,
                media_count=counts.get(row.id, 0),
            )
            for row in page
        ]
        next_cursor = _encode_cursor(page[-1]) if more and page else None
        return RequestPage(items=items, next_cursor=next_cursor)

    async def _intake_answers(
        self, category_id: uuid.UUID | None, answers: dict[str, JsonValue]
    ) -> dict[str, JsonValue]:
        """The answers checked against the category's questions, normalized. Without a
        category there is nothing to answer (the BDC classifies the request)."""
        if category_id is None:
            if answers:
                logger.info("intake_answers_invalid", extra={"failed": [], "unknown": len(answers)})
                raise InvalidIntakeAnswersError
            return {}
        try:
            questions = await self._categories.intake_questions(category_id)
        except BrokenIntakeQuestionsError:
            raise InvalidCategoryError from None  # logged by the category service
        if questions is None:
            raise InvalidCategoryError
        try:
            return validate_answers(questions, answers)
        except InvalidAnswersError as error:
            # Question keys come from the category; the caller's unknown keys are only counted.
            logger.info(
                "intake_answers_invalid",
                extra={
                    "category_id": str(category_id),
                    "failed": error.failed,
                    "unknown": error.unknown,
                },
            )
            raise InvalidIntakeAnswersError from None

    def _media_kinds(
        self, user: UserAccount, keys: list[str]
    ) -> list[tuple[str, RequestMediaKind]]:
        """(key, kind) per key; any problem is the same invalid_media, whatever the key."""
        if len(keys) > self._config.media_max_items or len(set(keys)) != len(keys):
            raise InvalidMediaError
        kinds: list[tuple[str, RequestMediaKind]] = []
        for key in keys:
            upload = owned_upload(key, user.id, UploadPurpose.REQUEST_MEDIA)
            if upload is None:
                raise InvalidMediaError
            kind = (
                RequestMediaKind.VIDEO
                if upload.content_type.startswith("video/")
                else RequestMediaKind.PHOTO
            )
            kinds.append((key, kind))
        return kinds

    async def _detail(self, request: ServiceRequest) -> RequestOut:
        address = await self._addresses.get(request.address_id)
        if address is None:  # pragma: no cover - the foreign key guarantees it
            raise RuntimeError("request without address")
        ttl = self._config.media_url_ttl_seconds
        expires_at = datetime.now(UTC) + timedelta(seconds=ttl)
        media = [
            MediaOut(
                kind=row.kind,
                url=self._storage.presign_get(row.file_key, ttl),
                expires_at=expires_at,
            )
            for row in await self._requests.media_of(request.id)
        ]
        return RequestOut(
            id=request.id,
            public_code=request.public_code,
            status=request.status,
            customer_status=REQUEST_CUSTOMER_STATUS[request.status],
            category_id=request.category_id,
            description=request.description,
            address=address,
            preferred_date=request.preferred_date,
            intake_answers=request.intake_answers,
            media=media,
            created_at=request.created_at,
        )


def _encode_cursor(request: ServiceRequest) -> str:
    raw = f"{request.created_at.isoformat()}|{request.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created_at, request_id = raw.split("|")
        decoded = datetime.fromisoformat(created_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        # In UTC here, so a timestamp the database cannot hold fails as a 422, not a 500.
        return decoded.astimezone(UTC), uuid.UUID(request_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidRequestError from None


def _intake_size(answers: dict[str, JsonValue]) -> int:
    """UTF-8 size of the compact JSON. Values Postgres JSONB refuses (NaN, Infinity, U+0000,
    lone surrogates) are a validation error here rather than a 500 at insert time."""
    try:
        encoded = json.dumps(
            answers, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode()
    except ValueError:  # NaN/Infinity, and UnicodeEncodeError (a subclass) for surrogates
        raise InvalidRequestError from None
    if _has_nul(answers):
        raise InvalidRequestError
    return len(encoded)


def _has_nul(value: JsonValue) -> bool:
    if isinstance(value, str):
        return "\x00" in value
    if isinstance(value, dict):
        return any("\x00" in key or _has_nul(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_has_nul(item) for item in value)
    return False


class CustomerRequestReader:
    """A customer's own request for other modules (ADR 0003): its status, for the quotes the
    customer compares (#188)."""

    def __init__(self, session: AsyncSession) -> None:
        self._requests = ServiceRequestRepository(session)

    async def own_status(self, user: UserAccount, request_id: uuid.UUID) -> RequestStatus:
        """The status of the caller's request. 404 for an unknown request and for another
        customer's, the same body as GET /requests/{id}: an id reveals nothing."""
        request = await self._requests.get(request_id)
        if request is None:
            raise NotFoundError
        ensure_owner(request.customer_id, user)
        return request.status


# What a pro sees before a job (#49): the work, the place coarsely, never the customer.
OPEN_FOR_QUOTES: Final = frozenset({RequestStatus.FINDING_PRO, RequestStatus.QUOTE_READY})


@dataclass(frozen=True)
class RequestForPro:
    """A request as a dispatched pro may see it: no customer, contact, street, coordinates,
    attribution (utm) or BDC fields. The area is the ZIP and its service area's canonical city
    until the job is paid (#49), never the city the customer typed (#172). No
    media either: stored photos and videos carry the customer's id in their keys and their
    original metadata (GPS), so pros get sanitized copies only, with #173.

    The customer's free text is redacted (app.redaction): their own email, phone and street are
    masked first in any formatting, then every contact pattern, in the description and in every
    string of the answers (whatever the question's current type: questions are editable, so it
    proves nothing about an old answer). A pro cannot reach the customer before payment. The
    stored text is unchanged; the customer and staff still see it as written."""

    id: uuid.UUID
    public_code: str
    category_id: uuid.UUID | None
    description: str  # redacted
    intake_answers: dict[str, JsonValue]  # every string redacted
    preferred_date: date | None
    area: AddressArea
    description_redacted: bool  # something was masked in the description
    answers_redacted: bool  # something was masked in the answers

    @property
    def text_redacted(self) -> bool:
        return self.description_redacted or self.answers_redacted


class ProRequestReader:
    """Read-only access for the pro opportunities (#49), through this module (ADR 0003)."""

    def __init__(self, session: AsyncSession) -> None:
        self._requests = ServiceRequestRepository(session)
        self._addresses = AddressService(session)
        self._users = UserService(session)
        self._service_areas = ServiceAreaService(session)

    @staticmethod
    def open_ids() -> Select[uuid.UUID]:
        """The requests pros can still quote on (finding_pro, quote_ready), as a subquery."""
        return ServiceRequestRepository.ids_with_status(OPEN_FOR_QUOTES)

    async def open_views(
        self, request_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, RequestForPro]:
        """The requests among `request_ids` still open for quotes, as a pro may see them, with
        contact details masked in the free text (see RequestForPro)."""
        rows = [
            r for r in await self._requests.get_many(request_ids) if r.status in OPEN_FOR_QUOTES
        ]
        zip_codes = await self._addresses.zip_codes([r.address_id for r in rows])
        cities = await self._service_areas.canonical_cities(zip_codes.values())
        # What each customer's own details are, read once per page, for the known-value pass.
        streets = await self._addresses.street_lines([r.address_id for r in rows])
        contacts = await self._users.contact_points([r.customer_id for r in rows])
        views: dict[uuid.UUID, RequestForPro] = {}
        for row in rows:
            contact = contacts.get(row.customer_id)
            known = KnownValues(
                emails=(contact.email,) if contact else (),
                phones=(contact.phone,) if contact and contact.phone else (),
                streets=streets.get(row.address_id, ()),
            )
            description = redact_text(row.description, known)
            answers, answers_redacted = _redact_answers(row.intake_answers, known)
            views[row.id] = RequestForPro(
                id=row.id,
                public_code=row.public_code,
                category_id=row.category_id,
                description=description.text,
                intake_answers=answers,
                preferred_date=row.preferred_date,
                area=self._area(row.id, zip_codes[row.address_id], cities),
                description_redacted=description.redacted,
                answers_redacted=answers_redacted,
            )
        return views

    @staticmethod
    def _area(request_id: uuid.UUID, zip_code: str, cities: Mapping[str, str]) -> AddressArea:
        """The 5-digit ZIP and its service area's city; no city when the area is gone (an
        inactive or deleted ZIP), never the customer's own text."""
        zip_code = zip5(zip_code)
        city = cities.get(zip_code)
        if city is None:
            logger.warning(
                "opportunity_city_missing", extra={"service_request_id": str(request_id)}
            )
        return AddressArea(zip_code=zip_code, city=city)


def _redact_answers(
    answers: Mapping[str, JsonValue], known: KnownValues
) -> tuple[dict[str, JsonValue], bool]:
    """The answers with contact details masked in every string, at any depth. Numbers and
    booleans pass; a short option value passes the redactor unchanged."""
    redacted: dict[str, JsonValue] = {}
    masked = False
    for key, value in answers.items():
        redacted[key], hit = _redact_value(value, known)
        masked = masked or hit
    return redacted, masked


def _redact_value(value: JsonValue, known: KnownValues) -> tuple[JsonValue, bool]:
    if isinstance(value, str):
        result = redact_text(value, known)
        return result.text, result.redacted
    if isinstance(value, list):
        items = [_redact_value(item, known) for item in value]
        return [item for item, _ in items], any(hit for _, hit in items)
    if isinstance(value, dict):
        entries = {key: _redact_value(item, known) for key, item in value.items()}
        return (
            {key: item for key, (item, _) in entries.items()},
            any(hit for _, hit in entries.values()),
        )
    return value, False
