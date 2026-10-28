"""Quotes: a dispatched pro submits one (D9.3, #50); the customer compares them (D10.1, #188).

A pro quotes through their own dispatch. After locking the request (the state machine's row
lock, so two quotes on one request take turns) it checks, in this order:
- the dispatch is the caller's own: else 404, the same body as the opportunities (#49);
- the pro has not quoted this request yet: else 409 quote_exists;
- the dispatch is active (sent, viewed) and the request open for quotes (finding_pro,
  quote_ready): else 409 not_quotable;
- the quote TTL is set (settings `quote_ttl_hours`, no default): else 503 not_configured;
- the amount and the duration are within the platform's caps, when set: else 422. A cap set
  to an invalid value is not "no cap": 503 not_configured, like a missing TTL.
Then, in the caller's transaction: the quote (pending, expires_at = now + TTL), the dispatch
marked quoted, and the first quote moves the request from finding_pro to quote_ready (SYSTEM).
Once that commits, the customer gets a new quote push (#55); a push that cannot be queued is
logged, never undone.
The amount is the pro's own price in cents, stored as given; fees are #58.

The customer reads the quotes of their own request (else 404, the same body as the request
itself) while it shows the quote screen (quote_ready, and accepted while the payment is
pending: docs/glossary.md); any other status lists nothing. Listed: the accepted quote and the
pending ones before their expires_at, whether or not the expiry worker (#51) has marked them.
Contacts stay hidden before payment, so the scope is redacted (app.redaction): the pro's own
email and phone first, then every pattern. The stored scope is unchanged. The pro's public
name goes through the same check and is withheld (null) when it shows a contact (#194).

Logs carry ids only: never the scope text or the amount.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.modules.dispatch.service import DispatchService
from app.modules.jobs.service import SYSTEM
from app.modules.notifications.events import push_new_quote
from app.modules.pros.service import ProService
from app.modules.quotes.errors import NotQuotableError, QuoteExistsError, QuoteOutOfBoundsError
from app.modules.quotes.models import Quote
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import (
    CustomerQuote,
    CustomerQuoteList,
    QuoteCreate,
    QuoteOut,
    QuotePro,
)
from app.modules.requests.service import CustomerRequestReader
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.settings.errors import SettingMalformedError, SettingNotConfiguredError
from app.modules.settings.service import QUOTE_TTL_HOURS, SettingsService
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.queue import JobQueue
from app.redaction import KnownValues, redact_text

logger = logging.getLogger(__name__)

_OPEN_FOR_QUOTES: Final = frozenset({RequestStatus.FINDING_PRO, RequestStatus.QUOTE_READY})
# Where the customer sees the quote screen: "accepted" keeps it while the payment is pending.
_QUOTE_SCREEN: Final = frozenset({RequestStatus.QUOTE_READY, RequestStatus.ACCEPTED})


class QuoteService:
    def __init__(
        self, session: AsyncSession, queue: JobQueue, enqueue_timeout_seconds: float
    ) -> None:
        self._session = session
        self._queue = queue
        self._enqueue_timeout = enqueue_timeout_seconds
        self._quotes = QuoteRepository(session)
        self._dispatches = DispatchService(session)
        self._requests = RequestStateMachine(session)
        self._settings = SettingsService(session)
        self._pros = ProService(session)
        self._customer_requests = CustomerRequestReader(session)
        self._users = UserService(session)

    async def submit(
        self, user: UserAccount, dispatch_id: uuid.UUID, data: QuoteCreate
    ) -> QuoteOut:
        """Creates the pro's quote on a dispatched request and commits (see the module doc)."""
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        found = await self._dispatches.pro_dispatch(dispatch_id, pro_id) if pro_id else None
        if pro_id is None or found is None:
            raise NotFoundError
        request = await self._requests.lock(found.request_id)
        # Read again under the request's lock: what another quote may have changed meanwhile.
        dispatch = await self._dispatches.pro_dispatch(dispatch_id, pro_id)
        if request is None or dispatch is None:  # pragma: no cover - foreign keys hold them
            raise NotFoundError
        if await self._quotes.exists_for(request.id, pro_id):
            raise QuoteExistsError
        if not dispatch.active or request.status not in _OPEN_FOR_QUOTES:
            raise NotQuotableError
        ttl_hours = await self._settings.quote_ttl_hours()
        if ttl_hours is None:
            # Logged by the settings service (setting_invalid, the key only).
            logger.error("quote_not_configured", extra={"key": QUOTE_TTL_HOURS})
            raise SettingNotConfiguredError
        await self._check_caps(data)

        now = datetime.now(UTC)
        savepoint = await self._session.begin_nested()
        try:
            quote = await self._quotes.add(
                Quote(
                    request_id=request.id,
                    pro_id=pro_id,
                    amount_cents=data.amount_cents,
                    scope=data.scope,
                    duration_minutes=data.duration_minutes,
                    proposed_start_at=data.proposed_start_at,
                    expires_at=now + timedelta(hours=ttl_hours),
                )
            )
        except IntegrityError:
            # UNIQUE (request_id, pro_id): the backstop behind exists_for.
            await savepoint.rollback()
            raise QuoteExistsError from None
        await savepoint.commit()
        if not await self._dispatches.mark_quoted(dispatch.id, now):
            raise NotQuotableError  # pragma: no cover - checked above, under the request lock
        first = request.status is RequestStatus.FINDING_PRO
        if first:
            await self._requests.transition(request.id, RequestStatus.QUOTE_READY, SYSTEM)
        await self._session.commit()
        logger.info(
            "quote_submitted",
            extra={
                "quote_id": str(quote.id),
                "dispatch_id": str(dispatch.id),
                "service_request_id": str(request.id),
                "pro_id": str(pro_id),
                "first_quote": first,
            },
        )
        await push_new_quote(
            self._queue,
            customer_id=request.customer_id,
            quote_id=quote.id,
            request_id=request.id,
            public_code=request.public_code,
            timeout_seconds=self._enqueue_timeout,
        )
        return QuoteOut.model_validate(quote, from_attributes=True)

    async def list_for_customer(
        self, user: UserAccount, request_id: uuid.UUID
    ) -> CustomerQuoteList:
        """The quotes the customer compares on their own request (see the module doc). One
        query each for the request, its quotes, the pros, their names and their contact
        points, whatever the count."""
        status = await self._customer_requests.own_status(user, request_id)
        if status not in _QUOTE_SCREEN:
            return CustomerQuoteList(items=[])
        quotes = await self._quotes.open_of_request(request_id, datetime.now(UTC))
        cards = await self._pros.cards({quote.pro_id for quote in quotes})
        # The pros' own details, for the known-value pass only: never logged or returned.
        contacts = await self._users.contact_points({card.user_id for card in cards.values()})
        items: list[CustomerQuote] = []
        for quote in quotes:
            card = cards[quote.pro_id]
            contact = contacts.get(card.user_id)
            known = KnownValues(
                emails=(contact.email,) if contact else (),
                phones=(contact.phone,) if contact and contact.phone else (),
            )
            items.append(
                CustomerQuote(
                    id=quote.id,
                    amount_cents=quote.amount_cents,
                    scope=redact_text(quote.scope, known).text,
                    duration_minutes=quote.duration_minutes,
                    proposed_start_at=quote.proposed_start_at,
                    expires_at=quote.expires_at,
                    status=quote.status,
                    created_at=quote.created_at,
                    pro=QuotePro(
                        id=card.pro_id,
                        name=card.name,
                        rating_avg=(
                            None if card.rating_avg is None else format(card.rating_avg, ".2f")
                        ),
                        jobs_count=card.jobs_count,
                        years_of_experience=card.years_of_experience,
                        verified=card.verified,
                    ),
                )
            )
        return CustomerQuoteList(items=items)

    async def _check_caps(self, data: QuoteCreate) -> None:
        try:
            max_amount = await self._settings.quote_max_amount_cents()
            max_duration = await self._settings.quote_max_duration_minutes()
        except SettingMalformedError as error:
            # Logged by the settings service too (setting_invalid, the key only).
            logger.error("quote_not_configured", extra={"key": error.key})
            raise
        if (max_amount is not None and data.amount_cents > max_amount) or (
            max_duration is not None and data.duration_minutes > max_duration
        ):
            raise QuoteOutOfBoundsError


@dataclass(frozen=True)
class RequestExpiry:
    """What expiring one request's due quotes did."""

    expired: tuple[uuid.UUID, ...]  # the quotes this call expired, in id order
    backed_out: bool  # the request moved from quote_ready back to finding_pro


class QuoteExpiryService:
    """Quote expiry (D9.4, #51 part 1), for the worker's sweep (quotes/tasks.py).

    A quote expires when its expires_at passes without a decision (docs/glossary.md): a pending
    quote whose expires_at is the sweep's `now` or earlier. Under the request's row lock (the one
    a quote's submission and acceptance take, so they take turns with the sweep), its due quotes
    become expired with a conditional update. An accepted quote never does: its payment is
    pending (#58, #61). Then a quote_ready request with no pending or accepted quote left backs
    out to finding_pro (SYSTEM), in the same transaction; a run that comes second finds it in
    finding_pro already. A request in any other status keeps it. The caller owns the transaction.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._quotes = QuoteRepository(session)
        self._requests = RequestStateMachine(session)

    async def requests_due(
        self, now: datetime, after: uuid.UUID | None, limit: int
    ) -> list[uuid.UUID]:
        """Up to `limit` requests with a quote due at `now`, by id, after `after`."""
        return await self._quotes.requests_with_due_quotes(now, after, limit)

    async def expire_request(self, request_id: uuid.UUID, now: datetime) -> RequestExpiry:
        """Expires the request's quotes due at `now` and backs the request out when none is
        left (see the class doc). Flushes and never commits."""
        request = await self._requests.lock(request_id)
        if request is None:  # pragma: no cover - a quote's foreign key keeps its request
            return RequestExpiry((), backed_out=False)
        expired = tuple(await self._quotes.expire_due(request_id, now))
        backed_out = request.status is RequestStatus.QUOTE_READY and not (
            await self._quotes.has_live(request_id)
        )
        if backed_out:
            await self._requests.transition(request_id, RequestStatus.FINDING_PRO, SYSTEM)
        return RequestExpiry(expired, backed_out)
