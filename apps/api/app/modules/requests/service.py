"""Service requests (D8.1, #42): a customer asks for a service and follows it.

Create validates everything before writing, then stores the address, the request and its
media in one transaction (one savepoint): a failure leaves nothing behind. The server sets
origin (app), language (the caller's locale) and status (received); urgency and preferred
contact are not accepted from the client yet (#45 defines their values).

After the commit, create queues dispatch (#48) for the worker, then, when the request has
media, the privacy-safe copy of its photos and videos (#173); a failed or slow enqueue is
logged and never fails the request (the BDC can dispatch it again).

A create may carry an Idempotency-Key (#264), a UUID the app makes once per draft. Within
REQUEST_IDEMPOTENCY_WINDOW_SECONDS a repeat of the customer's key answers the request it made
(200, not 201) and does nothing else; the same key with another body is a 409. Two creates
racing with one key insert one request: the unique index makes the second wait for the first,
then answer its request. Keys are per customer.

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
from app.db import violated_constraint
from app.errors import NotFoundError
from app.idempotency import body_fingerprint, same_body
from app.integrations.storage import Storage
from app.modules.addresses.schemas import AddressArea, AddressOut
from app.modules.addresses.service import AddressPlace, AddressService
from app.modules.auth.permissions import ensure_owner
from app.modules.categories.intake import InvalidAnswersError, validate_answers
from app.modules.categories.service import BrokenIntakeQuestionsError, CategoryService
from app.modules.dispatch.service import enqueue_dispatch
from app.modules.requests.customer_status import REQUEST_CUSTOMER_STATUS
from app.modules.requests.errors import (
    IdempotencyKeyReusedError,
    InvalidCategoryError,
    InvalidIntakeAnswersError,
    InvalidMediaError,
    InvalidRequestError,
    ZipNotServedError,
)
from app.modules.requests.media_copies import enqueue_sanitize
from app.modules.requests.models import (
    IDEMPOTENCY_KEY_INDEX,
    MediaSafeStatus,
    RequestMedia,
    RequestOrigin,
    RequestStatus,
    ServiceRequest,
)
from app.modules.requests.models import (
    # Part of this service's interface (SafeMedia.kind, RequestForPro.preferred_period): other
    # modules take them from here, never from requests.models (ADR 0003).
    PreferredPeriod as PreferredPeriod,
)
from app.modules.requests.models import (
    RequestMediaKind as RequestMediaKind,
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
from app.modules.uploads.keys import owned_upload
from app.modules.uploads.schemas import UploadPurpose
from app.modules.users.service import UserService
from app.modules.users.types import ContactPoints, UserAccount
from app.queue import JobQueue
from app.redaction import KnownValues, redact_address_contacts, redact_text

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RequestConfig:
    intake_max_bytes: int
    media_max_items: int
    list_default_limit: int
    list_max_limit: int
    media_url_ttl_seconds: int
    enqueue_timeout_seconds: float
    idempotency_window_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "RequestConfig":
        return cls(
            intake_max_bytes=settings.request_intake_max_bytes,
            media_max_items=settings.request_media_max_items,
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            media_url_ttl_seconds=settings.download_url_ttl_seconds,
            enqueue_timeout_seconds=settings.job_enqueue_timeout_seconds,
            idempotency_window_seconds=settings.request_idempotency_window_seconds,
        )


@dataclass(frozen=True)
class CreatedRequest:
    """What a create answers: the request, and whether this call made it (False when an
    earlier create with the same Idempotency-Key did)."""

    request: RequestOut
    created: bool


@dataclass(frozen=True)
class _Idempotency:
    key: uuid.UUID
    fingerprint: str


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

    async def create(
        self, user: UserAccount, data: RequestCreate, idempotency_key: uuid.UUID | None = None
    ) -> CreatedRequest:
        """Without a key, every call makes a request. With one, a request the customer made
        with it within the window is answered before anything else is checked (a retry the
        next day must not fail on a date that has since passed, or on media it already
        attached), and nothing is written or queued. The answer is that same request with
        its current status and freshly signed media URLs, never a stored copy of the first
        answer: a retry must not hand back a stale status or an expired URL."""
        idempotency = (
            None
            if idempotency_key is None
            else _Idempotency(key=idempotency_key, fingerprint=_fingerprint(data))
        )
        expired: ServiceRequest | None = None
        if idempotency is not None:
            earlier = await self._requests.by_idempotency_key(user.id, idempotency.key)
            if earlier is not None:
                window = timedelta(seconds=self._config.idempotency_window_seconds)
                if earlier.created_at > datetime.now(UTC) - window:
                    return await self._replay(user, earlier, idempotency.fingerprint)
                expired = earlier
        if data.preferred_date is not None and data.preferred_date < datetime.now(UTC).date():
            raise InvalidRequestError
        preferred_period = _stored_period(data.preferred_date, data.preferred_period)
        if _intake_size(data.intake_answers) > self._config.intake_max_bytes:
            raise InvalidRequestError
        if not await self._service_areas.is_served(data.address.zip_code):
            raise ZipNotServedError
        intake_answers = await self._intake_answers(data.category_id, data.intake_answers)
        media_kinds = self._media_kinds(user, data.media_keys)

        savepoint = await self._session.begin_nested()
        try:
            if expired is not None:
                # The key's request is older than the window: the key no longer answers with
                # it, and the unique index would refuse it to the new request.
                await self._requests.release_idempotency_key(expired)
            address_id = await self._addresses.create(user.id, data.address)
            request = await self._requests.add(
                ServiceRequest(
                    customer_id=user.id,
                    category_id=data.category_id,
                    address_id=address_id,
                    description=data.description,
                    intake_answers=intake_answers,
                    preferred_date=data.preferred_date,
                    preferred_period=preferred_period,
                    language=user.locale,
                    origin=RequestOrigin.APP,
                    utm=data.utm.model_dump(exclude_none=True) if data.utm else None,
                    idempotency_key=idempotency and idempotency.key,
                    idempotency_fingerprint=idempotency and idempotency.fingerprint,
                )
            )
            await self._requests.add_media(
                [
                    RequestMedia(request_id=request.id, kind=kind, file_key=key)
                    for key, kind in media_kinds
                ]
            )
        except IntegrityError as error:
            await savepoint.rollback()  # nothing of this call stays: no address, no media
            if idempotency is not None and violated_constraint(error) == IDEMPOTENCY_KEY_INDEX:
                # A create with the same key got there first: the index held this insert until
                # that one committed. Its request is the answer, whatever its age (it is new).
                winner = await self._requests.by_idempotency_key(user.id, idempotency.key)
                if winner is None:  # pragma: no cover - requests are never deleted
                    raise
                return await self._replay(user, winner, idempotency.fingerprint)
            # A media key already attached to another request (uq_request_media_file_key).
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
        return CreatedRequest(request=await self._detail(request), created=True)

    async def _replay(
        self, user: UserAccount, earlier: ServiceRequest, fingerprint: str
    ) -> CreatedRequest:
        """The request an earlier create with the same key made, when the body is the same
        (fingerprints compared in constant time); 409 when it is not. Logs never carry the key."""
        if not same_body(earlier.idempotency_fingerprint, fingerprint):
            logger.info("request_idempotency_key_reused", extra={"user_id": str(user.id)})
            raise IdempotencyKeyReusedError
        logger.info(
            "request_replayed",
            extra={"service_request_id": str(earlier.id), "user_id": str(user.id)},
        )
        return CreatedRequest(request=await self._detail(earlier), created=False)

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
            preferred_period=request.preferred_period,
            intake_answers=request.intake_answers,
            media=media,
            created_at=request.created_at,
        )


def _fingerprint(data: RequestCreate) -> str:
    """The body's fingerprint (app.idempotency). Text with no UTF-8 form (a lone surrogate,
    which the schema lets through in intake answers and media keys) is the validation error a
    create without a key answers too, raised before the key is looked up, so the key stays
    unused."""
    try:
        return body_fingerprint(data)
    except UnicodeEncodeError:
        raise InvalidRequestError from None


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


def _stored_period(day: date | None, period: PreferredPeriod | None) -> PreferredPeriod | None:
    """The period to store (#237): flexible by default with a date; without one the customer
    is flexible, stored as None, and a specific period has nothing to refine."""
    if day is not None:
        return period or PreferredPeriod.FLEXIBLE
    if period not in (None, PreferredPeriod.FLEXIBLE):
        raise InvalidRequestError
    return None


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
    customer compares (#188), its public code, for the job pushes (#65), and where it takes
    place, for the route to it (#351)."""

    def __init__(self, session: AsyncSession) -> None:
        self._requests = ServiceRequestRepository(session)
        self._addresses = AddressService(session)

    async def own_status(self, user: UserAccount, request_id: uuid.UUID) -> RequestStatus:
        """The status of the caller's request. 404 for an unknown request and for another
        customer's, the same body as GET /requests/{id}: an id reveals nothing."""
        request = await self._requests.get(request_id)
        if request is None:
            raise NotFoundError
        ensure_owner(request.customer_id, user)
        return request.status

    async def public_code(self, request_id: uuid.UUID) -> str:
        """The request's public code, the only request detail a push shows (#65). The caller
        already holds the request's job, so the request exists."""
        request = await self._requests.get(request_id)
        if request is None:  # pragma: no cover - jobs.request_id is a foreign key
            raise NotFoundError
        return request.public_code

    async def place(self, request_id: uuid.UUID) -> AddressPlace:
        """Where the request takes place, for the route of its job (#351). The caller already
        holds the request's job and checked whose it is: this does not."""
        request = await self._requests.get(request_id)
        place = None if request is None else await self._addresses.place(request.address_id)
        if place is None:  # pragma: no cover - both ids are foreign keys
            raise NotFoundError
        return place


# What a pro sees before a job (#49): the work, the place coarsely, never the customer.
OPEN_FOR_QUOTES: Final = frozenset({RequestStatus.FINDING_PRO, RequestStatus.QUOTE_READY})


@dataclass(frozen=True)
class RequestForPro:
    """A request as a dispatched pro may see it: no customer, contact, street, coordinates,
    attribution (utm) or BDC fields. The area is the ZIP and its service area's canonical city
    until the job is paid (#49), never the city the customer typed (#172). No media here:
    stored photos and videos carry the customer's id in their keys and their original metadata
    (GPS), so pros get the privacy-safe copies only, through ProRequestReader.safe_media (#173).

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
    preferred_period: PreferredPeriod | None
    area: AddressArea
    description_redacted: bool  # something was masked in the description
    answers_redacted: bool  # something was masked in the answers

    @property
    def text_redacted(self) -> bool:
        return self.description_redacted or self.answers_redacted


@dataclass(frozen=True)
class RequestForJob:
    """A request as the pro of its paid job sees it (#63): the opportunity's view (RequestForPro:
    the free text still redacted, no customer or contact) plus the whole address, which they need
    to get there, with the contacts typed into it masked (_address_for_pro). No coordinates."""

    view: RequestForPro
    address: AddressOut


@dataclass(frozen=True)
class SafeMedia:
    """A photo or video's privacy-safe copy (#173), as a pro may be shown it. It has no
    original key (file_key), so nothing built on it can sign the customer's file. The key is
    the row's as stored: the signer still checks it (opportunities.sign_safe_media)."""

    id: uuid.UUID
    kind: RequestMediaKind
    safe_key: str | None
    content_type: str | None


@dataclass(frozen=True)
class ProMedia:
    """A request's media for a pro (#173): the ready safe copies, oldest first, and how many
    are still being made. A failed copy is neither listed nor counted: it is never served."""

    ready: tuple[SafeMedia, ...]
    pending: int


def _address_for_pro(address: AddressOut, contact: ContactPoints | None) -> AddressOut:
    """The address as the pro of the paid job sees it (#63): every field with the contacts a
    customer typed into it masked (the customer's own email and phone first, then the contact
    patterns), the address itself kept: they need it to get there. The customer's own views
    show it as typed."""
    known = KnownValues(
        emails=(contact.email,) if contact else (),
        phones=(contact.phone,) if contact and contact.phone else (),
    )

    def masked(value: str) -> str:
        return redact_address_contacts(value, known).text

    return AddressOut(
        line1=masked(address.line1),
        line2=masked(address.line2) if address.line2 is not None else None,
        city=masked(address.city),
        state=masked(address.state),
        zip_code=masked(address.zip_code),
    )


def media_keys_among(keys: Collection[str]) -> Select[str]:
    """The upload keys among `keys` that a request's media hold, as a statement: the uploads
    module's sweep of unreferenced uploads (#191) runs it with the other referencing columns."""
    return ServiceRequestRepository.media_keys_among(keys)


class ProRequestReader:
    """Read-only access for the pro opportunities (#49) and the pro's jobs (#63), through this
    module (ADR 0003)."""

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
        return await self._views(rows)

    async def job_views(self, request_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, RequestForJob]:
        """The requests among `request_ids`, whatever their status, as the pro of their paid job
        sees them (#63): the opportunity's view and the full address. Call it for the caller's
        own jobs only: it does not check that."""
        rows = await self._requests.get_many(request_ids)
        contacts = await self._users.contact_points([r.customer_id for r in rows])
        views = await self._views(rows, contacts)
        addresses = await self._addresses.full_many([r.address_id for r in rows])
        return {
            row.id: RequestForJob(
                view=views[row.id],
                address=_address_for_pro(addresses[row.address_id], contacts.get(row.customer_id)),
            )
            for row in rows
        }

    async def _views(
        self,
        rows: list[ServiceRequest],
        contacts: Mapping[uuid.UUID, ContactPoints] | None = None,
    ) -> dict[uuid.UUID, RequestForPro]:
        zip_codes = await self._addresses.zip_codes([r.address_id for r in rows])
        cities = await self._service_areas.canonical_cities(zip_codes.values())
        # What each customer's own details are, read once per page, for the known-value pass.
        streets = await self._addresses.street_lines([r.address_id for r in rows])
        if contacts is None:
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
                preferred_period=row.preferred_period,
                area=self._area(row.id, zip_codes[row.address_id], cities),
                description_redacted=description.redacted,
                answers_redacted=answers_redacted,
            )
        return views

    async def safe_media(self, request_id: uuid.UUID) -> ProMedia:
        """The request's media as a pro may see it (ProMedia), in one statement. Call it for a
        request the pro may open: it does not check that."""
        rows = await self._requests.safe_media_of(request_id)
        return ProMedia(
            ready=tuple(
                SafeMedia(
                    id=row.id,
                    kind=row.kind,
                    safe_key=row.safe_key,
                    content_type=row.safe_content_type,
                )
                for row in rows
                if row.safe_status is MediaSafeStatus.READY
            ),
            pending=sum(row.safe_status is MediaSafeStatus.PENDING for row in rows),
        )

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
