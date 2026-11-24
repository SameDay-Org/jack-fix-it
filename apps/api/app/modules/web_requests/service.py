"""Requests made on the web without an account (#86): leads for the BDC, never bookings.

The web app's server sends each one (app.web_service: its key, then its visitor's address).
A served ZIP makes:

- a guest customer (users: status guest, holding no contact);
- the request, origin web, received, in the BDC's queue. It is never dispatched in the MVP:
  no pro could have a quote accepted without an account. The BDC classifies it, calls, and
  the customer requests again in the app;
- its web contact (models.WebRequestContact): staff only.

An unserved ZIP makes no request: the contact joins that ZIP's waitlist (the waitlist's own
rules), and the answer is 409 out_of_area.

Every create carries an Idempotency-Key, unique across web requests. The same key again
answers the same code and writes nothing. Two creates racing with one key meet at its unique
index: the second's writes roll back, and it answers the first's code. The same key with
another body is a 409.

A filled honeypot answers as a create would, with a code that names nothing, and stores
nothing. Logs carry ids only: never a name, an email, a phone or a key.
"""

import logging
import secrets
import uuid
from collections.abc import Collection
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.idempotency import body_fingerprint, same_body
from app.modules.requests.queue import RequestStatus
from app.modules.requests.service import (
    CustomerRequestReader,
    ServiceRequestService,
    WebLead,
)
from app.modules.service_areas.service import ServiceAreaService
from app.modules.users.service import UserService
from app.modules.waitlist.errors import InvalidPhoneNumberError, ZipServedError
from app.modules.waitlist.schemas import WaitlistJoin
from app.modules.waitlist.service import WaitlistService
from app.modules.web_requests.errors import OutOfAreaError, WebRequestKeyReusedError
from app.modules.web_requests.models import IDEMPOTENCY_KEY_UNIQUE, WebRequestContact
from app.modules.web_requests.repository import WebRequestContactRepository
from app.modules.web_requests.schemas import WebRequestCreated, WebRequestIn

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WebContact:
    """Who to call about a web request (#86), for the BDC's card only."""

    first_name: str
    email: str
    phone: str


def contact_of(row: WebRequestContact) -> WebContact:
    return WebContact(first_name=row.first_name, email=row.email, phone=row.phone)


class WebRequestContacts:
    """The web contacts of requests, for the operations queue (staff only; ADR 0003)."""

    def __init__(self, session: AsyncSession) -> None:
        self._contacts = WebRequestContactRepository(session)

    async def of_requests(self, request_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, WebContact]:
        return {
            row.request_id: contact_of(row) for row in await self._contacts.of_requests(request_ids)
        }


class WebRequestService:
    def __init__(
        self,
        session: AsyncSession,
        requests: ServiceRequestService,
        service_areas: ServiceAreaService,
        waitlist: WaitlistService,
        allowed_country_codes: list[str],
    ) -> None:
        self._session = session
        self._requests = requests
        self._service_areas = service_areas
        self._waitlist = waitlist
        self._allowed_country_codes = tuple(allowed_country_codes)
        self._users = UserService(session)
        self._codes = CustomerRequestReader(session)
        self._contacts = WebRequestContactRepository(session)

    async def create(self, data: WebRequestIn, key: uuid.UUID) -> WebRequestCreated:
        """See the module doc. Commits; queues the address's geocoding once committed."""
        if data.website:
            # A bot filled what people never see: the same answer, nothing stored.
            logger.info("web_request_honeypot")
            return _created(f"JF-{secrets.randbelow(1_000_000):06d}")
        fingerprint = body_fingerprint(data)
        earlier = await self._contacts.by_key(key)
        if earlier is not None:
            return await self._replay(earlier, fingerprint)
        if not data.contact.phone.startswith(self._allowed_country_codes):
            raise InvalidPhoneNumberError
        if not await self._service_areas.is_served(data.address.zip_code):
            await self._join_waitlist(data)

        savepoint = await self._session.begin_nested()
        try:
            guest = await self._users.create_guest(data.locale)
            created = await self._requests.create_web_lead(guest, _lead(data))
            await self._contacts.add(
                WebRequestContact(
                    request_id=created.request_id,
                    first_name=data.contact.first_name,
                    email=data.contact.email,
                    phone=data.contact.phone,
                    consent_version=data.consent_version,
                    idempotency_key=key,
                    idempotency_fingerprint=fingerprint,
                )
            )
        except IntegrityError as error:
            await savepoint.rollback()  # no guest, address or request of this call stays
            if violated_constraint(error) != IDEMPOTENCY_KEY_UNIQUE:
                raise
            # A create with the same key got there first: its request is the answer.
            winner = await self._contacts.by_key(key)
            if winner is None:  # pragma: no cover - a web request is never deleted
                raise
            return await self._replay(winner, fingerprint)
        except Exception:
            await savepoint.rollback()
            raise
        await savepoint.commit()
        await self._session.commit()
        logger.info("web_request_created", extra={"service_request_id": str(created.request_id)})
        await self._requests.queue_geocode(created.request_id, created.address_id)
        return _created(created.public_code)

    async def _join_waitlist(self, data: WebRequestIn) -> None:
        """No request for an unserved ZIP: the contact joins its waitlist (and the waitlist
        commits), then 409 out_of_area. Served meanwhile: the request is made after all."""
        join = WaitlistJoin.model_validate(
            {
                "zip_code": data.address.zip_code,
                "email": data.contact.email,
                "phone": data.contact.phone,
                "category_id": data.category_id,
                "locale": data.locale,
                "source": "web",
            }
        )
        try:
            await self._waitlist.join(join, None)
        except ZipServedError:
            return
        logger.info("web_request_out_of_area")
        raise OutOfAreaError

    async def _replay(self, earlier: WebRequestContact, fingerprint: str) -> WebRequestCreated:
        if not same_body(earlier.idempotency_fingerprint, fingerprint):
            logger.info("web_request_key_reused")
            raise WebRequestKeyReusedError
        logger.info("web_request_replayed", extra={"service_request_id": str(earlier.request_id)})
        return _created(await self._codes.public_code(earlier.request_id))


def _lead(data: WebRequestIn) -> WebLead:
    return WebLead(
        description=data.description,
        category_id=data.category_id,
        address=data.address,
        preferred_date=data.preferred_date,
        preferred_period=data.preferred_period,
        intake_answers=data.intake_answers,
        utm=data.utm,
    )


def _created(public_code: str) -> WebRequestCreated:
    return WebRequestCreated(public_code=public_code, status=RequestStatus.RECEIVED)
