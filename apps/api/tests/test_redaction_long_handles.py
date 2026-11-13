"""A handle longer than its rule counts is masked to the end of its token (#241).

The handle rules count characters: 30 after "@" or a platform word, 20 in a cashtag. The mask
used to stop there, so "@" and 40 letters showed the last 10. The rest of the token is masked
on top of what the rules in order mask (app.redaction._TOKEN_RESTS): what was hidden stays
hidden, and a text with no long token is redacted exactly as before.
"""

import random
import re
from typing import Final, cast

import pytest

from app import redaction
from app.redaction import (
    _MARKED,
    _MARKS,
    _SEPARATORS,
    _TOKEN_RESTS,
    MASK,
    PLATFORM_HANDLE,
    RedactionResult,
    _clean,
    _hidden,
    redact_address_contacts,
    redact_contacts,
    redact_text,
)
from tests.helpers import TIMED_RUNS
from tests.test_redaction import _REFERENCE_PATTERN, _REFERENCE_TEXT, KNOWN, _cpu_seconds

TITLO: Final = chr(0x0483)  # a combining mark: it stays glued to its letter
LOW_LINE: Final = chr(0xFF3F)  # the fullwidth low line, a separator form of the "@" handle
# At the count (30) and under it, as before; the first one over it; the lengths of the issue.
LENGTHS: Final = [12, 30, 31, 39, 40, 41, 100, 500, 5000]
# The piece each handle shape repeats.
SHAPES: Final = {
    "letters": "jackfixit",
    "digits": "20261112",
    "dots": "ja.kq",
    "underscores": "ja_kq",
    "dashes": "ja-kq",
    "mixed": "j0.k_q-9",
    "separator_runs": "ja._-kq",
    "accented": "joséñu",
    "marked": "k" + TITLO,
    "low_lines": "ja" + LOW_LINE + "kq",
}
SENTENCES: Final = [
    "{}",
    "ping me {} after work please",
    "my handle is {}, thanks",
    "escríbeme a {} mañana por favor",
    "mi usuario es {} y respondo rápido",
]


def _body(piece: str, length: int) -> str:
    """`piece` repeated to `length` characters, the last one a letter: a handle ends on a word
    character, and what follows it (a period, a dash) is the sentence's."""
    return (piece * length)[: length - 1] + "k"


@pytest.mark.parametrize("length", LENGTHS)
@pytest.mark.parametrize("piece", SHAPES.values(), ids=SHAPES.keys())
def test_a_handle_of_any_length_is_masked_whole(piece: str, length: int) -> None:
    """AC1: no character of the handle is left, alone or in an EN or ES sentence, and the
    words around it are untouched."""
    handle = "@" + _body(piece, length)

    for sentence in SENTENCES:
        text = sentence.format(handle)
        assert redact_contacts(text) == RedactionResult(sentence.format(MASK), True), sentence


@pytest.mark.parametrize("length", LENGTHS)
@pytest.mark.parametrize("char", ["a", "7", "_"])
def test_a_run_of_one_character_is_masked_whole(char: str, length: int) -> None:
    handle = "@" + char * length

    assert redact_contacts(handle) == RedactionResult(MASK, True)
    assert redact_contacts(f"ping {handle} now") == RedactionResult(f"ping {MASK} now", True)


@pytest.mark.parametrize(
    "sentence",
    ["{} and {}", "{} {}", "{}, {}", "{} / {}", "primero {} y si no contesto {}, gracias"],
)
def test_two_long_handles_in_one_message(sentence: str) -> None:
    first, second = "@" + _body("ja.kq", 45), "@" + _body("zu_vw", 300)

    assert redact_contacts(sentence.format(first, second)) == RedactionResult(
        sentence.format(MASK, MASK), True
    )


@pytest.mark.parametrize(
    "sentence",
    ["see {}. Thanks", "({})", "{}!", "{}?", "{}: that is me", "{}...", '"{}"', "{}\nsecond line"],
)
def test_what_follows_a_long_handle_is_untouched(sentence: str) -> None:
    """As after a short handle: the punctuation around the token is the sentence's."""
    for length in (12, 41, 500):
        handle = "@" + _body("ja.kq", length)
        assert redact_contacts(sentence.format(handle)) == RedactionResult(
            sentence.format(MASK), True
        )


@pytest.mark.parametrize("length", LENGTHS)
def test_the_spaced_form_and_the_exempt_words_follow_the_same_rule(length: int) -> None:
    """ "@ name_1" is a handle when the token holds a digit, a "_" or a "."; "@home" and "@5pm"
    are exempt only as the whole token, so a longer token that starts with them is a handle."""
    for text in (
        "find me @ " + _body("ja_kq", length) + " ok",
        "find me @home" + _body("ja.kq", length) + " ok",
        "find me @5pm" + _body("jakq", length) + " ok",
    ):
        assert redact_contacts(text) == RedactionResult(f"find me {MASK} ok", True)


PLATFORM_AND_CASHTAG: Final = [
    ("ig @{} ok", "ja.kq"),
    ("my insta is {} ok", "ja.kq"),
    ("insta: {} ok", "ja-kq"),
    ("venmo {} ok", "ja_1."),
    ("pay ${} ok", "ja-kq"),
    ("cashapp ${} ok", "ja-kq"),
]


@pytest.mark.parametrize("length", [21, 31, 40, 100, 5000])
@pytest.mark.parametrize(("sentence", "piece"), PLATFORM_AND_CASHTAG)
def test_a_long_platform_id_or_cashtag_reads_as_a_short_one(
    sentence: str, piece: str, length: int
) -> None:
    """The platform rule and the cashtag stop at a "." or a "-" inside the count and showed
    the chain after it ("ig @" and a long dotted name). Where the piece inside the count is a
    handle on its own, as in these cases, the rest of the token is masked with it, as the short
    token of the same shape is. A piece the rule does not mask has no rest (the gaps in
    test_chat_redaction_corpus.py)."""
    short = redact_contacts(sentence.format(_body(piece, 12)))
    assert short.redacted
    assert "ja" not in short.text

    assert redact_contacts(sentence.format(_body(piece, length))) == short


@pytest.mark.parametrize("inside", ["ig-jdoe1", "305-555-0199"])
def test_a_long_handle_holding_what_an_earlier_rule_reads_is_one_token(inside: str) -> None:
    """A long token may hold a piece a rule before the handle rule masks (a platform id, a
    phone). The handle's rest is read in the text as typed, through that mask, to the token's
    end: the letters after the piece are the same handle."""
    handle = "@" + "k" * 40 + "." + inside + "." + "w" * 40

    assert redact_contacts(handle) == RedactionResult(MASK, True)
    assert redact_contacts(f"ping me {handle} ok") == RedactionResult(f"ping me {MASK} ok", True)


def test_every_entry_point_masks_the_long_handle() -> None:
    handle = "@" + _body("ja.kq", 60)

    assert redact_text(f"ping me {handle} ok", KNOWN) == RedactionResult(f"ping me {MASK} ok", True)
    assert redact_address_contacts(f"Blue gate, ask {handle} ok", KNOWN) == RedactionResult(
        f"Blue gate, ask {MASK} ok", True
    )


# --- Only the rest of a long token changes ----------------------------------------------------

_TOKEN_CHAR: Final = re.compile(rf"[\w{_SEPARATORS}{_MARKS}]")
# More handle characters in a row than the shortest count (the cashtag's 20), marks aside.
_LONG_RUN: Final = re.compile(rf"(?:[\w{_SEPARATORS}]{_MARKED}){{21,}}")
_PIECES: Final = [
    "@", "@", "@", "@ ", " @", "$", "$", "#", ":", "(", ")", ",", "!", "/", " ", " ", " ", " ",
    ".", ".", "_", "-", "..", "._", LOW_LINE, chr(0x2026), chr(0x093F), TITLO,
    "a", "b", "z", "é", "ñ", "7", "0", "12", "305", "555", "0199", "1250", "5pm", "noon",
    "home", "mañana", "tomorrow", "call", "me", "at", "en", "is", "es", "the", "my", "insta",
    "ig", "venmo", "gmail", "whatsapp", "dot", "punto", "com", ".com", "St", "Ave", "Dr",
    "Ocean", "Main", "apt", "4B", "Calle", "jdoe", "juan.perez77", "jane@gmail.com",
    "www.", "http://", "x_1", "unit", "SW", "72nd", "$jdoe", "#12",
    "ig ", "ig-", "insta: ", "venmo ", "fb/", "ig @", "telegram ", "cashapp $",
]  # fmt: skip
_LETTERS: Final = "abcdefghijklmnopqrstuvwxyzñé0123456789"
# What a rule after the handle rule would read if the long handle's tail were shown.
_TAILS: Final = ["", "", "1250", "9", "apt", "Calle", "8800", "unit", "305", "3055550199"]


def _long_run(rng: random.Random) -> str:
    length = rng.choice([19, 20, 21, 29, 30, 31, 32, 40, 41, 60, 100])
    kind = rng.randrange(4)
    if kind == 0:
        run = rng.choice("akq7") * length
    elif kind == 1:
        run = "".join(rng.choice(_LETTERS) for _ in range(length))
    elif kind == 2:
        run = "".join(rng.choice(_LETTERS + "._-") for _ in range(length))
    else:
        run = "".join(rng.choice(_LETTERS) + rng.choice(["", TITLO]) for _ in range(length))
    return run + rng.choice(_TAILS)


def _sample(rng: random.Random) -> str:
    parts: list[str] = []
    for _ in range(rng.randint(1, 12)):
        if rng.random() < 0.2:
            parts.append(rng.choice(["@", "@", "@ ", "$", "ig @", "insta: ", ""]) + _long_run(rng))
        else:
            parts.append(rng.choice(_PIECES))
        if rng.random() < 0.35:
            parts.append(" ")
    return "".join(parts)


def _positions(spans: list[tuple[int, int]]) -> set[int]:
    return {index for start, end in spans for index in range(start, end)}


@pytest.mark.parametrize("addresses", [True, False], ids=["all_rules", "address_field"])
def test_only_the_rest_of_a_long_token_changes(
    monkeypatch: pytest.MonkeyPatch, addresses: bool
) -> None:
    """On random texts, against the same rules without the rests (the filter before #241):
    nothing it hid is shown; what is hidden on top are handle characters that continue one of
    its masks, so no other word is taken; the same texts are flagged (the offender count and
    the sender's warning do not move); and a text with no long run is hidden as before."""
    rng = random.Random(241)  # noqa: S311 - reproducible test data, not secrets
    texts = [_clean(_sample(rng)) for _ in range(700)]
    now = [_positions(_hidden(text, addresses=addresses)) for text in texts]
    monkeypatch.setattr(redaction, "_TOKEN_RESTS", {})
    grew = 0

    for text, hidden in zip(texts, now, strict=True):
        before = _positions(_hidden(text, addresses=addresses))
        assert before <= hidden, ascii(text)
        assert bool(before) == bool(hidden), ascii(text)
        more = hidden - before
        for index in more:
            assert _TOKEN_CHAR.match(text, index), ascii(text)
            first = index
            while first - 1 in more:
                first -= 1
            assert first - 1 in before, ascii(text)
        if more:
            assert _LONG_RUN.search(text), ascii(text)
            grew += 1
    assert grew > 100  # the sample does hold long handles


# --- Cost --------------------------------------------------------------------------------------

# In references (see test_redaction.py, #300): this thread's CPU time, as a multiple of a regex
# timed in the same round, so a slow or loaded machine stretches both. Each ceiling is about
# five times what the dev machine takes (1.0 s, 2.2 s, 0.9 s and 0.7 s; the reference 0.16 s);
# a scan that read a token once per handle or per character would take minutes.
PATHOLOGICAL: Final = {
    # Only the first "@a" is read as a handle; what the others are is not this test's matter.
    "100000_handles": ("@a" * 100_000, None, 30),
    "1mb_handle": ("@" + "a" * 1_000_000, MASK, 70),
    "separator_tail": ("@a" + "." * 300_000, MASK + "." * 300_000, 30),
    "5000_long_handles": (("@" + "a" * 40 + " ") * 5_000, (MASK + " ") * 5_000, 25),
}


@pytest.mark.parametrize(
    ("text", "expected", "ceiling"), PATHOLOGICAL.values(), ids=PATHOLOGICAL.keys()
)
def test_pathological_handles_are_read_in_linear_time(
    text: str, expected: str | None, ceiling: int
) -> None:
    """AC2. The first round under the ceiling passes: one stalled round cannot fail it, and a
    scan that is no longer linear fails every round."""
    rounds: list[tuple[float, float]] = []
    results: list[RedactionResult] = []
    while len(rounds) < TIMED_RUNS:
        reference = _cpu_seconds(lambda: _REFERENCE_PATTERN.search(_REFERENCE_TEXT))
        rounds.append((reference, _cpu_seconds(lambda: results.append(redact_contacts(text)))))
        # The smallest reference so far: a round that read it high cannot loosen the ceiling.
        if rounds[-1][1] < ceiling * min(reference for reference, _ in rounds):
            break
    else:
        pytest.fail(f"over {ceiling} references in all {TIMED_RUNS} rounds: {rounds}")

    assert results[-1].redacted
    if expected is not None:
        assert results[-1].text == expected


class _CountingRest:
    """A rest pattern that adds up the characters it reads."""

    def __init__(self, pattern: re.Pattern[str]) -> None:
        self.pattern = pattern
        self.read = 0

    def match(self, string: str, pos: int = 0) -> re.Match[str] | None:
        found = self.pattern.match(string, pos)
        self.read += found.end() - pos if found is not None else 1
        return found


def test_a_chain_of_platform_handles_in_one_token_is_read_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ "ig-" and a name, again and again, is one token and a platform handle every 30
    characters or so. The first handle's rest covers the others': the token is read twice (as
    the rule left it, then as typed), not once per handle, which would be quadratic."""
    text = "ig-" + "abcd-ig-" * 2_500 + "z"
    counting = _CountingRest(_TOKEN_RESTS[PLATFORM_HANDLE])
    monkeypatch.setitem(_TOKEN_RESTS, PLATFORM_HANDLE, cast(re.Pattern[str], counting))

    assert redact_contacts(text) == RedactionResult(MASK, True)
    assert counting.read <= 2 * len(text)
