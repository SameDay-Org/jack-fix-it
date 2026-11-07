"""Payments (D11.1, #58): the customer pays the quote they accepted (ADR 0005, ADR 0006).

After accepting a quote (#189) the app asks for a payment: the API creates the Stripe
PaymentIntent the Payment Sheet (#59) confirms, on the platform account (separate charges and
transfers, ADR 0005), for the customer's total, captured automatically (no pre-authorization,
ADR 0006). The money stays on the platform balance; the job is created by the webhook (#61)
once the payment succeeds, and the transfer to the pro follows the confirmation (#68).

Stripe must be configured (the secret and the publishable key): else 503 not_configured. Then,
on the customer's own request (else 404, the same body as the request) under its row lock (the
one acceptance takes, so two payment calls, or a payment and an acceptance, take turns) and the
quote's (else 404, the same body, for a quote of another request), in this order:
- the request is accepted and the quote is its accepted one: else 409 payment_not_available.
  A live payment (any status but canceled) that succeeded: 409 too (the job exists or is
  being created);
- the quote's pro can still be hired (approved, payouts enabled; Cesar's #189 decision:
  rechecked at payment, on every call): else 409 pro_not_hireable, nothing created, a warning
  with ids. Un-accepting the quote belongs to #61.
Then the quote's live payment row, or a new one: one per acceptance. A canceled payment (its
PaymentIntent closed; #61 reopened the quote) stays as history, and accepting the same quote
again makes a new row, with its own id, idempotency key and PaymentIntent; a partial unique
index on quote_id (status <> 'canceled') keeps a quote to one live payment. Every amount is
computed here from database values (AGENTS.md "Money"): the quote's amount; the platform's fee
and the pro's payout from app.money.split_amount at the current take rate (settings
platform_take_rate_bps; a malformed value is 503 not_configured, never a fee of 0); the tax, 0
in the MVP (Cesar, 2026-11-06; to confirm with the accountant before launch); the customer's
total, amount plus tax. It is committed before any Stripe call, with the id its idempotency key
derives from, so a lost answer leaves a row the retry sends the same key for (the #279 lesson),
and the commit releases the locks.

Stripe, in three calls:
- the customer's Stripe Customer, created once (key `customer:<user id>`, metadata user_id; no
  email or name) and stored on the user. Two first payments of one customer at once send the
  same key, Stripe answers both with one customer, and the first to store wins: the other reads
  the stored id back;
- the PaymentIntent, created once per payment under the payment row's lock (key
  `payment_intent:<payment id>`): the customer's total, usd, the customer, automatic payment
  methods without redirects (card, Apple Pay, Google Pay), automatic capture, no transfer_data
  or on_behalf_of, transfer_group `request:<request id>`, and the ids #61 reads in its
  metadata (payment_id, quote_id, request_id). Its id is stored and committed. A later call
  finds the id and retrieves the PaymentIntent instead, the lock released first; a concurrent
  call waits on the lock and finds the id too, so one PaymentIntent exists per payment.
  The first create's time (payment_intent_requested_at) is committed before the call. A
  retry after a lost create answer, within STRIPE_PAYMENT_INTENT_RECONCILE_AFTER_SECONDS of
  that time, sends the same key, and Stripe replays the same intent. Later Stripe may have
  forgotten the key (it keeps them at least 24 hours), so the retry creates nothing: it
  searches Stripe for the intents whose metadata names the payment and adopts the one match
  whose amount, currency and customer are the row's. No match, several, a mismatch or an
  incomplete search: 409 payment_needs_review, an ERROR payment_intent_ambiguous (ids and the
  count), the time kept. An empty search proves nothing (Search is eventually consistent, and
  a delayed create can still land), so the payment waits for staff:
  scripts/resolve_payment_intent.py adopts an intent or allows a new create (adopt_intent,
  allow_new_intent here). A payment_intent.* event for the lost intent adopts it first, from
  its metadata (#296, reconciliation.py).
  Stripe showing it succeeded or canceled: 409 payment_not_available, the row left to #61;
- an ephemeral key for the customer, new on every call.
The response is what the Payment Sheet needs plus what the customer sees: the amount, the tax
and the total; never the pro's payout or the platform's fee.

Stripe unreachable, a 409, 429 or 5xx: 503 payments_unavailable; any other 4xx: 502
payments_error. Nothing stored changes on either (the transaction is rolled back), and the
payment row and its create time stay for the retry. Logs carry ids only (payment, quote,
request, the customer's user id, Stripe's request id and error code): never a client secret,
an ephemeral key, a customer id or a PaymentIntent id.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS, Settings, is_publishable_key
from app.errors import NotFoundError
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import (
    PAYMENT_INTENT_CLOSED_STATUSES,
    PaymentIntentFacts,
    PaymentIntentState,
    StripePayments,
)
from app.modules.audit.service import AuditService
from app.modules.audit.types import (
    AuditAction,
    AuditEntity,
    AuditEntityType,
    AuditState,
    Operator,
    timestamp,
)
from app.modules.payments.errors import (
    PaymentNeedsReviewError,
    PaymentNotAvailableError,
    PaymentRecoveryRefusedError,
    PaymentsNotConfiguredError,
    ProNotHireableError,
)
from app.modules.payments.models import (
    CLOSED_STATUSES,
    CURRENCY,
    TAX_CENTS,
    Payment,
    PaymentStatus,
)
from app.modules.payments.repository import PaymentRepository
from app.modules.payments.schemas import PaymentSheetOut
from app.modules.payouts.errors import PaymentsProviderError, PaymentsUnavailableError
from app.modules.pros.service import ProService
from app.modules.quotes.service import QuoteReader
from app.modules.requests.service import CustomerRequestReader
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.settings.errors import SettingMalformedError
from app.modules.settings.service import SettingsService
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.money import split_amount

logger = logging.getLogger(__name__)

# How old an unresolved create must be before staff may allow a new one: Stripe may still
# answer its key until then.
STRIPE_KEY_RETENTION: Final = timedelta(seconds=STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS)
STRIPE_KEY_RETENTION_HOURS: Final = STRIPE_IDEMPOTENCY_KEY_RETENTION_SECONDS // 3600


def customer_idempotency_key(user_id: uuid.UUID) -> str:
    """The same key for every attempt to create this user's Stripe Customer."""
    return f"customer:{user_id}"


def payment_intent_idempotency_key(payment_id: uuid.UUID) -> str:
    """The same key for every attempt to create this payment's PaymentIntent (AGENTS.md
    "Money": every charge carries a deterministic idempotency key)."""
    return f"payment_intent:{payment_id}"


def transfer_group(request_id: uuid.UUID) -> str:
    """Ties the charge to the transfers of the same request (#68)."""
    return f"request:{request_id}"


@dataclass(frozen=True)
class PaymentRecord:
    """A payment row as the Stripe steps and the response need it, copied before the
    transaction that read it ends. The split is not here: nothing after the row's creation
    shows it."""

    id: uuid.UUID
    request_id: uuid.UUID
    quote_id: uuid.UUID
    customer_id: uuid.UUID
    amount_cents: int
    tax_cents: int
    customer_total_cents: int
    currency: str

    @property
    def ids(self) -> dict[str, str]:
        """What every log line of the payment carries: ids only."""
        return {
            "payment_id": str(self.id),
            "quote_id": str(self.quote_id),
            "service_request_id": str(self.request_id),
            "user_id": str(self.customer_id),
        }


@dataclass(frozen=True)
class PaymentsConfig:
    # The key the Payment Sheet initializes Stripe with; None: payments are not configured.
    publishable_key: str | None
    # How old a payment's unanswered PaymentIntent create must be before a retry searches first.
    intent_reconcile_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "PaymentsConfig":
        return cls(
            publishable_key=settings.stripe_publishable_key,
            intent_reconcile_after=timedelta(
                seconds=settings.stripe_payment_intent_reconcile_after_seconds
            ),
        )


def _matches(intent: PaymentIntentFacts, payment: PaymentRecord, customer_id: str | None) -> bool:
    """The intent is this payment's: its metadata names the payment, and it charges the row's
    total, in its currency, to the customer's Stripe Customer."""
    return (
        intent.payment_id == str(payment.id)
        and intent.amount_cents == payment.customer_total_cents
        and intent.currency == payment.currency
        and customer_id is not None
        and intent.customer_id == customer_id
    )


def _intent_state(payment: Payment) -> AuditState:
    """What a staff recovery changes on the payment, as audit_log records it (ids, status and
    timestamps; no PII)."""
    return {
        "status": payment.status.value,
        "stripe_payment_intent_id": payment.stripe_payment_intent_id,
        "payment_intent_requested_at": timestamp(payment.payment_intent_requested_at),
    }


def _record(payment: Payment) -> PaymentRecord:
    return PaymentRecord(
        id=payment.id,
        request_id=payment.request_id,
        quote_id=payment.quote_id,
        customer_id=payment.customer_id,
        amount_cents=payment.amount_cents,
        tax_cents=payment.tax_cents,
        customer_total_cents=payment.customer_total_cents,
        currency=payment.currency,
    )


class PaymentService:
    def __init__(
        self, session: AsyncSession, stripe: StripePayments | None, config: PaymentsConfig
    ) -> None:
        self._session = session
        self._stripe = stripe
        self._config = config
        self._payments = PaymentRepository(session)
        self._requests = RequestStateMachine(session)
        self._customer_requests = CustomerRequestReader(session)
        self._quotes = QuoteReader(session)
        self._pros = ProService(session)
        self._settings = SettingsService(session)
        self._users = UserService(session)
        self._audit = AuditService(session)

    async def payment_sheet(
        self, user: UserAccount, request_id: uuid.UUID, quote_id: uuid.UUID
    ) -> PaymentSheetOut:
        """What the Payment Sheet needs to charge the customer for the quote they accepted:
        the payment row created on the first call, then the Stripe steps (see the module doc).
        Ends every transaction it opens."""
        stripe, publishable_key = self._require_stripe()
        payment = await self._payment(user, request_id, quote_id)
        customer_id = await self._customer(stripe, user, payment)
        intent = await self._payment_intent(stripe, payment, customer_id)
        async with self._stripe_call(payment, "create_ephemeral_key"):
            ephemeral_key_secret = await stripe.create_ephemeral_key(customer_id)
        logger.info("payment_sheet_issued", extra=payment.ids)
        return PaymentSheetOut(
            payment_intent_client_secret=intent.client_secret,
            customer_id=customer_id,
            ephemeral_key_secret=ephemeral_key_secret,
            publishable_key=publishable_key,
            amount_cents=payment.amount_cents,
            tax_cents=payment.tax_cents,
            customer_total_cents=payment.customer_total_cents,
            currency=payment.currency,
        )

    def _require_stripe(self) -> tuple[StripePayments, str]:
        if self._stripe is None or self._config.publishable_key is None:
            logger.warning("payments_stripe_not_configured")
            raise PaymentsNotConfiguredError
        if not is_publishable_key(self._config.publishable_key):
            # Settings refuse such a key at load; this keeps one built another way (a copy that
            # skipped validation) out of the response. Never logs the value: it may be a secret.
            logger.error("payments_publishable_key_invalid")
            raise PaymentsNotConfiguredError
        return self._stripe, self._config.publishable_key

    async def _payment(
        self, user: UserAccount, request_id: uuid.UUID, quote_id: uuid.UUID
    ) -> PaymentRecord:
        """The quote's payment row, created on the first call, after the checks of the module
        doc under the request's and the quote's locks; committed, the locks released."""
        await self._customer_requests.own_status(user, request_id)
        request = await self._requests.lock(request_id)
        # Under the request's lock: what an acceptance or another payment call may have changed.
        quote = await self._quotes.lock_of_request(quote_id, request_id)
        if request is None:  # pragma: no cover - own_status found it; requests are never deleted
            raise NotFoundError
        if quote is None:
            raise NotFoundError
        if request.status is not RequestStatus.ACCEPTED or not quote.accepted:
            raise PaymentNotAvailableError
        # A canceled payment is not live: the quote was accepted again, and gets a new one.
        payment = await self._payments.get_live_by_quote_for_update(quote.id)
        if payment is not None and payment.status in CLOSED_STATUSES:
            raise PaymentNotAvailableError
        if quote.pro_id not in await self._pros.hireable_cards({quote.pro_id}):
            logger.warning(
                "payment_pro_not_hireable",
                extra={
                    "quote_id": str(quote.id),
                    "service_request_id": str(request.id),
                    "pro_id": str(quote.pro_id),
                    "user_id": str(user.id),
                },
            )
            raise ProNotHireableError
        created = payment is None
        if payment is None:
            take_rate_bps = await self._take_rate_bps()
            split = split_amount(quote.amount_cents, take_rate_bps)
            payment = await self._payments.add(
                Payment(
                    request_id=request.id,
                    quote_id=quote.id,
                    customer_id=request.customer_id,
                    amount_cents=quote.amount_cents,
                    tax_cents=TAX_CENTS,
                    customer_total_cents=quote.amount_cents + TAX_CENTS,
                    platform_fee_cents=split.platform_fee_cents,
                    pro_payout_cents=split.pro_payout_cents,
                    take_rate_bps=take_rate_bps,
                    currency=CURRENCY,
                    status=PaymentStatus.REQUIRES_PAYMENT,
                )
            )
        record = _record(payment)
        # Committed before any Stripe call: the row, and the key its id derives, survive a lost
        # answer, so a retry replays the same create. The commit also releases the locks.
        await self._session.commit()
        if created:
            logger.info("payment_created", extra=record.ids)
        return record

    async def _customer(
        self, stripe: StripePayments, user: UserAccount, payment: PaymentRecord
    ) -> str:
        """The customer's Stripe Customer id: the stored one, else created with the user's key
        and stored (see the module doc). Ends the transaction."""
        stored = await self._users.stripe_customer_id(user.id)
        if stored is not None:
            await self._session.commit()
            return stored
        async with self._stripe_call(payment, "create_customer"):
            created = await stripe.create_customer(
                user_id=str(user.id), idempotency_key=customer_idempotency_key(user.id)
            )
        if await self._users.set_stripe_customer_id_if_missing(user.id, created.customer_id):
            await self._session.commit()
            logger.info(
                "stripe_customer_created",
                extra={**payment.ids, "stripe_request_id": created.request_id},
            )
            return created.customer_id
        # Another payment of the customer stored a customer meanwhile: the stored one is theirs.
        await self._session.rollback()
        stored = await self._users.stripe_customer_id(user.id)
        await self._session.commit()
        if stored is None:  # pragma: no cover - the update failed because one is stored
            return created.customer_id
        return stored

    async def _payment_intent(
        self, stripe: StripePayments, payment: PaymentRecord, customer_id: str
    ) -> PaymentIntentState:
        """The payment's PaymentIntent: created once under the row's lock and stored, adopted
        from Stripe after a create answer lost too long ago, else retrieved by the stored id
        (see the module doc). Ends the transaction."""
        locked = await self._lock_open(payment)
        intent_id = locked.stripe_payment_intent_id
        if intent_id is None:
            requested = locked.payment_intent_requested_at
            if requested is None:
                # The first attempt: its time is committed before the call, so a rollback after
                # a lost answer keeps it. Then the row is locked again; a call that stored the
                # intent meanwhile is the one kept.
                await self._payments.mark_payment_intent_requested(payment.id)
                await self._session.commit()
                locked = await self._lock_open(payment)
                intent_id = locked.stripe_payment_intent_id
            elif datetime.now(UTC) - requested >= self._config.intent_reconcile_after:
                intent_id = await self._adopt_lost_intent(stripe, payment, customer_id)
        if intent_id is None:
            async with self._stripe_call(payment, "create_payment_intent"):
                intent = await stripe.create_payment_intent(
                    # From the locked row, never from the request.
                    amount_cents=locked.customer_total_cents,
                    currency=locked.currency,
                    customer_id=customer_id,
                    transfer_group=transfer_group(payment.request_id),
                    metadata={
                        "payment_id": str(payment.id),
                        "quote_id": str(payment.quote_id),
                        "request_id": str(payment.request_id),
                    },
                    idempotency_key=payment_intent_idempotency_key(payment.id),
                )
            stored = await self._payments.set_payment_intent_if_missing(
                payment.id, intent.payment_intent_id
            )
            if not stored:  # pragma: no cover - the row is locked from the read to the commit
                await self._session.rollback()
                logger.error("payment_intent_not_stored", extra=payment.ids)
                raise PaymentsUnavailableError
            await self._session.commit()
            logger.info(
                "payment_intent_created",
                extra={**payment.ids, "stripe_request_id": intent.request_id},
            )
        else:
            # The lock goes before Stripe is read: nothing here changes the row.
            await self._session.commit()
            async with self._stripe_call(payment, "retrieve_payment_intent"):
                intent = await stripe.retrieve_payment_intent(intent_id)
        if intent.status in PAYMENT_INTENT_CLOSED_STATUSES:
            logger.warning(
                "payment_intent_closed", extra={**payment.ids, "intent_status": intent.status}
            )
            raise PaymentNotAvailableError
        return intent

    async def _lock_open(self, payment: PaymentRecord) -> Payment:
        """The payment, locked until the transaction ends: 409 (rolled back) once closed."""
        locked = await self._payments.get_for_update(payment.id)
        if locked is None:  # pragma: no cover - payments are never deleted
            raise NotFoundError
        if locked.status in CLOSED_STATUSES:
            # A webhook (#61) closed it since the first read.
            await self._session.rollback()
            raise PaymentNotAvailableError
        return locked

    async def _adopt_lost_intent(
        self, stripe: StripePayments, payment: PaymentRecord, customer_id: str
    ) -> str:
        """An earlier create's answer was lost long enough ago that Stripe may have forgotten
        its key: the intent it made is searched for by its metadata, the row still locked, and
        the one match that is the payment's is stored and committed. Anything else creates
        nothing and leaves the create's time as it was: 409 until staff resolve it."""
        async with self._stripe_call(payment, "search_payment_intents"):
            found = await stripe.search_payment_intents(payment.id)
        if found.complete and len(found.intents) == 1:
            [intent] = found.intents
            if _matches(intent, payment, customer_id):
                try:
                    stored = await self._payments.set_payment_intent_if_missing(
                        payment.id, intent.payment_intent_id
                    )
                except IntegrityError:
                    # Another payment holds that intent: not this one's to adopt.
                    stored = None
                if stored is None:
                    await self._session.rollback()
                    logger.error(
                        "payment_intent_ambiguous",
                        extra={**payment.ids, "count": 1, "search_complete": True},
                    )
                    raise PaymentNeedsReviewError
                if not stored:  # pragma: no cover - the row is locked from the read to the commit
                    await self._session.rollback()
                    logger.error("payment_intent_not_stored", extra=payment.ids)
                    raise PaymentsUnavailableError
                await self._session.commit()
                logger.warning("payment_intent_adopted", extra=payment.ids)
                return intent.payment_intent_id
        await self._session.rollback()
        logger.error(
            "payment_intent_ambiguous",
            extra={
                **payment.ids,
                "count": len(found.intents),
                "search_complete": found.complete,
            },
        )
        raise PaymentNeedsReviewError

    async def adopt_intent(
        self, payment_id: uuid.UUID, intent_id: str, operator: Operator, *, apply: bool
    ) -> None:
        """Staff recovery of a 409 payment_needs_review (scripts/resolve_payment_intent.py):
        stores `intent_id` as the payment's PaymentIntent, once Stripe shows its metadata naming
        the payment and its amount, currency and customer equal to the row's. The payment must
        hold no intent. `apply` False checks only; applied, the audit_log row (app.modules.audit) is
        written in the same transaction, so its failure changes nothing. Ends the transaction;
        PaymentRecoveryRefusedError on a refusal, PaymentsNotConfiguredError without Stripe,
        PaymentsUnavailableError or PaymentsProviderError when Stripe is unavailable or refuses
        the intent."""
        if self._stripe is None:
            raise PaymentsNotConfiguredError
        try:
            row = await self._payment_to_resolve(payment_id)
            before = _intent_state(row)
            payment = _record(row)
            customer_id = await self._users.stripe_customer_id(payment.customer_id)
            async with self._stripe_call(payment, "payment_intent_facts"):
                intent = await self._stripe.payment_intent_facts(intent_id)
            if not _matches(intent, payment, customer_id):
                raise PaymentRecoveryRefusedError(
                    "That PaymentIntent is not this payment's (its metadata payment_id, amount, "
                    "currency or customer differ); nothing changed."
                )
            if apply:
                try:
                    stored = await self._payments.set_payment_intent_if_missing(
                        payment_id, intent_id
                    )
                except IntegrityError:
                    raise PaymentRecoveryRefusedError(
                        "That PaymentIntent is already another payment's; nothing changed."
                    ) from None
                if not stored:  # pragma: no cover - the row is locked from the read to here
                    raise PaymentRecoveryRefusedError(
                        "This payment already has a PaymentIntent; nothing changed."
                    )
                await self._audit.record(
                    operator,
                    AuditAction.PAYMENT_INTENT_ADOPT,
                    AuditEntity(AuditEntityType.PAYMENT, payment_id),
                    before,
                    {**before, "stripe_payment_intent_id": intent_id},
                )
                await self._session.commit()
                logger.warning(
                    "payment_intent_resolved",
                    extra={**payment.ids, "action": "adopt", "operator_id": str(operator.user_id)},
                )
        finally:
            await self._session.rollback()

    async def allow_new_intent(
        self, payment_id: uuid.UUID, operator: Operator, *, apply: bool
    ) -> None:
        """Staff recovery of a 409 payment_needs_review (scripts/resolve_payment_intent.py), once
        the Stripe dashboard shows no PaymentIntent for the payment: forgets its unresolved
        create, so the customer's next call creates one. Refused while the create is younger
        than Stripe's key retention, when the payment holds an intent, or when no create was
        attempted. `apply` False checks only; applied, the audit_log row (app.modules.audit) is
        written in the same transaction. Ends the transaction; PaymentRecoveryRefusedError on a
        refusal."""
        try:
            payment = await self._payment_to_resolve(payment_id)
            requested = payment.payment_intent_requested_at
            if requested is None:
                raise PaymentRecoveryRefusedError(
                    "This payment has no PaymentIntent create to clear; nothing changed."
                )
            if datetime.now(UTC) - requested < STRIPE_KEY_RETENTION:
                raise PaymentRecoveryRefusedError(
                    "The PaymentIntent create was attempted less than "
                    f"{STRIPE_KEY_RETENTION_HOURS} hours ago and may still land; nothing "
                    "changed. Try again later."
                )
            if apply:
                ids = _record(payment).ids
                before = _intent_state(payment)
                await self._payments.clear_payment_intent_requested(payment_id)
                await self._audit.record(
                    operator,
                    AuditAction.PAYMENT_INTENT_ALLOW_NEW,
                    AuditEntity(AuditEntityType.PAYMENT, payment_id),
                    before,
                    {**before, "payment_intent_requested_at": None},
                )
                await self._session.commit()
                logger.warning(
                    "payment_intent_resolved",
                    extra={**ids, "action": "allow_new", "operator_id": str(operator.user_id)},
                )
        finally:
            await self._session.rollback()

    async def _payment_to_resolve(self, payment_id: uuid.UUID) -> Payment:
        """The payment, its row locked: refused when no payment has this id or it already
        holds a PaymentIntent."""
        payment = await self._payments.get_for_update(payment_id)
        if payment is None:
            raise PaymentRecoveryRefusedError("No payment has this id; nothing changed.")
        if payment.stripe_payment_intent_id is not None:
            raise PaymentRecoveryRefusedError(
                "This payment already has a PaymentIntent; nothing changed."
            )
        return payment

    async def _take_rate_bps(self) -> int:
        try:
            return await self._settings.platform_take_rate_bps()
        except SettingMalformedError as error:
            # Logged by the settings service too (setting_invalid, the key only).
            logger.error("payment_not_configured", extra={"key": error.key})
            raise

    @asynccontextmanager
    async def _stripe_call(self, payment: PaymentRecord, operation: str) -> AsyncIterator[None]:
        """Stripe's failure as the API's error, the transaction rolled back first: nothing
        stored changes, and the payment row stays for the retry."""
        try:
            yield
        except StripeUnavailableError as error:
            await self._session.rollback()
            logger.error(
                "payment_stripe_unavailable",
                extra={
                    **payment.ids,
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsUnavailableError from None
        except StripeRejectedError as error:
            await self._session.rollback()
            logger.error(
                "payment_stripe_rejected",
                extra={
                    **payment.ids,
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsProviderError from None
