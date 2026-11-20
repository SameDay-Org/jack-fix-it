"""The worker's receipt emails (#62): the payment's, queued once its job is booked, and the tip's,
queued once a tip goes through (receipts.queue).

One run, for a payment (a tip runs the same steps on its own row):
1. The row is read as committed. Not succeeded, or its email already accepted
   (receipt_emailed_at): nothing to do.
2. The card: when none is stored, Stripe's charge is read (PaymentIntent with its latest
   charge, no lock and no transaction held over the call) and stored, the first read standing
   (forward only). This is where a receipt learns the card: never inside the booking's webhook,
   which a Stripe outage must not delay. Stripe failing: the run is tried again later
   (RECEIPT_EMAIL_RETRY_SECONDS) while tries are left (RECEIPT_EMAIL_MAX_ATTEMPTS); the last
   try sends without the card ("Card"), which the app's receipt shows too until a later read.
3. The email, in the account's locale, to the account's email, with the provider's
   idempotency key `payment-receipt:<payment id>` (`tip-receipt:<tip id>`): a retry after a
   lost answer sends nothing more. Accepted: receipt_emailed_at is stamped once. Resend
   unavailable: tried again later while tries are left, else an ERROR for staff.
Email not configured (no RESEND_API_KEY or EMAIL_FROM, allowed outside staging and production):
nothing is sent, a warning with ids. Nothing raises out of a run but ARQ's Retry. Logs carry
ids, outcomes and Stripe's codes only: never an address, a name, an amount or a Stripe id.
"""

import logging
import uuid
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import datetime
from typing import Any

from arq import Retry
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.email import EmailSender, EmailUnavailableError
from app.integrations.stripe_errors import StripeCallError
from app.integrations.stripe_payments import CardFacts, StripePayments
from app.modules.auth.email_copy import EmailContent
from app.modules.jobs.service import JobReceiptReader
from app.modules.payments.receipt_reader import PaymentReceiptReader
from app.modules.receipts.email_copy import (
    ReceiptEmailFacts,
    copy_of,
    local_date,
    payment_receipt_email,
    tip_receipt_email,
)
from app.modules.receipts.service import Receipt, ReceiptConfig, ReceiptService
from app.modules.tips.receipt_reader import TipReceiptReader
from app.modules.users.service import UserService

logger = logging.getLogger(__name__)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


async def send_payment_receipt(ctx: dict[str, Any], payment_id: str) -> None:
    """ARQ task: the payment's receipt email (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    pid = uuid.UUID(payment_id)
    ids = {"payment_id": payment_id}
    async with sessions() as session:
        payment = await PaymentReceiptReader(session).succeeded(pid)
        await session.commit()  # reads only: ends the transaction
    if payment is None:
        logger.warning("payment_receipt_no_payment", extra=ids)
        return
    if payment.receipt_emailed_at is not None:
        logger.debug("payment_receipt_already_sent", extra=ids)
        return
    if payment.card is None:
        card = await _read_card(ctx, payment.payment_intent_id, ids)
        if card is not None:
            async with sessions() as session:
                await PaymentReceiptReader(session).store_card(pid, card)
                await session.commit()
    async with sessions() as session:
        content = await _payment_email(session, ctx["settings"], payment.request_id)
        await session.commit()  # reads only: ends the transaction
    if content is None:
        logger.warning("payment_receipt_no_job", extra=ids)
        return
    to, email = content
    if not await _send(ctx, to, email, f"payment-receipt:{payment_id}", ids):
        return
    async with sessions() as session:
        await PaymentReceiptReader(session).mark_emailed(pid)
        await session.commit()
    logger.info("payment_receipt_emailed", extra=ids)


async def send_tip_receipt(ctx: dict[str, Any], tip_id: str) -> None:
    """ARQ task: the tip's receipt email (see the module doc)."""
    sessions: SessionFactory = ctx["session_factory"]
    tid = uuid.UUID(tip_id)
    ids = {"tip_id": tip_id}
    async with sessions() as session:
        tip = await TipReceiptReader(session).succeeded(tid)
        await session.commit()  # reads only: ends the transaction
    if tip is None:
        logger.warning("tip_receipt_no_tip", extra=ids)
        return
    if tip.receipt_emailed_at is not None:
        logger.debug("tip_receipt_already_sent", extra=ids)
        return
    if tip.card is None:
        card = await _read_card(ctx, tip.payment_intent_id, ids)
        if card is not None:
            async with sessions() as session:
                await TipReceiptReader(session).store_card(tid, card)
                await session.commit()
    async with sessions() as session:
        content = await _tip_email(session, ctx["settings"], tip.request_id)
        await session.commit()  # reads only: ends the transaction
    if content is None:
        logger.warning("tip_receipt_no_job", extra=ids)
        return
    to, email = content
    if not await _send(ctx, to, email, f"tip-receipt:{tip_id}", ids):
        return
    async with sessions() as session:
        await TipReceiptReader(session).mark_emailed(tid)
        await session.commit()
    logger.info("tip_receipt_emailed", extra=ids)


def _retry_or_give_up(ctx: dict[str, Any]) -> bool:
    """Raises ARQ's Retry while this run has tries left; True on the last one."""
    settings: Settings = ctx["settings"]
    if int(ctx.get("job_try", 1)) < settings.receipt_email_max_attempts:
        raise Retry(defer=settings.receipt_email_retry_seconds)
    return True


async def _read_card(
    ctx: dict[str, Any], payment_intent_id: str | None, ids: dict[str, str]
) -> CardFacts | None:
    stripe: StripePayments | None = ctx.get("stripe_payments")
    if stripe is None or payment_intent_id is None:
        logger.warning("receipt_card_not_read", extra={**ids, "reason": "not_configured"})
        return None
    try:
        return await stripe.card_of(payment_intent_id)
    except StripeCallError as error:
        logger.warning(
            "receipt_card_unavailable",
            extra={**ids, "error": type(error).__name__, "stripe_code": error.code},
        )
        _retry_or_give_up(ctx)
        return None


async def _send(
    ctx: dict[str, Any], to: str, email: EmailContent, key: str, ids: dict[str, str]
) -> bool:
    """Sends under the provider's idempotency key; True once it was accepted."""
    sender: EmailSender | None = ctx.get("email_sender")
    if sender is None:
        logger.warning("receipt_email_not_configured", extra=ids)
        return False
    try:
        await sender.send(to, email.subject, email.text, email.html, idempotency_key=key)
    except EmailUnavailableError:
        logger.warning("receipt_email_unavailable", extra=ids)
        _retry_or_give_up(ctx)
        logger.error("receipt_email_not_sent", extra=ids)
        return False
    return True


async def _local(session: AsyncSession, zone: str, value: datetime) -> datetime:
    """`value` in the business time zone, naive, by Postgres's own time zones."""
    local: datetime | None = await session.scalar(select(func.timezone(zone, value)))
    return local if local is not None else value


async def _facts(
    session: AsyncSession, settings: Settings, receipt: Receipt, lines: list[tuple[str, int]]
) -> tuple[str, ReceiptEmailFacts] | None:
    users = UserService(session)
    account = await users.get_by_id(receipt.job.customer_id)
    if account is None:  # pragma: no cover - jobs.customer_id is a foreign key
        return None
    locale = account.locale
    out = receipt.out
    category = None
    if out.category is not None:
        category = out.category.names.get(locale) or out.category.names.get("en")
    config = ReceiptConfig.from_settings(settings)
    issuer = tuple(
        value
        for value in (config.legal_name, config.support_email, config.mailing_address)
        if value is not None
    )
    when = await _local(session, settings.business_time_zone, out.scheduled_start_at)
    first_name = (await users.first_names([account.id])).get(account.id)
    facts = ReceiptEmailFacts(
        locale=locale,
        first_name=first_name,
        code=out.receipt_number,
        category=category,
        pro_name=out.pro_name,
        scheduled=local_date(when, locale),
        # The city only, never the street (Q-R2).
        city=None if out.address is None else out.address.city,
        lines=tuple(lines),
        total_cents=sum(cents for _, cents in lines),
        card=None,
        issuer=issuer,
    )
    return account.email, facts


async def _receipt(
    session: AsyncSession, settings: Settings, request_id: uuid.UUID
) -> Receipt | None:
    job = await JobReceiptReader(session).of_request(request_id)
    if job is None:
        return None
    return await ReceiptService(session, ReceiptConfig.from_settings(settings)).of_job(job)


async def _payment_email(
    session: AsyncSession, settings: Settings, request_id: uuid.UUID
) -> tuple[str, EmailContent] | None:
    receipt = await _receipt(session, settings, request_id)
    if receipt is None:
        return None
    account = await UserService(session).get_by_id(receipt.job.customer_id)
    copy = copy_of(account.locale if account else "en")
    lines = [(copy.service, receipt.payment.amount_cents)]
    if receipt.payment.tax_cents:
        lines.append((copy.tax, receipt.payment.tax_cents))
    found = await _facts(session, settings, receipt, lines)
    if found is None:  # pragma: no cover - see _facts
        return None
    to, facts = found
    # Read in this transaction, after the card's own commit: the card as stored now.
    return to, payment_receipt_email(_with_card(facts, receipt.payment.card))


async def _tip_email(
    session: AsyncSession, settings: Settings, request_id: uuid.UUID
) -> tuple[str, EmailContent] | None:
    receipt = await _receipt(session, settings, request_id)
    if receipt is None or receipt.tip is None:
        return None
    account = await UserService(session).get_by_id(receipt.job.customer_id)
    copy = copy_of(account.locale if account else "en")
    found = await _facts(session, settings, receipt, [(copy.tip, receipt.tip.amount_cents)])
    if found is None:  # pragma: no cover - see _facts
        return None
    to, facts = found
    return to, tip_receipt_email(_with_card(facts, receipt.tip.card))


def _with_card(facts: ReceiptEmailFacts, card: CardFacts | None) -> ReceiptEmailFacts:
    return ReceiptEmailFacts(**{**facts.__dict__, "card": card})
