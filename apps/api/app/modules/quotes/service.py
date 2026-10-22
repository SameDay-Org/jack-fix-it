"""Quote submission by a dispatched pro (D9.3, #50).

A pro quotes through their own dispatch. After locking the request (the state machine's row
lock, so two quotes on one request take turns) it checks, in this order:
- the dispatch is the caller's own: else 404, the same body as the opportunities (#49);
- the pro has not quoted this request yet: else 409 quote_exists;
- the dispatch is active (sent, viewed) and the request open for quotes (finding_pro,
  quote_ready): else 409 not_quotable;
- the quote TTL is set (settings `quote_ttl_hours`, no default): else 503 not_configured;
- the amount and the duration are within the platform's caps, when set: else 422.
Then, in the caller's transaction: the quote (pending, expires_at = now + TTL), the dispatch
marked quoted, and the first quote moves the request from finding_pro to quote_ready (SYSTEM).
The amount is the pro's own price in cents, stored as given; fees are #58.
Logs carry ids only: never the scope text or the amount.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.modules.dispatch.service import DispatchService
from app.modules.jobs.service import SYSTEM
from app.modules.pros.service import ProService
from app.modules.quotes.errors import NotQuotableError, QuoteExistsError, QuoteOutOfBoundsError
from app.modules.quotes.models import Quote
from app.modules.quotes.repository import QuoteRepository
from app.modules.quotes.schemas import QuoteCreate, QuoteOut
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.settings.errors import SettingNotConfiguredError
from app.modules.settings.service import QUOTE_TTL_HOURS, SettingsService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

_OPEN_FOR_QUOTES: Final = frozenset({RequestStatus.FINDING_PRO, RequestStatus.QUOTE_READY})


class QuoteService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._quotes = QuoteRepository(session)
        self._dispatches = DispatchService(session)
        self._requests = RequestStateMachine(session)
        self._settings = SettingsService(session)
        self._pros = ProService(session)

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
        return QuoteOut.model_validate(quote, from_attributes=True)

    async def _check_caps(self, data: QuoteCreate) -> None:
        max_amount = await self._settings.quote_max_amount_cents()
        max_duration = await self._settings.quote_max_duration_minutes()
        if (max_amount is not None and data.amount_cents > max_amount) or (
            max_duration is not None and data.duration_minutes > max_duration
        ):
            raise QuoteOutOfBoundsError
