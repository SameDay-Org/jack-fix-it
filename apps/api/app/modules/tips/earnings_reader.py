"""A pro's tips as their earnings read them (#273 PR A2), for the earnings module (ADR 0003)."""

from sqlalchemy import Subquery

from app.modules.tips.repository import TipTransferRepository


def tip_payout_facts() -> Subquery:
    """Each succeeded tip's job (`job_id`), amount (`tip_cents`), whether Stripe made its
    transfer (`tip_made`) and whether it was reversed since (`tip_reversed`): our rows only,
    never a live Stripe call, never a Stripe id."""
    return TipTransferRepository.payout_facts()
