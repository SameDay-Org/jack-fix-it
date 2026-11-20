"""A job's receipt (#62): the customer's proof of payment, in the app and by email.

It exists from the moment the job's payment succeeded (Q-R3), whatever the job's status since,
for the request's customer only (another customer's request: 404, the same body as the request
itself; before the payment: 404 receipt_not_available). Every amount comes from a frozen row:
- service and tax: the payment as charged (the tax line only when it is not 0, Q-R4);
- tip: the job's tip, once it succeeded (#273);
- returned: each refund Stripe says went through, negative, dated (a dispute's resolution, a
  cancellation's refund); one still pending, failed or canceled, or one staff abandoned, is not
  listed.
The total paid is the sum of the lines. The status: under_review while a reported problem is
open; returned when nothing is left paid; partly_returned when some went back; else paid.
Never the platform's fee, the pro's payout or a Stripe id. The address is the customer's own,
line 1, city and state (Q-R2: the email shows the city only). The issuer is the API's settings,
null until both its values are set (Q-R1).
"""

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import NotFoundError
from app.modules.categories.service import CategoryService
from app.modules.disputes.outcomes import DisputeStatus, dispute_outcomes
from app.modules.jobs.service import JobReceiptFacts, JobReceiptReader
from app.modules.payments.receipt_reader import PaymentReceiptReader, ReceiptPayment
from app.modules.pros.service import ProService
from app.modules.quotes.service import QuoteReader
from app.modules.receipts.errors import ReceiptNotAvailableError
from app.modules.receipts.schemas import (
    ReceiptAddress,
    ReceiptCategory,
    ReceiptIssuer,
    ReceiptLine,
    ReceiptLineKind,
    ReceiptOut,
    ReceiptPaymentMethod,
    ReceiptStatus,
    ReceiptTip,
)
from app.modules.requests.service import CustomerRequestReader, ProRequestReader
from app.modules.tips.receipt_reader import ReceiptTip as TipFacts
from app.modules.tips.receipt_reader import TipReceiptReader
from app.modules.tips.service import TipConfig, TipReader
from app.modules.users.types import UserAccount


@dataclass(frozen=True)
class ReceiptConfig:
    legal_name: str | None
    support_email: str | None
    mailing_address: str | None
    tips: TipConfig

    @classmethod
    def from_settings(cls, settings: Settings) -> "ReceiptConfig":
        return cls(
            legal_name=settings.receipt_legal_name,
            support_email=settings.receipt_support_email,
            mailing_address=settings.receipt_mailing_address,
            tips=TipConfig.from_settings(settings),
        )

    @property
    def issuer(self) -> ReceiptIssuer | None:
        if self.legal_name is None or self.support_email is None:
            return None
        return ReceiptIssuer(legal_name=self.legal_name, support_email=self.support_email)


@dataclass(frozen=True)
class Receipt:
    """The receipt and the rows it was built from, for the worker's emails."""

    out: ReceiptOut
    job: JobReceiptFacts
    payment: ReceiptPayment
    tip: TipFacts | None


def receipt_status(lines: list[ReceiptLine], dispute_open: bool) -> ReceiptStatus:
    paid = sum(line.amount_cents for line in lines if line.kind is not ReceiptLineKind.RETURNED)
    returned = -sum(line.amount_cents for line in lines if line.kind is ReceiptLineKind.RETURNED)
    if dispute_open:
        return ReceiptStatus.UNDER_REVIEW
    if returned > 0 and returned >= paid:
        return ReceiptStatus.RETURNED
    if returned > 0:
        return ReceiptStatus.PARTLY_RETURNED
    return ReceiptStatus.PAID


class ReceiptService:
    def __init__(self, session: AsyncSession, config: ReceiptConfig) -> None:
        self._session = session
        self._config = config
        self._customer_requests = CustomerRequestReader(session)
        self._requests = ProRequestReader(session)
        self._jobs = JobReceiptReader(session)
        self._payments = PaymentReceiptReader(session)
        self._tips = TipReceiptReader(session)
        self._tip_view = TipReader(session, config.tips)
        self._quotes = QuoteReader(session)
        self._pros = ProService(session)
        self._categories = CategoryService(session)

    async def for_customer(self, user: UserAccount, request_id: uuid.UUID) -> ReceiptOut:
        """The receipt of the caller's own request (see the module doc). Reads only."""
        await self._customer_requests.own_status(user, request_id)  # 404 for anyone else's
        job = await self._jobs.of_customer_request(user.id, request_id)
        receipt = None if job is None else await self.of_job(job)
        if receipt is None:
            raise ReceiptNotAvailableError
        return receipt.out

    async def of_job(self, job: JobReceiptFacts) -> Receipt | None:
        """The job's receipt, or None while its payment has not succeeded. Reads only, in the
        caller's transaction."""
        payment = await self._payments.of_quote(job.quote_id)
        if payment is None:
            return None
        tip = await self._tips.of_job(job.job_id)
        lines = [
            ReceiptLine(kind=ReceiptLineKind.SERVICE, amount_cents=payment.amount_cents, at=None)
        ]
        if payment.tax_cents:
            lines.append(
                ReceiptLine(kind=ReceiptLineKind.TAX, amount_cents=payment.tax_cents, at=None)
            )
        if tip is not None:
            lines.append(
                ReceiptLine(kind=ReceiptLineKind.TIP, amount_cents=tip.amount_cents, at=None)
            )
        lines += [
            ReceiptLine(
                kind=ReceiptLineKind.RETURNED, amount_cents=-returned.amount_cents, at=returned.at
            )
            for returned in await self._payments.returned_of_job(job.job_id)
        ]
        outcome = (await dispute_outcomes(self._session, [job.job_id])).get(job.job_id)
        dispute_open = outcome is not None and outcome.status is DisputeStatus.OPEN
        request = (await self._requests.job_views([job.request_id])).get(job.request_id)
        if request is None:  # pragma: no cover - jobs.request_id is a foreign key
            raise NotFoundError
        category = None
        if request.view.category_id is not None:
            found = await self._categories.summaries([request.view.category_id])
            category = found[0] if found else None
        card = (await self._pros.cards([job.pro_id])).get(job.pro_id)
        starts = await self._quotes.proposed_starts([job.quote_id])
        tip_view = await self._tip_view.for_job(job.tip)
        address = request.address
        method = payment.card
        out = ReceiptOut(
            receipt_number=await self._customer_requests.public_code(job.request_id),
            paid_at=job.paid_at,
            status=receipt_status(lines, dispute_open),
            category=None
            if category is None
            else ReceiptCategory(slug=category.slug, names=dict(category.names)),
            pro_name=None if card is None else card.name,
            scheduled_start_at=starts[job.quote_id],
            completed_at=job.completed_at,
            address=ReceiptAddress(line1=address.line1, city=address.city, state=address.state),
            lines=lines,
            total_paid_cents=sum(line.amount_cents for line in lines),
            currency=payment.currency,
            payment_method=None
            if method is None
            else ReceiptPaymentMethod(brand=method.brand, last4=method.last4, wallet=method.wallet),
            tip=None
            if tip_view is None
            else ReceiptTip(can_tip=tip_view.can_tip, closes_at=tip_view.closes_at),
            issuer=self._config.issuer,
        )
        return Receipt(out=out, job=job, payment=payment, tip=tip)
