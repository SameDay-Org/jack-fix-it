"""The typed intake question schema (D8.3, #44). Fixture questions only, except the seed test."""

from typing import Any

import pytest
from pydantic import ValidationError

from app.modules.categories.intake import (
    INTAKE_QUESTIONS,
    BooleanQuestion,
    ChoiceOption,
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
    # Cleaning and handyman options get no description or icon yet (a later decision).
    assert all(o.description is None and o.icon is None for o in frequency.options)
    [tasks] = entries["handyman"]
    assert isinstance(tasks, TextQuestion)
    assert (tasks.key, tasks.required, tasks.max_length) == ("tasks", True, 1000)


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


# Job lists (D8.3, decided by Cesar on 2026-10-22): value -> icon key, hand-written on purpose.
EXPECTED_JOBS = {
    "painting": {
        "interior": "paint-interior",
        "ceilings": "paint-ceiling",
        "doors_trim": "paint-trim",
        "cabinets": "paint-cabinets",
        "exterior": "paint-exterior",
        "fence_deck": "paint-fence",
        "touch_ups": "paint-touchup",
    },
    "lawn-landscaping": {
        "mowing": "lawn-mow",
        "hedges": "lawn-hedge",
        "cleanup": "lawn-cleanup",
        "beds_mulch": "lawn-mulch",
        "planting": "lawn-plant",
        "sod": "lawn-sod",
    },
    "moving-assembly": {
        "furniture_assembly": "assembly-furniture",
        "tv_mounting": "assembly-tv",
        "wall_hanging": "assembly-hang",
        "loading": "moving-load",
        "in_home_move": "moving-rearrange",
        "packing": "moving-pack",
    },
}
JOBS_LABELS = {"en": "Which jobs do you need?", "es": "¿Qué trabajos necesitas?"}
JOBS_HELP = {
    "en": "Pick all that apply, then tell us the details in your description.",
    "es": "Elige todas las que apliquen y cuéntanos los detalles en tu descripción.",
}


def illustrated(value: str, **changes: Any) -> dict[str, Any]:
    return {**option(value), "description": labels(f"{value} covers"), "icon": "paint-x", **changes}


def test_option_description_and_icon_are_optional() -> None:
    plain = ChoiceOption.model_validate(option("small"))
    full = ChoiceOption.model_validate(illustrated("large", icon="assembly-tv-2"))

    assert (plain.description, plain.icon) == (None, None)
    assert full.description == {"en": "large covers en", "es": "large covers es"}
    assert full.icon == "assembly-tv-2"
    at_the_limits = illustrated("x", description={"en": "e" * 160, "es": "s" * 160}, icon="a" * 40)
    assert ChoiceOption.model_validate(at_the_limits).icon == "a" * 40


@pytest.mark.parametrize(
    "changes",
    [
        {"icon": "Paint-interior"},
        {"icon": "paint_interior"},
        {"icon": "-paint"},
        {"icon": "paint-"},
        {"icon": "paint--interior"},
        {"icon": "a" * 41},
        {"icon": ""},
        {"icon": "https://example.com/paint.svg"},
        {"icon": "<svg><path d='M0 0'/></svg>"},
        {"icon": "../paint"},
        {"description": {"en": "e" * 161, "es": "s"}},
        {"description": {"en": "e", "es": "s" * 161}},
        {"description": {"en": "Walls only"}},
        {"description": {"en": "Walls", "es": "  "}},
        {"description": "Walls"},
        {"image_url": "https://example.com/paint.svg"},
    ],
    ids=[
        "icon_uppercase",
        "icon_underscore",
        "icon_leading_dash",
        "icon_trailing_dash",
        "icon_double_dash",
        "icon_41_chars",
        "icon_empty",
        "icon_url",
        "icon_raw_svg",
        "icon_path",
        "description_en_161",
        "description_es_161",
        "description_only_en",
        "description_blank_es",
        "description_not_localized",
        "unknown_field",
    ],
)
def test_option_description_and_icon_optional_and_validated(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ChoiceOption.model_validate(illustrated("small", **changes))
    # Inside a question too: the whole list is refused.
    question = with_question(1, options=[illustrated("small", **changes), option("large")])
    with pytest.raises(ValidationError):
        INTAKE_QUESTIONS.validate_python(question)


@pytest.mark.parametrize("slug", sorted(EXPECTED_JOBS))
def test_seed_three_categories_have_jobs_multi_choice_min_one(slug: str) -> None:
    entries = {entry.slug: entry.intake_questions for entry in load_seed_data()}

    [jobs] = entries[slug]
    assert isinstance(jobs, MultiChoiceQuestion)
    assert (jobs.key, jobs.required, jobs.min_selected, jobs.max_selected) == (
        "jobs",
        True,
        1,
        None,
    )
    assert (jobs.labels, jobs.help) == (JOBS_LABELS, JOBS_HELP)
    assert {o.value: o.icon for o in jobs.options} == EXPECTED_JOBS[slug]
    assert [o.value for o in jobs.options] == list(EXPECTED_JOBS[slug])  # the order shown
    for o in jobs.options:
        # The job's name, then what it covers; both in en and es (tú), no promises.
        assert o.description is not None
        assert set(o.labels) == set(o.description) == {"en", "es"}
        for text in (*o.labels.values(), *o.description.values()):
            assert text == text.strip()
            assert text[0].isupper()
            assert not any(word in text.lower() for word in ("licens", "insur", "guarant"))


def test_seed_option_values_and_icons_unique_per_question() -> None:
    for entry in load_seed_data():
        for question in entry.intake_questions:
            if not isinstance(question, SingleChoiceQuestion | MultiChoiceQuestion):
                continue
            values = [o.value for o in question.options]
            icons = [o.icon for o in question.options if o.icon is not None]
            assert len(set(values)) == len(values), (entry.slug, question.key)
            assert len(set(icons)) == len(icons), (entry.slug, question.key)
    every_icon = [icon for jobs in EXPECTED_JOBS.values() for icon in jobs.values()]
    assert len(set(every_icon)) == len(every_icon)  # one illustration per job, app-wide
