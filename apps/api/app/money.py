"""How a price splits between the pro and the platform (#246; Cesar, 2026-10-29), a
cancelled job's payment between the fee kept and the refund (#69), and what a tip of a
percent comes to (#273).

The one place the split is computed, so a quote's displayed payout and the amounts a job
freezes at payment (#58, #61) cannot drift. Integer cents only: the platform fee is the amount
times the take rate in basis points over 10,000, rounded half up to the cent, and the pro gets
the rest. The platform absorbs Stripe's card fee, so the customer pays exactly the amount.
"""

from typing import Final, NamedTuple

BPS_DENOMINATOR: Final = 10_000  # basis points in a whole
PERCENT_DENOMINATOR: Final = 100  # percents in a whole


class Split(NamedTuple):
    pro_payout_cents: int
    platform_fee_cents: int


class CancellationSplit(NamedTuple):
    fee_cents: int
    refund_cents: int


def split_amount(amount_cents: int, take_rate_bps: int) -> Split:
    """`amount_cents` (0 or more) split at `take_rate_bps` (0..10,000): the fee rounds half up,
    and the payout is the amount minus the fee, so the two always add up to the amount."""
    if type(amount_cents) is not int or amount_cents < 0:
        raise ValueError("amount_cents must be a non-negative integer")
    if type(take_rate_bps) is not int or not 0 <= take_rate_bps <= BPS_DENOMINATOR:
        raise ValueError("take_rate_bps must be an integer from 0 to 10000")
    fee = (amount_cents * take_rate_bps + BPS_DENOMINATOR // 2) // BPS_DENOMINATOR
    return Split(pro_payout_cents=amount_cents - fee, platform_fee_cents=fee)


def tip_amount(base_cents: int, percent: int) -> int:
    """A tip of `percent` (a whole percent, 0 or more) of `base_cents` (0 or more: the job's
    price before tax, #273), in integer cents, rounded half up to the cent as split_amount
    rounds the fee."""
    if type(base_cents) is not int or base_cents < 0:
        raise ValueError("base_cents must be a non-negative integer")
    if type(percent) is not int or percent < 0:
        raise ValueError("percent must be a non-negative integer")
    return (base_cents * percent + PERCENT_DENOMINATOR // 2) // PERCENT_DENOMINATOR


def partial_refund_cents(
    customer_total_cents: int, pro_payout_cents: int, pro_release_cents: int
) -> int:
    """What the customer gets back when an admin releases only `pro_release_cents` of the pro's
    frozen `pro_payout_cents` (#76, a partial resolution of a dispute).

    The customer's total (tax included) is refunded in the share of the payout NOT released:

        refund = customer_total_cents * (pro_payout_cents - pro_release_cents) / pro_payout_cents

    rounded half up to the cent, as the fee is. The platform keeps the rest,
    customer_total_cents - pro_release_cents - refund: its fee (and the tax) in proportion to
    what the pro is paid, never more than the job's fee and tax, never less than 0. The three
    parts add up to the customer's total exactly. Only a true partial split is accepted
    (0 < pro_release_cents < pro_payout_cents), so the refund is at least 1 cent and leaves
    the pro's share in place; a full release or a full refund is its own decision.
    """
    for value in (customer_total_cents, pro_payout_cents, pro_release_cents):
        if type(value) is not int:
            raise ValueError("amounts must be integers")
    if not 0 < pro_release_cents < pro_payout_cents <= customer_total_cents:
        raise ValueError("need 0 < pro_release_cents < pro_payout_cents <= customer_total_cents")
    withheld = pro_payout_cents - pro_release_cents
    return (2 * customer_total_cents * withheld + pro_payout_cents) // (2 * pro_payout_cents)


def cancellation_split(
    customer_total_cents: int, job_price_cents: int, fee_bps: int
) -> CancellationSplit:
    """A cancelled job's payment, split between the fee the platform keeps and the refund
    (#69; Cesar, 2026-10-29).

    The fee is `fee_bps` of the job price (the quote's amount, before tax: the base the take
    rate uses), rounded half up to the cent as split_amount rounds the platform fee; 0 bps is a
    free cancel. The refund is the rest of what the customer paid, tax included:

        fee = job_price_cents * fee_bps / 10,000 (half up)
        refund = customer_total_cents - fee

    so the two add up to the customer's total exactly, and the refund is never negative.
    """
    for value in (customer_total_cents, job_price_cents, fee_bps):
        if type(value) is not int:
            raise ValueError("amounts must be integers")
    if not 0 < job_price_cents <= customer_total_cents:
        raise ValueError("need 0 < job_price_cents <= customer_total_cents")
    fee = split_amount(job_price_cents, fee_bps).platform_fee_cents
    return CancellationSplit(fee_cents=fee, refund_cents=customer_total_cents - fee)
