"""Tips at confirmation (#273): the customer tips the pro of a confirmed job.

Which jobs take a tip: the customer's own (else 404, the same body as the request's), once
confirmed, by the customer (#66) or by the auto-confirm (#67), still confirmed or paid out after
that confirmation, until confirmed_at + TIP_WINDOW_HOURS (7 days; Foreman decision Q-T2). A job
never confirmed takes none: under way, disputed, refunded, cancelled, or paid out by an admin's
release of a dispute (jobs.service.tip_facts). Else 409 tip_not_available. Confirming a job
never reads or writes a tip, and nothing here changes the job but the `tip_added` line of its
history once a tip succeeds (webhooks.py).

Amounts are computed here, from the job's frozen price before tax (Q-T4), never taken from the
client as is (AGENTS.md "Money"): a percent must be one of TIP_PRESET_PERCENTS (else 422
tip_percent_not_offered) and comes to app.money.tip_amount (half up); any tip must be between
TIP_MIN_CENTS and the maximum, TIP_MAX_PERCENT of the price capped at TIP_MAX_CENTS (else 422
tip_amount_out_of_range). The options the job's view offers are the same numbers, so the app
computes none. No tax on a tip, and the platform absorbs the card fee: the tip is charged as is.

A choice sent with an Idempotency-Key (#510 round 1) is answered again by every repeat of the
key, before anything of the tip is touched: the tip as it is now, and the Payment Sheet of the
attempt it settled while that attempt is still the one to pay. A repeat never cancels, creates
or changes anything, whatever was chosen since. The same key with another body, or on another
job, is 409 idempotency_key_reused. A key is recorded once its choice is settled, so the retry
of a choice that failed does the work. Every choice, repeats included, counts against
TIP_CHOICE_LIMIT per customer (router.py), before any Stripe call.

The choice, on the tip's row lock (one row per job, created by the first choice):
- succeeded: 409 tip_already_paid; processing: 409 tip_in_progress. Nothing else changes;
- a tip flagged because an earlier attempt took money (late_success_at, webhooks.py): 409
  tip_needs_review, until staff look;
- "No tip": declined;
- the same amount as the current attempt, still to pay (requires_payment, or failed: Stripe
  keeps a failed PaymentIntent payable, so it is confirmed again): the same PaymentIntent;
- anything else (a new amount, "No tip" after an amount, a tip after "No tip" or a canceled
  attempt): a new attempt. A PaymentIntent of the tip that can still be paid is canceled in
  Stripe first, the lock released over the call, and the change is made only once Stripe shows
  it canceled: a refusal because it is processing or succeeded answers 409 (tip_in_progress,
  tip_already_paid) and changes nothing. So at most one PaymentIntent of a tip can be paid at a
  time, and a sheet the app still holds for an earlier amount cannot charge it. A create sent
  for the current attempt with no answer stored: 409 tip_in_progress for any change within
  STRIPE_PAYMENT_INTENT_RECONCILE_AFTER_SECONDS (the same choice sends the same key again and
  Stripe replays it). Past that window Stripe may have forgotten the key: the intent is found
  by Stripe's search on the tip's metadata, and the one intent of this attempt that is this
  tip's (job, customer, currency, amount) is adopted, then handled as any stored intent. None,
  several, or a search with another page: 409 tip_needs_review and an ERROR for staff, nothing
  changed. Never a new attempt on age alone (#510 round 1).
- a create Stripe refused for good (TIP_CREATE_REFUSED_CODES, an explicit list: nothing was
  made under the key): the next choice makes a new attempt. Any other refusal says nothing,
  and the next choice sends the same key again.
Each attempt's PaymentIntent is created as the job payment's is (payments/service.py), on the
platform account: the tip, usd, the customer's Stripe Customer, automatic payment methods
without redirects, automatic capture, transfer_group `request:<request id>`, description "Tip",
metadata kind "tip" with the tip, job and attempt ids, under the key `tip:<tip id>:<attempt>`.
Its create time is committed before the call and its id stored once Stripe answers, on the
row's lock. Then a CustomerSession (and, for one release, the deprecated ephemeral key): the
response is the tip's view plus what the Payment Sheet needs, `sheet` null for "No tip". The
payment_intent.* events of a tip's PaymentIntent (metadata kind "tip") come to webhooks.py,
never to the job payment's reconciliation; the unpaid sweep (tasks.py) cancels a tip left
unpaid past PAYMENT_UNPAID_CANCEL_AFTER_SECONDS.

Stripe not configured: 503 not_configured. Unreachable, a 409, 429 or 5xx: 503
payments_unavailable; any other 4xx: 502 payments_error. Nothing stored changes on either (the
transaction is rolled back), and what was committed before the call stays for the retry. Logs
carry ids only (the tip, the job, the request, the customer's user id, Stripe's request id and
error code): never a client secret, a customer id or a PaymentIntent id.
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

from app.config import Settings, is_publishable_key
from app.errors import NotFoundError
from app.idempotency import body_fingerprint, same_body
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payments import (
    INTENT_KIND_KEY,
    TIP_INTENT_KIND,
    PaymentIntentState,
    StripePayments,
)
from app.modules.jobs.service import JobTipFacts, JobTipReader
from app.modules.payments.errors import PaymentsNotConfiguredError
from app.modules.payments.schemas import PaymentSheetOut
from app.modules.payments.service import customer_idempotency_key, transfer_group
from app.modules.payments.transfer_reader import PAYMENT_CURRENCY
from app.modules.payouts.errors import PaymentsProviderError, PaymentsUnavailableError
from app.modules.requests.service import CustomerRequestReader
from app.modules.tips.errors import (
    TipAlreadyPaidError,
    TipAmountOutOfRangeError,
    TipIdempotencyKeyReusedError,
    TipInProgressError,
    TipNeedsReviewError,
    TipNotAvailableError,
    TipPercentNotOfferedError,
)
from app.modules.tips.intents import (
    mismatches,
    status_of,
    tip_cancel_idempotency_key,
    tip_payment_intent_idempotency_key,
)
from app.modules.tips.models import UNPAID_STATUSES, Tip, TipChoice, TipStatus
from app.modules.tips.repository import NewTip, TipRepository
from app.modules.tips.schemas import CustomTipIn, NoTipIn, PercentTipIn, TipCreateOut
from app.modules.tips.views import TipOptions, TipOut, TipPreset
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount
from app.money import tip_amount

logger = logging.getLogger(__name__)

# No tax on a tip (#273): the sheet charges the tip as is.
TIP_TAX_CENTS: Final = 0
# What Stripe shows on the charge.
TIP_DESCRIPTION: Final = "Tip"
# Stripe's statuses of a PaymentIntent no sheet should be offered for again.
_PAID: Final = "succeeded"
_NOT_PAYABLE: Final = frozenset({"processing", "canceled"})
# Rounds of the choice's lock: a cancel in Stripe, the change, then the kept attempt. More only
# when another call of the same tip changed it meanwhile: that call answers 409 instead.
_CHOICE_ROUNDS: Final = 5
# Stripe's codes for a PaymentIntent create it refused for good: nothing was made under the
# key, so the next choice may ask for a new attempt (#510 round 1, the shared rule of
# payments.refunds.REFUND_REFUSED_CODES: an explicit list, any other refusal says nothing).
# The codes of stripe-python 16.1.0, each in https://docs.stripe.com/error-codes.
TIP_CREATE_REFUSED_CODES: Final = frozenset(
    {
        # "The specified amount is less than the minimum amount allowed."
        "amount_too_small",
        # "The specified amount is greater than the maximum amount allowed."
        "amount_too_large",
    }
)


@dataclass(frozen=True)
class TipConfig:
    presets: tuple[int, ...]
    min_cents: int
    max_percent: int
    max_cents: int
    window: timedelta
    # The key the Payment Sheet initializes Stripe with; None: payments are not configured.
    publishable_key: str | None
    # How old an unanswered create must be before Stripe may have forgotten its key.
    intent_reconcile_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "TipConfig":
        return cls(
            presets=tuple(settings.tip_preset_percents),
            min_cents=settings.tip_min_cents,
            max_percent=settings.tip_max_percent,
            max_cents=settings.tip_max_cents,
            window=timedelta(hours=settings.tip_window_hours),
            publishable_key=settings.stripe_publishable_key,
            intent_reconcile_after=timedelta(
                seconds=settings.stripe_payment_intent_reconcile_after_seconds
            ),
        )


def tip_options(price_cents: int, config: TipConfig) -> TipOptions:
    """The job's options: the bounds, and each offered percent whose amount falls inside them."""
    max_cents = min(tip_amount(price_cents, config.max_percent), config.max_cents)
    presets = [
        TipPreset(percent=percent, amount_cents=amount)
        for percent in config.presets
        if config.min_cents <= (amount := tip_amount(price_cents, percent)) <= max_cents
    ]
    return TipOptions(presets=presets, min_cents=config.min_cents, max_cents=max_cents)


@dataclass(frozen=True)
class Wanted:
    """The choice, checked, with the amount it comes to."""

    choice: TipChoice
    percent: int | None
    amount_cents: int


def wanted_tip(
    body: NoTipIn | PercentTipIn | CustomTipIn, price_cents: int, config: TipConfig
) -> Wanted:
    """The customer's choice against the job's options: 422 when it is not one of them."""
    if isinstance(body, NoTipIn):
        return Wanted(TipChoice.NONE, None, 0)
    options = tip_options(price_cents, config)
    if isinstance(body, PercentTipIn):
        if body.percent not in config.presets:
            raise TipPercentNotOfferedError
        wanted = Wanted(TipChoice.PERCENT, body.percent, tip_amount(price_cents, body.percent))
    else:
        wanted = Wanted(TipChoice.CUSTOM, None, body.amount_cents)
    if not options.min_cents <= wanted.amount_cents <= options.max_cents:
        raise TipAmountOutOfRangeError
    return wanted


def tip_view(
    tip: Tip | None, price_cents: int, confirmed_at: datetime, config: TipConfig, now: datetime
) -> TipOut:
    """The tip of a confirmed job as its customer sees it (`tip` None before any choice)."""
    options = tip_options(price_cents, config)
    closes_at = confirmed_at + config.window
    settled = tip is not None and tip.status in (TipStatus.SUCCEEDED, TipStatus.PROCESSING)
    return TipOut(
        status=None if tip is None else tip.status,
        choice=None if tip is None else tip.choice,
        percent=None if tip is None else tip.percent,
        amount_cents=0 if tip is None else tip.amount_cents,
        currency=PAYMENT_CURRENCY if tip is None else tip.currency,
        options=options,
        can_tip=now < closes_at and not settled and options.min_cents <= options.max_cents,
        closes_at=closes_at,
    )


class TipReader:
    """The tip of a job, for the customer's view of it (jobs/execution.py). Reads only."""

    def __init__(self, session: AsyncSession, config: TipConfig) -> None:
        self._tips = TipRepository(session)
        self._config = config

    async def for_job(self, facts: JobTipFacts) -> TipOut | None:
        """None for a job that takes no tip (never confirmed); else its tip, inside the window
        or after it."""
        if facts.confirmed_at is None:
            return None
        tip = await self._tips.get_by_job(facts.job_id)
        return tip_view(tip, facts.price_cents, facts.confirmed_at, self._config, datetime.now(UTC))


@dataclass(frozen=True)
class TipRecord:
    """The tip's row as the Stripe steps need it, copied before the transaction that read it
    ends."""

    id: uuid.UUID
    job_id: uuid.UUID
    request_id: uuid.UUID
    customer_id: uuid.UUID
    attempt: int
    amount_cents: int
    currency: str

    @property
    def ids(self) -> dict[str, str]:
        """What every log line of the tip carries: ids only."""
        return {
            "tip_id": str(self.id),
            "job_id": str(self.job_id),
            "service_request_id": str(self.request_id),
            "user_id": str(self.customer_id),
        }


def _record(tip: Tip) -> TipRecord:
    return TipRecord(
        id=tip.id,
        job_id=tip.job_id,
        request_id=tip.request_id,
        customer_id=tip.customer_id,
        attempt=tip.attempt,
        amount_cents=tip.amount_cents,
        currency=tip.currency,
    )


class TipService:
    def __init__(
        self, session: AsyncSession, stripe: StripePayments | None, config: TipConfig
    ) -> None:
        self._session = session
        self._stripe = stripe
        self._config = config
        self._tips = TipRepository(session)
        self._jobs = JobTipReader(session)
        self._customer_requests = CustomerRequestReader(session)
        self._users = UserService(session)

    async def choose(
        self,
        user: UserAccount,
        request_id: uuid.UUID,
        body: NoTipIn | PercentTipIn | CustomTipIn,
        idempotency_key: uuid.UUID | None = None,
    ) -> TipCreateOut:
        """The customer's choice for the tip of their job (see the module doc). Ends every
        transaction it opens."""
        facts = await self._own_job(user, request_id)
        fingerprint = None if idempotency_key is None else body_fingerprint(body)
        if idempotency_key is not None and fingerprint is not None:
            stored = await self._tips.request_by_key(user.id, idempotency_key)
            if stored is not None:
                # A replay: answered before anything of the tip is touched (#510 round 1).
                if stored.job_id != facts.job_id or not same_body(stored.fingerprint, fingerprint):
                    await self._session.commit()
                    logger.info("tip_idempotency_key_reused", extra={"job_id": str(facts.job_id)})
                    raise TipIdempotencyKeyReusedError
                return await self._replay(user, facts, stored.attempt)
        self._in_window(facts)
        wanted = wanted_tip(body, facts.price_cents, self._config)
        if wanted.choice is TipChoice.NONE:
            await self._settle_choice(facts, wanted)
            await self._remember(user, facts, idempotency_key, fingerprint, None)
            return TipCreateOut(tip=await self._view(facts), sheet=None)
        stripe, publishable_key = self._require_stripe()
        record = await self._settle_choice(facts, wanted)
        customer_id = await self._customer(stripe, user, record)
        intent = await self._payment_intent(stripe, record, customer_id)
        sheet = await self._sheet(stripe, publishable_key, record, customer_id, intent)
        await self._remember(user, facts, idempotency_key, fingerprint, record.attempt)
        return TipCreateOut(tip=await self._view(facts), sheet=sheet)

    async def _sheet(
        self,
        stripe: StripePayments,
        publishable_key: str,
        record: TipRecord,
        customer_id: str,
        intent: PaymentIntentState,
    ) -> PaymentSheetOut:
        async with self._stripe_call(record, "create_customer_session"):
            customer_session_client_secret = await stripe.create_customer_session(customer_id)
        # Deprecated (#253c): for app builds before the CustomerSession, one release.
        async with self._stripe_call(record, "create_ephemeral_key"):
            ephemeral_key_secret = await stripe.create_ephemeral_key(customer_id)
        logger.info("tip_sheet_issued", extra=record.ids)
        return PaymentSheetOut(
            payment_intent_client_secret=intent.client_secret,
            customer_id=customer_id,
            customer_session_client_secret=customer_session_client_secret,
            ephemeral_key_secret=ephemeral_key_secret,
            publishable_key=publishable_key,
            amount_cents=record.amount_cents,
            tax_cents=TIP_TAX_CENTS,
            customer_total_cents=record.amount_cents + TIP_TAX_CENTS,
            currency=record.currency,
        )

    async def _remember(
        self,
        user: UserAccount,
        facts: JobTipFacts,
        idempotency_key: uuid.UUID | None,
        fingerprint: str | None,
        attempt: int | None,
    ) -> None:
        """Records a keyed choice once it is settled: a replay answers it again (#510 round
        1). A choice that failed records nothing, so its retry with the key does the work."""
        if idempotency_key is None or fingerprint is None:
            return
        await self._tips.add_request(
            job_id=facts.job_id,
            customer_id=user.id,
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            attempt=attempt,
        )
        await self._session.commit()

    async def _replay(
        self, user: UserAccount, facts: JobTipFacts, attempt: int | None
    ) -> TipCreateOut:
        """What a keyed choice answers again: the tip as it is now, and the Payment Sheet of
        the attempt it settled while that attempt is still the one to pay. It never cancels,
        creates or changes anything (#510 round 1)."""
        view = await self._view(facts)
        tip = await self._tips.get_by_job(facts.job_id)
        await self._session.commit()
        if (
            attempt is None
            or tip is None
            or tip.attempt != attempt
            or tip.status not in UNPAID_STATUSES
            or tip.stripe_payment_intent_id is None
            or tip.late_success_at is not None
        ):
            logger.info("tip_choice_replayed", extra={"job_id": str(facts.job_id)})
            return TipCreateOut(tip=view, sheet=None)
        stripe, publishable_key = self._require_stripe()
        record = _record(tip)
        intent_id = tip.stripe_payment_intent_id
        customer_id = await self._customer(stripe, user, record)
        async with self._stripe_call(record, "retrieve_payment_intent"):
            intent = await stripe.retrieve_payment_intent(intent_id)
        if intent.status == _PAID or intent.status in _NOT_PAYABLE:
            logger.info("tip_choice_replayed", extra=record.ids)
            return TipCreateOut(tip=view, sheet=None)
        logger.info("tip_choice_replayed", extra=record.ids)
        sheet = await self._sheet(stripe, publishable_key, record, customer_id, intent)
        return TipCreateOut(tip=view, sheet=sheet)

    async def _own_job(self, user: UserAccount, request_id: uuid.UUID) -> JobTipFacts:
        """The job of the caller's own request; 404 for anyone else's, and while it has none."""
        await self._customer_requests.own_status(user, request_id)
        facts = await self._jobs.of_customer_request(user.id, request_id)
        if facts is None:
            raise NotFoundError
        return facts

    def _in_window(self, facts: JobTipFacts) -> None:
        """409 tip_not_available unless the job takes a tip now."""
        if (
            facts.confirmed_at is None
            or datetime.now(UTC) >= facts.confirmed_at + self._config.window
        ):
            raise TipNotAvailableError

    async def _view(self, facts: JobTipFacts) -> TipOut:
        if facts.confirmed_at is None:  # pragma: no cover - _tippable refused it
            raise TipNotAvailableError
        tip = await self._tips.get_by_job(facts.job_id)
        await self._session.commit()
        return tip_view(tip, facts.price_cents, facts.confirmed_at, self._config, datetime.now(UTC))

    def _require_stripe(self) -> tuple[StripePayments, str]:
        if self._stripe is None or self._config.publishable_key is None:
            logger.warning("payments_stripe_not_configured")
            raise PaymentsNotConfiguredError
        if not is_publishable_key(self._config.publishable_key):
            # Never logs the value: it may be a secret.
            logger.error("payments_publishable_key_invalid")
            raise PaymentsNotConfiguredError
        return self._stripe, self._config.publishable_key

    async def _locked(self, facts: JobTipFacts, wanted: Wanted) -> Tip:
        """The job's tip, locked until the transaction ends; created with this choice when the
        job has none."""
        tip = await self._tips.get_by_job_for_update(facts.job_id)
        if tip is None:
            new = NewTip(
                job_id=facts.job_id,
                request_id=facts.request_id,
                customer_id=facts.customer_id,
                pro_id=facts.pro_id,
                currency=PAYMENT_CURRENCY,
            )
            await self._tips.insert_if_missing(
                new, wanted.choice, wanted.percent, wanted.amount_cents
            )
            tip = await self._tips.get_by_job_for_update(facts.job_id)
        if tip is None:  # pragma: no cover - inserted above, and rows are never deleted
            raise NotFoundError
        return tip

    async def _settle_choice(self, facts: JobTipFacts, wanted: Wanted) -> TipRecord:
        """The tip's row once it holds the choice: the current attempt kept, or a new one (or
        "No tip") once no PaymentIntent of the tip can be paid any more (see the module doc).
        Committed, the lock released."""
        canceled: str | None = None  # a PaymentIntent of the tip this call saw canceled
        for _ in range(_CHOICE_ROUNDS):
            tip = await self._locked(facts, wanted)
            record = _record(tip)
            if tip.status is TipStatus.SUCCEEDED:
                await self._session.rollback()
                raise TipAlreadyPaidError
            if tip.status is TipStatus.PROCESSING:
                await self._session.rollback()
                raise TipInProgressError
            if tip.late_success_at is not None:
                # An earlier attempt took money no attempt holds: staff first (#510 round 1).
                await self._session.rollback()
                raise TipNeedsReviewError
            if wanted.choice is TipChoice.NONE and tip.status is TipStatus.DECLINED:
                await self._session.commit()
                return record
            intent_id = tip.stripe_payment_intent_id
            payable = tip.status in UNPAID_STATUSES
            # Stripe refused the attempt's create for good: nothing exists under its key.
            refused = intent_id is None and tip.create_refused_at is not None
            lost = (
                intent_id is None
                and not refused
                and tip.payment_intent_requested_at is not None
                and datetime.now(UTC) - tip.payment_intent_requested_at
                >= self._config.intent_reconcile_after
            )
            same = (tip.choice, tip.percent, tip.amount_cents) == (
                wanted.choice,
                wanted.percent,
                wanted.amount_cents,
            )
            if payable and same and not lost and not refused:
                if tip.status is TipStatus.FAILED and intent_id is not None:
                    await self._tips.retry_failed(tip.id, intent_id)
                await self._session.commit()
                return record
            if (
                payable
                and intent_id is None
                and tip.payment_intent_requested_at
                and not lost
                and not refused
            ):
                # A create of this attempt may still answer: its intent could be paid.
                await self._session.rollback()
                logger.info("tip_change_waits_for_create", extra=record.ids)
                raise TipInProgressError
            if payable and lost:
                # Stripe may have forgotten the key: the intent is found by its metadata and
                # adopted, never replaced on age alone (#510 round 1).
                await self._session.commit()  # no lock over the search
                await self._recover(record)
                continue
            if payable and intent_id is not None and intent_id != canceled:
                version = tip.updated_at
                await self._session.commit()  # no lock over the Stripe calls
                canceled = await self._cancel(record, intent_id, version)
                continue
            # Nothing of the tip can be paid: declined, canceled, an intent this call saw
            # canceled, an attempt never sent, or one whose create Stripe refused for good.
            if wanted.choice is TipChoice.NONE:
                await self._tips.decline(tip.id)
            else:
                await self._tips.new_attempt(
                    tip.id, wanted.choice, wanted.percent, wanted.amount_cents
                )
            await self._session.commit()
            logger.info("tip_chosen", extra={**record.ids, "choice": wanted.choice.value})
        # Another call of the same tip kept changing it: this one stops.
        logger.warning("tip_choice_contended", extra={"job_id": str(facts.job_id)})
        raise TipInProgressError

    async def _recover(self, record: TipRecord) -> None:
        """The current attempt's lost create, found again: Stripe's search by the tip's
        metadata must show exactly one intent of this attempt that is this tip's (kind, job,
        customer, currency, amount). It is stored on the locked row, and an intent Stripe shows
        canceled lets the next round make a new attempt. Anything else (none, more than one, an
        incomplete search): 409 tip_needs_review, an ERROR for staff, nothing changed."""
        stripe = self._stripe
        if stripe is None:
            logger.warning("payments_stripe_not_configured")
            raise PaymentsNotConfiguredError
        customer = await self._users.stripe_customer_id(record.customer_id)
        await self._session.commit()
        async with self._stripe_call(record, "search_tip_intents"):
            found = await stripe.search_tip_intents(record.id)
        mine = [
            facts
            for facts in found.intents
            if facts.attempt == str(record.attempt)
            and not mismatches(
                facts,
                tip_id=record.id,
                job_id=record.job_id,
                attempt=record.attempt,
                amount_cents=record.amount_cents,
                currency=record.currency,
                stripe_customer_id=customer,
            )
        ]
        if not found.complete or len(mine) != 1:
            logger.error(
                "tip_intent_unresolved",
                extra={**record.ids, "found": len(found.intents), "matching": len(mine)},
            )
            raise TipNeedsReviewError
        [facts] = mine
        tip = await self._tips.get_by_job_for_update(record.job_id)
        if tip is None or tip.attempt != record.attempt or tip.stripe_payment_intent_id:
            await self._session.rollback()
            raise TipInProgressError  # another call settled it meanwhile
        try:
            async with self._session.begin_nested():
                stored = await self._tips.set_payment_intent_if_missing(
                    tip.id, record.attempt, facts.payment_intent_id
                )
        except IntegrityError:
            stored = False  # another tip holds this intent: staff look
        if not stored:
            await self._session.rollback()
            logger.error("tip_intent_unresolved", extra={**record.ids, "found": 1, "matching": 0})
            raise TipNeedsReviewError
        if status_of(facts) is TipStatus.CANCELED and tip.status in UNPAID_STATUSES:
            await self._tips.move_status(
                tip.id, facts.payment_intent_id, tip.status, TipStatus.CANCELED
            )
        await self._session.commit()
        logger.warning("tip_payment_intent_adopted", extra=record.ids)

    async def _cancel(self, record: TipRecord, intent_id: str, version: datetime) -> str:
        """Cancels the tip's PaymentIntent in Stripe before a change; returns its id once
        Stripe shows it canceled. 409 when Stripe refuses because it is being paid or paid."""
        stripe = self._stripe
        if stripe is None:
            logger.warning("payments_stripe_not_configured")
            raise PaymentsNotConfiguredError
        key = tip_cancel_idempotency_key(record.id, record.attempt, version)
        async with self._stripe_call(record, "cancel_payment_intent"):
            canceled = await stripe.cancel_payment_intent(intent_id, idempotency_key=key)
        if not canceled:
            # Processing, succeeded or canceled already: Stripe's status says which.
            async with self._stripe_call(record, "retrieve_payment_intent"):
                state = await stripe.retrieve_payment_intent(intent_id)
            if state.status == _PAID:
                raise TipAlreadyPaidError
            if state.status != "canceled":
                raise TipInProgressError
        logger.info("tip_intent_canceled_for_change", extra=record.ids)
        return intent_id

    async def _locked_attempt(self, record: TipRecord) -> Tip:
        """The tip locked, still at the attempt `record` settled and still to pay; 409 when
        another call moved it on meanwhile."""
        tip = await self._tips.get_by_job_for_update(record.job_id)
        if (
            tip is None
            or tip.attempt != record.attempt
            or tip.amount_cents != record.amount_cents
            or tip.status is not TipStatus.REQUIRES_PAYMENT
        ):
            await self._session.rollback()
            raise TipInProgressError
        return tip

    async def _payment_intent(
        self, stripe: StripePayments, record: TipRecord, customer_id: str
    ) -> PaymentIntentState:
        """The attempt's PaymentIntent: created once under the row's lock, its create time
        committed before the call, else retrieved by the stored id. Ends the transaction."""
        tip = await self._locked_attempt(record)
        intent_id = tip.stripe_payment_intent_id
        if intent_id is None and tip.payment_intent_requested_at is None:
            await self._tips.mark_payment_intent_requested(tip.id, record.attempt)
            await self._session.commit()
            tip = await self._locked_attempt(record)
            intent_id = tip.stripe_payment_intent_id
        if intent_id is None:
            refused: str | None = None
            try:
                async with self._stripe_call(record, "create_payment_intent"):
                    try:
                        intent = await stripe.create_payment_intent(
                            # From the locked row, never from the request.
                            amount_cents=tip.amount_cents,
                            currency=tip.currency,
                            customer_id=customer_id,
                            transfer_group=transfer_group(tip.request_id),
                            metadata={
                                INTENT_KIND_KEY: TIP_INTENT_KIND,
                                "tip_id": str(tip.id),
                                "job_id": str(tip.job_id),
                                "attempt": str(tip.attempt),
                            },
                            description=TIP_DESCRIPTION,
                            idempotency_key=tip_payment_intent_idempotency_key(tip.id, tip.attempt),
                        )
                    except StripeRejectedError as error:
                        if error.code in TIP_CREATE_REFUSED_CODES:
                            refused = error.code
                        raise
            except PaymentsProviderError:
                if refused is not None:
                    await self._mark_refused(record, refused)
                raise
            stored = await self._tips.set_payment_intent_if_missing(
                tip.id, record.attempt, intent.payment_intent_id
            )
            if not stored:  # pragma: no cover - the row is locked from the read to the commit
                await self._session.rollback()
                logger.error("tip_payment_intent_not_stored", extra=record.ids)
                raise PaymentsUnavailableError
            await self._session.commit()
            logger.info(
                "tip_payment_intent_created",
                extra={**record.ids, "stripe_request_id": intent.request_id},
            )
        else:
            await self._session.commit()  # the lock goes before Stripe is read
            async with self._stripe_call(record, "retrieve_payment_intent"):
                intent = await stripe.retrieve_payment_intent(intent_id)
        if intent.status == _PAID:
            raise TipAlreadyPaidError
        if intent.status in _NOT_PAYABLE:
            # Its event settles the tip; then the customer tries again.
            logger.info(
                "tip_payment_intent_not_payable",
                extra={**record.ids, "intent_status": intent.status},
            )
            raise TipInProgressError
        return intent

    async def _mark_refused(self, record: TipRecord, code: str) -> None:
        """Stripe refused the attempt's create for good: recorded on the row, so the next
        choice makes a new attempt (the same key would get the same refusal)."""
        tip = await self._tips.get_by_job_for_update(record.job_id)
        if tip is not None and tip.attempt == record.attempt:
            await self._tips.mark_create_refused(tip.id, record.attempt)
        await self._session.commit()
        logger.error("tip_create_refused", extra={**record.ids, "stripe_code": code})

    async def _customer(self, stripe: StripePayments, user: UserAccount, record: TipRecord) -> str:
        """The customer's Stripe Customer id: the stored one (their job's payment made it),
        else created with the user's key and stored, as the payment call does. Ends the
        transaction."""
        stored = await self._users.stripe_customer_id(user.id)
        if stored is not None:
            await self._session.commit()
            return stored
        async with self._stripe_call(record, "create_customer"):
            created = await stripe.create_customer(
                user_id=str(user.id), idempotency_key=customer_idempotency_key(user.id)
            )
        if await self._users.set_stripe_customer_id_if_missing(user.id, created.customer_id):
            await self._session.commit()
            return created.customer_id
        await self._session.rollback()
        stored = await self._users.stripe_customer_id(user.id)
        await self._session.commit()
        return created.customer_id if stored is None else stored

    @asynccontextmanager
    async def _stripe_call(self, record: TipRecord, operation: str) -> AsyncIterator[None]:
        """Stripe's failure as the API's error, the transaction rolled back first: nothing
        stored changes, and what was committed stays for the retry."""
        try:
            yield
        except StripeUnavailableError as error:
            await self._session.rollback()
            logger.error(
                "tip_stripe_unavailable",
                extra={
                    **record.ids,
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsUnavailableError from None
        except StripeRejectedError as error:
            await self._session.rollback()
            logger.error(
                "tip_stripe_rejected",
                extra={
                    **record.ids,
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsProviderError from None
