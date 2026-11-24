"""Splitting the API tests between CI jobs (#613): with PYTEST_SHARD="<index>/<count>" set, a
run keeps the test files of one share only (tests/conftest.py's collection hook). The split is
computed from the collected files alone, so every job of the same commit makes the same one,
and together the jobs run every test once. Unset (local runs), nothing changes.

The weight of a file is its line count, which reads the same on every OS and line ending: a
proxy for its time. The heaviest file goes first, each to the lightest share so far.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import Final

SHARD_ENV: Final = "PYTEST_SHARD"


def parse_shard(spec: str) -> tuple[int, int]:
    """("1/2") -> (1, 2). ValueError unless it is <index>/<count> with 1 <= index <= count."""
    index, slash, count = spec.strip().partition("/")
    try:
        shard, shards = int(index), int(count)
    except ValueError:
        shard, shards = 0, 0
    if not slash or not 1 <= shard <= shards:
        raise ValueError(f"not <index>/<count>: {spec!r}")
    return shard, shards


def weight(path: Path) -> int:
    """A file's share of the run: its line count."""
    return path.read_bytes().count(b"\n") + 1


def split(weights: Mapping[str, int], count: int) -> dict[str, int]:
    """Each file's share, 1 to `count`: the heaviest first (ties by name), each to the share
    with the least weight so far (the lowest one on a tie). The same files give the same
    split."""
    loads = [0] * count
    shares: dict[str, int] = {}
    for name in sorted(weights, key=lambda name: (-weights[name], name)):
        lightest = min(range(count), key=lambda share: (loads[share], share))
        shares[name] = lightest + 1
        loads[lightest] += weights[name]
    return shares
