"""Glue variants of the customer's own street (#172 round 8): every separator between the pieces
of an address, generated, so a class of spellings is closed at once rather than one case at a
time. Shared by the unit test (every variant) and the endpoint test (a sample)."""

import itertools
import random
from collections.abc import Iterator

# What may stand between two pieces of an address as typed.
GLUE_SEPARATORS = (" ", "", ".", ". ", ",", ", ", "-", "/", ".,")

# (stored line, phrases as pieces): number first and name first; directions, units, suffixes.
GLUE_FIXTURES: list[tuple[str, list[list[str]]]] = [
    ("742 Evergreen Terrace", [["742", "evergreen", "ter"], ["evergreen", "ter", "742"]]),
    (
        "123 Main Street NW",
        [["123", "main", "st", "nw"], ["main", "st", "nw", "123"], ["123", "nw", "main"]],
    ),
    (
        "45 Martin Luther King Jr Blvd",
        [["45", "martin", "luther", "king"], ["martin", "luther", "king", "45"]],
    ),
    ("100 S.E. Ocean Blvd Apt 4B", [["100", "se", "ocean", "blvd"], ["ocean", "blvd", "100"]]),
    ("8800 SW 72nd St Unit 12", [["8800", "sw", "72nd", "st"], ["72nd", "st", "8800"]]),
    ("1200 Brickell Ave #3301", [["1200", "brickell", "ave"], ["brickell", "ave", "1200"]]),
    ("12 O'Brien Rd", [["12", "o'brien", "rd"], ["o'brien", "rd", "12"]]),
]


def glue_variants(pieces: list[str]) -> Iterator[str]:
    """Every way to join `pieces` with GLUE_SEPARATORS. Nothing is glued straight onto the
    house number: "742evergreen" is no longer the number 742."""
    for separators in itertools.product(GLUE_SEPARATORS, repeat=len(pieces) - 1):
        pairs = zip(separators, pieces[:-1], pieces[1:], strict=True)
        if any(sep == "" and (left.isdigit() or right.isdigit()) for sep, left, right in pairs):
            continue
        yield "".join(piece + sep for piece, sep in zip(pieces, (*separators, ""), strict=True))


def all_glue_cases() -> list[tuple[str, str, str, str]]:
    """(stored line, text, house number, first name word) for every variant."""
    cases = []
    for line, phrases in GLUE_FIXTURES:
        number = line.split()[0]
        for pieces in phrases:
            name = next(p for p in pieces if not p.isdigit() and p not in ("nw", "se", "sw"))
            for variant in glue_variants(pieces):
                cases.append((line, f"Meet me at {variant} today", number, name))
    return cases


def glue_sample(count: int) -> list[tuple[str, str, str, str]]:
    return random.Random(8).sample(all_glue_cases(), count)  # noqa: S311 - seeded test data
