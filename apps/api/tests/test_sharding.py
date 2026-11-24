"""The split of the API tests between CI jobs (#613, tests/sharding.py): every test runs in
exactly one job, and the jobs of one commit split alike."""

import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

from tests.sharding import SHARD_ENV, parse_shard, split, weight

API_DIR = Path(__file__).resolve().parents[1]


def test_parse_shard() -> None:
    assert parse_shard("1/2") == (1, 2)
    assert parse_shard(" 2/2 ") == (2, 2)
    for bad in ("", "2", "0/2", "3/2", "a/2", "1/0", "1-2"):
        with pytest.raises(ValueError, match="not <index>/<count>"):
            parse_shard(bad)


def test_split_puts_every_file_in_one_share_and_balances() -> None:
    weights = {f"tests/test_{index:03}.py": (index * 37) % 400 + 1 for index in range(60)}

    shares = split(weights, 3)

    assert set(shares) == set(weights)
    assert set(shares.values()) == {1, 2, 3}
    loads = [sum(w for name, w in weights.items() if shares[name] == s) for s in (1, 2, 3)]
    # Greedy, heaviest first: no share is over its fair part by more than the heaviest file.
    assert max(loads) - min(loads) <= max(weights.values())
    # The same files, in any order, split alike.
    assert split(dict(reversed(list(weights.items()))), 3) == shares


def test_weight_counts_lines_whatever_the_line_ending(tmp_path: Path) -> None:
    unix, windows = tmp_path / "unix.py", tmp_path / "windows.py"
    unix.write_bytes(b"a = 1\nb = 2\n")
    windows.write_bytes(b"a = 1\r\nb = 2\r\n")

    assert weight(unix) == weight(windows) == 3


def _collected(shard: str | None) -> Counter[str]:
    """The tests one run collects, counted by test function: some parameters carry a fresh
    random id at each collection, so ids are compared without them."""
    env = {key: value for key, value in os.environ.items() if key != SHARD_ENV}
    if shard is not None:
        env[SHARD_ENV] = shard
    run = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
        cwd=API_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert run.returncode == 0, run.stdout[-2000:] + run.stderr[-2000:]
    return Counter(line.partition("[")[0] for line in run.stdout.splitlines() if "::" in line)


def test_the_two_ci_shards_run_every_test_once() -> None:
    """CI's two api jobs (PYTEST_SHARD 1/2 and 2/2) together collect exactly what one run
    collects, with nothing in both."""
    everything = _collected(None)
    first, second = _collected("1/2"), _collected("2/2")

    assert first
    assert second
    assert set(first).isdisjoint(second)  # a test function runs in one job only
    assert first + second == everything
