"""The typed intake question schema (D8.3, #44). Fixture questions only, except the seed test."""

from typing import Any

import pytest
from pydantic import ValidationError

from app.modules.categories.intake import (
    INTAKE_QUESTIONS,
    BooleanQuestion,
    IntegerQuestion,
    MultiChoiceQuestion,
    SingleChoiceQuestion,
    TextQuestion,
)
from app.modules.categories.service import load_seed_data


def labels(text: str) -> dict[str, str]:
    return {"en": f"{text} en", "es": f"{text} es"}


def option(value: str) -> dict[str, Any]:
    return {"value": value, "labels": labels(value)}


# One question of each type; the request tests answer these.
FIXTURE_QUESTIONS: list[dict[str, Any]] = [
    {"key": "rooms", "type": "integer", "required": True, "labels": labels("Rooms"), "min": 1,
     "max": 6},
    {"key": "size", "type": "single_choice", "required": True, "labels": labels("Size"),
     "options": [option("small"), option("large")]},
    {"key": "extras", "type": "multi_choice", "required": False, "labels": labels("Extras"),
     "options": [option("oven"), option("fridge"), option("windows")], "min_selected": 1,
     "max_selected": 2},
    {"key": "pets", "type": "boolean", "required": False, "labels": labels("Pets"),
     "help": labels("Pets help")},
    {"key": "notes", "type": "text", "required": False, "labels": labels("Notes"),
     "max_length": 20},
]  # fmt: skip


def with_question(index: int, **changes: Any) -> list[dict[str, Any]]:
    questions = [dict(question) for question in FIXTURE_QUESTIONS]
    questions[index].update(changes)
    return questions


def test_fixture_questions_parse_into_their_types() -> None:
    questions = INTAKE_QUESTIONS.validate_python(FIXTURE_QUESTIONS)

    assert [type(q) for q in questions] == [
        IntegerQuestion,
        SingleChoiceQuestion,
        MultiChoiceQuestion,
        BooleanQuestion,
        TextQuestion,
    ]


def test_seed_file_parses_with_typed_questions() -> None:
    entries = {entry.slug: entry.intake_questions for entry in load_seed_data()}

    cleaning = entries["house-cleaning"]
    assert [(q.key, q.type, q.required) for q in cleaning] == [
        ("bedrooms", "integer", True),
        ("bathrooms", "integer", True),
        ("square_feet", "integer", False),
        ("frequency", "single_choice", True),
    ]
    bedrooms, bathrooms, square_feet, frequency = cleaning
    assert isinstance(bedrooms, IntegerQuestion)
    assert (bedrooms.min, bedrooms.max) == (0, 10)
    assert isinstance(bathrooms, IntegerQuestion)
    assert (bathrooms.min, bathrooms.max) == (1, 10)
    assert isinstance(square_feet, IntegerQuestion)
    assert (square_feet.min, square_feet.max) == (100, 20_000)
    assert isinstance(frequency, SingleChoiceQuestion)
    assert [o.value for o in frequency.options] == ["one_time", "recurring"]
    [tasks] = entries["handyman"]
    assert isinstance(tasks, TextQuestion)
    assert (tasks.key, tasks.required, tasks.max_length) == ("tasks", True, 1000)
    # Their content comes from Cesar and the partners.
    for slug in ("painting", "lawn-landscaping", "moving-assembly"):
        assert entries[slug] == []


def test_duplicate_question_key_rejected() -> None:
    with pytest.raises(ValidationError, match="duplicate question keys: rooms"):
        INTAKE_QUESTIONS.validate_python(with_question(1, key="rooms"))


@pytest.mark.parametrize(
    "questions",
    [
        with_question(1, options=[option("small"), option("small")]),
        with_question(1, options=[option("small")]),
        with_question(1, options=[option(f"o{n}") for n in range(21)]),
        with_question(1, options=[option("small"), option("Large")]),
        with_question(2, min_selected=3, max_selected=2),
        with_question(2, max_selected=4),
        with_question(2, min_selected=-1),
    ],
    ids=[
        "duplicate_value",
        "one_option",
        "21_options",
        "value_not_a_key",
        "min_over_max",
        "max_over_options",
        "negative_min",
    ],
)
def test_choice_options_unique_and_bounded(questions: list[dict[str, Any]]) -> None:
    with pytest.raises(ValidationError):
        INTAKE_QUESTIONS.validate_python(questions)


def test_choice_bounds_at_the_limits_accepted() -> None:
    twenty = [option(f"o{n}") for n in range(20)]
    INTAKE_QUESTIONS.validate_python(with_question(1, options=twenty))
    INTAKE_QUESTIONS.validate_python(with_question(2, min_selected=3, max_selected=3))
    INTAKE_QUESTIONS.validate_python(with_question(2, min_selected=0, max_selected=None))


@pytest.mark.parametrize(
    ("bounds", "valid"),
    [
        ({"min": 5, "max": 4}, False),
        ({"min": 4, "max": 4}, True),
        ({"min": True, "max": 4}, False),
        ({"min": 1, "max": 4.5}, False),
        ({"min": "1", "max": 4}, False),
    ],
    ids=["min_over_max", "min_equals_max", "bool_bound", "float_bound", "string_bound"],
)
def test_integer_min_le_max(bounds: dict[str, Any], valid: bool) -> None:
    questions = with_question(0, **bounds)
    if valid:
        INTAKE_QUESTIONS.validate_python(questions)
    else:
        with pytest.raises(ValidationError):
            INTAKE_QUESTIONS.validate_python(questions)


@pytest.mark.parametrize(
    "questions",
    [
        with_question(0, labels={"en": "Rooms"}),
        with_question(0, labels={"en": "  ", "es": "Habitaciones"}),
        with_question(3, help={"en": "Only English"}),
        with_question(1, options=[option("small"), {"value": "large", "labels": {"es": "x"}}]),
    ],
    ids=["missing_es", "blank_en", "help_missing_es", "option_missing_en"],
)
def test_labels_need_en_and_es(questions: list[dict[str, Any]]) -> None:
    with pytest.raises(ValidationError):
        INTAKE_QUESTIONS.validate_python(questions)


def test_labels_may_add_other_locales() -> None:
    [rooms, *_] = INTAKE_QUESTIONS.validate_python(
        with_question(0, labels={"en": "Rooms", "es": "Habitaciones", "pt": "Quartos"})
    )

    assert rooms.labels["pt"] == "Quartos"


@pytest.mark.parametrize(
    "questions",
    [
        with_question(0, placeholder="2"),
        with_question(1, options=[option("small"), {**option("large"), "price": 1}]),
        with_question(0, type="number"),
        with_question(3, max_length=10),
        with_question(0, key="Rooms"),
        with_question(0, key="1rooms"),
        with_question(0, key="r" * 41),
        with_question(0, required="yes"),
    ],
    ids=[
        "question_field",
        "option_field",
        "unknown_type",
        "field_of_another_type",
        "uppercase_key",
        "key_starts_with_digit",
        "key_too_long",
        "required_not_a_bool",
    ],
)
def test_unknown_question_field_rejected(questions: list[dict[str, Any]]) -> None:
    with pytest.raises(ValidationError):
        INTAKE_QUESTIONS.validate_python(questions)


@pytest.mark.parametrize("max_length", [0, 1001])
def test_text_max_length_bounded(max_length: int) -> None:
    with pytest.raises(ValidationError):
        INTAKE_QUESTIONS.validate_python(with_question(4, max_length=max_length))
