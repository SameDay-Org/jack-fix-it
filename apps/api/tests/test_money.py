"""app.money.split_amount: the pro's payout and the platform's fee (#246)."""

import random
from decimal import ROUND_HALF_UP, Decimal

import pytest

from app.money import BPS_DENOMINATOR, Split, split_amount

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
