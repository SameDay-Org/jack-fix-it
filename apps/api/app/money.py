"""How a price splits between the pro and the platform (#246; Cesar, 2026-10-29).

The one place the split is computed, so a quote's displayed payout and the amounts a job
freezes at payment (#58, #61) cannot drift. Integer cents only: the platform fee is the amount
times the take rate in basis points over 10,000, rounded half up to the cent, and the pro gets
the rest. The platform absorbs Stripe's card fee, so the customer pays exactly the amount.
"""

from typing import Final, NamedTuple

BPS_DENOMINATOR: Final = 10_000  # basis points in a whole


class Split(NamedTuple):
    pro_payout_cents: int
    platform_fee_cents: int


def split_amount(amount_cents: int, take_rate_bps: int) -> Split:
    """`amount_cents` (0 or more) split at `take_rate_bps` (0..10,000): the fee rounds half up,
    and the payout is the amount minus the fee, so the two always add up to the amount."""
    if type(amount_cents) is not int or amount_cents < 0:
        raise ValueError("amount_cents must be a non-negative integer")
    if type(take_rate_bps) is not int or not 0 <= take_rate_bps <= BPS_DENOMINATOR:
        raise ValueError("take_rate_bps must be an integer from 0 to 10000")
    fee = (amount_cents * take_rate_bps + BPS_DENOMINATOR // 2) // BPS_DENOMINATOR
    return Split(pro_payout_cents=amount_cents - fee, platform_fee_cents=fee)
