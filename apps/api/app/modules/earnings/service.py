"""A pro's earnings (#70): what they receive for each job and where it stands.

- Who: the caller's own pro profile, from their token; there is no pro id parameter, so another
  pro's jobs are out of reach by construction. A pro user with no profile has no job: empty.
- Which jobs: those whose work is done (completed, confirmed, paid out, disputed). Refunded and
  cancelled jobs pay nothing and are left out.
- Amount: what the pro receives ("you'll receive"): the transfer's amount once its row exists,
  else the part of the payout an admin released on a dispute (#76: all of it, or a partial
  split's), else the job's payout frozen at payment by app.money.split_amount (#246). Never
  recomputed.
- Status (repository.py), from our own rows, never a live Stripe call:
  awaiting_confirmation (completed, the customer has not confirmed; `expected_by` is when it
  confirms itself: completed_at + JOB_AUTO_CONFIRM_AFTER_HOURS); on_the_way (confirmed, or
  disputed with the dispute released by an admin (#76): the transfer still to be made, held
  back for the pro's payout setup, or failed and retried); on_hold (a dispute is open, or
  Stripe reversed the transfer: staff look); paid (the transfer was made; `paid_at` is the
  job's move to paid_out).
- Tips (#273 PR A2): `tip_cents` is the job's succeeded tip, all of it the pro's (0 when
  none), beside the job's own amount. The summary counts each tip by its own transfer, never
  the job's: pending while the tip's transfer is not made, paid once Stripe made it, on hold
  once Stripe reversed it.
- Summary: each status's total over all the pro's jobs and their tips (pending_cents is
  on_the_way); the items of every page add up to it (amount_cents and tip_cents).
- Order: newest completion first, then by job id; the cursor carries both, so equal times page
  stably.
- Never in the answer: the customer's name, contacts or address, the platform's fee, Stripe or
  transfer ids. The title is the request's category.
"""

import base64
import binascii
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.categories.service import CategoryService
from app.modules.earnings.repository import EarningsRepository
from app.modules.earnings.schemas import (
    EarningCategory,
    EarningItem,
    EarningsPage,
    EarningsSummary,
    EarningStatus,
)
from app.modules.payments.transfer_reader import PAYMENT_CURRENCY
from app.modules.pros.service import ProService
from app.modules.requests.errors import InvalidRequestError
from app.modules.requests.service import CustomerRequestReader
from app.modules.users.types import UserAccount


@dataclass(frozen=True)
class EarningsConfig:
    list_default_limit: int
    list_max_limit: int
    # The confirmation window: a completed job confirms itself at the latest this long after.
    confirm_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "EarningsConfig":
        return cls(
            list_default_limit=settings.request_list_default_limit,
            list_max_limit=settings.request_list_max_limit,
            confirm_after=timedelta(hours=settings.job_auto_confirm_after_hours),
        )


class EarningsService:
    def __init__(self, session: AsyncSession, config: EarningsConfig) -> None:
        self._session = session
        self._config = config
        self._earnings = EarningsRepository(session)
        self._pros = ProService(session)
        self._requests = CustomerRequestReader(session)
        self._categories = CategoryService(session)

    async def read(self, user: UserAccount, cursor: str | None, limit: int | None) -> EarningsPage:
        """The caller's summary and one page of their jobs (see the module doc). `limit` above
        the maximum is capped, not refused; a cursor that is not one of ours is a 422."""
        size = min(limit or self._config.list_default_limit, self._config.list_max_limit)
        before = _decode_cursor(cursor) if cursor else None
        pro_id = await self._pros.get_profile_id_for_user(user.id)
        if pro_id is None:  # no profile: no job was ever theirs
            return EarningsPage(summary=_summary({}), items=[], next_cursor=None)
        totals = await self._earnings.totals(pro_id)
        rows = await self._earnings.page(pro_id, size + 1, before)
        page, more = rows[:size], len(rows) > size
        categories = await self._requests.category_ids([row.request_id for row in page])
        names = {
            summary.id: EarningCategory(slug=summary.slug, names=summary.names)
            for summary in await self._categories.summaries(
                {category for category in categories.values() if category is not None}
            )
        }
        await self._session.rollback()
        return EarningsPage(
            summary=_summary(totals),
            items=[
                EarningItem(
                    job_id=row.job_id,
                    category=_category(names, categories.get(row.request_id)),
                    amount_cents=row.amount_cents,
                    tip_cents=row.tip_cents,
                    status=row.status,
                    completed_at=row.completed_at,
                    paid_at=row.paid_at,
                    expected_by=(
                        row.completed_at + self._config.confirm_after
                        if row.status is EarningStatus.AWAITING_CONFIRMATION
                        else None
                    ),
                )
                for row in page
            ],
            next_cursor=(
                _encode_cursor(page[-1].completed_at, page[-1].job_id) if more and page else None
            ),
        )


def _summary(totals: dict[EarningStatus, int]) -> EarningsSummary:
    return EarningsSummary(
        awaiting_confirmation_cents=totals.get(EarningStatus.AWAITING_CONFIRMATION, 0),
        pending_cents=totals.get(EarningStatus.ON_THE_WAY, 0),
        on_hold_cents=totals.get(EarningStatus.ON_HOLD, 0),
        paid_cents=totals.get(EarningStatus.PAID, 0),
        currency=PAYMENT_CURRENCY,
    )


def _category(
    names: dict[uuid.UUID, EarningCategory], category_id: uuid.UUID | None
) -> EarningCategory | None:
    return None if category_id is None else names.get(category_id)


def _encode_cursor(completed_at: datetime, job_id: uuid.UUID) -> str:
    raw = f"{completed_at.isoformat()}|{job_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        completed_at, job_id = raw.split("|")
        decoded = datetime.fromisoformat(completed_at)
        if decoded.tzinfo is None:
            raise ValueError("naive timestamp")
        return decoded.astimezone(UTC), uuid.UUID(job_id)
    except (binascii.Error, UnicodeDecodeError, ValueError, OverflowError):
        raise InvalidRequestError from None
