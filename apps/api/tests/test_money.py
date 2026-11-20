"""app.money.split_amount: the pro's payout and the platform's fee (#246); and
cancellation_split: a cancelled job's fee kept and refund (#69)."""

import random
from decimal import ROUND_HALF_UP, Decimal

import pytest

from app.money import (
    BPS_DENOMINATOR,
    CancellationSplit,
    Split,
    cancellation_split,
    split_amount,
)

INT4_MAX = 2_147_483_647


@pytest.mark.parametrize(
    ("amount", "bps", "payout", "fee"),
    [
        (10_000, 1500, 8500, 1500),
        (9_999, 1500, 8499, 1500),  # 1499.85 rounds to 1500
        (1, 1500, 1, 0),  # 0.15 rounds to 0
        (98_765, 1500, 83_950, 14_815),  # 14814.75 rounds up
        (10, 500, 9, 1),  # exactly 0.5 rounds up
        (1, 5000, 0, 1),  # exactly 0.5 rounds up
        (3, 5000, 1, 2),  # exactly 1.5 rounds up
        (0, 1500, 0, 0),
        (INT4_MAX, 1500, 1_825_361_100, 322_122_547),
    ],
)
def test_split_examples(amount: int, bps: int, payout: int, fee: int) -> None:
    assert split_amount(amount, bps) == Split(pro_payout_cents=payout, platform_fee_cents=fee)


@pytest.mark.parametrize("amount", [0, 1, 9_999, 10_000, INT4_MAX])
def test_split_at_zero_and_full_take_rate(amount: int) -> None:
    assert split_amount(amount, 0) == (amount, 0)
    assert split_amount(amount, BPS_DENOMINATOR) == (0, amount)


def _oracle_fee(amount: int, bps: int) -> int:
    """The fee by decimal arithmetic, independent of the integer formula."""
    exact = Decimal(amount) * Decimal(bps) / Decimal(BPS_DENOMINATOR)
    return int(exact.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _cases() -> list[tuple[int, int]]:
    """Every amount to 2,000 cents at the edge and common rates, plus seeded random pairs over
    the whole int4 range and every rate."""
    rates = [0, 1, 499, 500, 1499, 1500, 1501, 3333, 5000, 9999, 10_000]
    exhaustive = [(amount, bps) for amount in range(2_001) for bps in rates]
    rng = random.Random(246)  # noqa: S311 - reproducible test data, not secrets
    sampled = [(rng.randint(0, INT4_MAX), rng.randint(0, BPS_DENOMINATOR)) for _ in range(20_000)]
    return exhaustive + sampled


def test_split_property_payout_plus_fee_is_the_amount() -> None:
    for amount, bps in _cases():
        payout, fee = split_amount(amount, bps)
        assert type(payout) is int
        assert type(fee) is int
        assert payout + fee == amount, (amount, bps)
        assert 0 <= fee <= amount, (amount, bps)
        assert 0 <= payout <= amount, (amount, bps)
        assert fee == _oracle_fee(amount, bps), (amount, bps)


@pytest.mark.parametrize(
    ("amount", "bps"),
    [(-1, 1500), (100, -1), (100, 10_001), (100.0, 1500), (100, 1500.0), (True, 1500), (100, True)],
    ids=[
        "negative_amount",
        "negative_bps",
        "bps_above_whole",
        "float_amount",
        "float_bps",
        "bool_amount",
        "bool_bps",
    ],
)
def test_split_refuses_invalid_input(amount: object, bps: object) -> None:
    with pytest.raises(ValueError, match="must be"):
        split_amount(amount, bps)  # type: ignore[arg-type]  # the runtime guard under test


# --- cancellation_split (#69) -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("total", "price", "bps", "fee", "refund"),
    [
        (21_400, 20_000, 1500, 3_000, 18_400),  # tax refunded in full
        (21_400, 20_000, 0, 0, 21_400),  # before On my way: free
        (10_003, 10_003, 1500, 1_500, 8_503),  # 1500.45 rounds down
        (10_010, 10_010, 1500, 1_502, 8_508),  # exactly 1501.5 rounds up
        (1_000, 999, 1500, 150, 850),  # 149.85 rounds up
        (1, 1, 5000, 1, 0),  # exactly 0.5 rounds up: nothing left to refund
        (1, 1, 4999, 0, 1),  # 0.4999 rounds down
        (5_000, 4_000, BPS_DENOMINATOR, 4_000, 1_000),  # the whole price, the tax back
    ],
)
def test_cancellation_split_examples(
    total: int, price: int, bps: int, fee: int, refund: int
) -> None:
    split = cancellation_split(total, price, bps)
    assert split == CancellationSplit(fee_cents=fee, refund_cents=refund)
    assert split.fee_cents + split.refund_cents == total


def test_cancellation_split_property_fee_plus_refund_is_the_total() -> None:
    """The fee is the take rate's rounding of the price (split_amount's fee), and the refund
    the rest of the total: never negative, the two always the total."""
    rng = random.Random(69)  # noqa: S311 - reproducible test data, not secrets
    for _ in range(5_000):
        price = rng.randint(1, 1_000_000)
        total = price + rng.randint(0, 100_000)
        bps = rng.randint(0, BPS_DENOMINATOR)
        split = cancellation_split(total, price, bps)
        assert split.fee_cents == _oracle_fee(price, bps)
        assert split.fee_cents + split.refund_cents == total
        assert 0 <= split.fee_cents <= price
        assert split.refund_cents >= total - price


@pytest.mark.parametrize(
    ("total", "price", "bps"),
    [
        (100, 0, 1500),  # no price
        (100, 101, 1500),  # a price above what was paid
        (100, 100, -1),
        (100, 100, 10_001),
        (100.0, 100, 1500),
        (100, True, 1500),
    ],
)
def test_cancellation_split_refuses_invalid_input(
    total: object, price: object, bps: object
) -> None:
    with pytest.raises(ValueError, match=r"must be|need"):
        cancellation_split(total, price, bps)  # type: ignore[arg-type]
