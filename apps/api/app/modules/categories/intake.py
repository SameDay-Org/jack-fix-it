"""Intake questions (D8.3, #44): what a category asks the customer, kept as data in
`categories.intake_questions`, and the check of a request's answers against them.

The schema is documented in docs/intake-questions.md. Labels are data per locale (en and es
required, like `categories.names`), not i18next keys: an admin edits them without a deploy.
"""

from typing import Annotated, Final, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StrictBool,
    StrictInt,
    StringConstraints,
    TypeAdapter,
    model_validator,
)

# Locales every category must name and every question must label; others may be added.
REQUIRED_LOCALES: Final = ("en", "es")
KEY_PATTERN: Final = r"^[a-z][a-z0-9_]{0,39}$"
TEXT_MAX_LENGTH: Final = 1000
MAX_OPTIONS: Final = 20

Key = Annotated[str, StringConstraints(pattern=KEY_PATTERN)]


def require_locales(texts: dict[str, str]) -> dict[str, str]:
    missing = [locale for locale in REQUIRED_LOCALES if not texts.get(locale, "").strip()]
    if missing:
        raise ValueError(f"needs a non-empty value for {', '.join(missing)}")
    return texts


Localized = Annotated[dict[str, str], AfterValidator(require_locales)]


class InvalidAnswerError(ValueError):
    """An answer that does not fit its question. Carries no value: callers log keys only."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _Question(_Strict):
    key: Key = Field(description="The answer's key in intake_answers; unique in the category.")
    required: StrictBool
    labels: Localized = Field(description="The question per locale; en and es required.")
    help: Localized | None = Field(default=None, description="An optional hint per locale.")


class IntegerQuestion(_Question):
    type: Literal["integer"]
    min: StrictInt
    max: StrictInt

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.min > self.max:
            raise ValueError("min must not exceed max")
        return self

    def normalize(self, value: JsonValue) -> JsonValue:
        # bool is an int in Python; JSON true is not a number.
        if type(value) is not int or not self.min <= value <= self.max:
            raise InvalidAnswerError
        return value


class ChoiceOption(_Strict):
    value: Key
    labels: Localized


class _ChoiceQuestion(_Question):
    options: list[ChoiceOption] = Field(min_length=2, max_length=MAX_OPTIONS)

    @model_validator(mode="after")
    def _unique_values(self) -> Self:
        values = [option.value for option in self.options]
        if len(set(values)) != len(values):
            raise ValueError("option values must be unique")
        return self

    def _values(self) -> set[str]:
        return {option.value for option in self.options}


class SingleChoiceQuestion(_ChoiceQuestion):
    type: Literal["single_choice"]

    def normalize(self, value: JsonValue) -> JsonValue:
        if not isinstance(value, str) or value not in self._values():
            raise InvalidAnswerError
        return value


class MultiChoiceQuestion(_ChoiceQuestion):
    type: Literal["multi_choice"]
    min_selected: StrictInt = Field(default=0, ge=0)
    max_selected: StrictInt | None = Field(
        default=None, ge=0, description="At most this many; all options when absent."
    )

    @model_validator(mode="after")
    def _selection_bounds(self) -> Self:
        most = self.max_selected if self.max_selected is not None else len(self.options)
        if not self.min_selected <= most <= len(self.options):
            raise ValueError("needs 0 <= min_selected <= max_selected <= number of options")
        return self

    def normalize(self, value: JsonValue) -> JsonValue:
        most = self.max_selected if self.max_selected is not None else len(self.options)
        if (
            not isinstance(value, list)
            or not all(isinstance(item, str) and item in self._values() for item in value)
            or len(set(map(str, value))) != len(value)
            or not self.min_selected <= len(value) <= most
        ):
            raise InvalidAnswerError
        return value


class BooleanQuestion(_Question):
    type: Literal["boolean"]

    def normalize(self, value: JsonValue) -> JsonValue:
        if not isinstance(value, bool):
            raise InvalidAnswerError
        return value


class TextQuestion(_Question):
    type: Literal["text"]
    max_length: StrictInt = Field(ge=1, le=TEXT_MAX_LENGTH)

    def normalize(self, value: JsonValue) -> JsonValue:
        if not isinstance(value, str):
            raise InvalidAnswerError
        text = value.strip()
        if not text or len(text) > self.max_length or "\x00" in text:
            raise InvalidAnswerError
        return text


IntakeQuestion = Annotated[
    IntegerQuestion | SingleChoiceQuestion | MultiChoiceQuestion | BooleanQuestion | TextQuestion,
    Field(discriminator="type"),
]


def _unique_keys(questions: list[IntakeQuestion]) -> list[IntakeQuestion]:
    keys = [question.key for question in questions]
    duplicates = sorted({key for key in keys if keys.count(key) > 1})
    if duplicates:
        raise ValueError(f"duplicate question keys: {', '.join(duplicates)}")
    return questions


IntakeQuestions = Annotated[list[IntakeQuestion], AfterValidator(_unique_keys)]
INTAKE_QUESTIONS: Final = TypeAdapter(IntakeQuestions)


class InvalidAnswersError(ValueError):
    """Answers that do not fit the questions. `failed` names the category's own question keys
    that failed; `unknown` only counts the keys it does not ask (they are client text)."""

    def __init__(self, failed: list[str], unknown: int) -> None:
        super().__init__("invalid intake answers")
        self.failed = failed
        self.unknown = unknown


def validate_answers(
    questions: list[IntakeQuestion], answers: dict[str, JsonValue]
) -> dict[str, JsonValue]:
    """The answers, normalized (trimmed text), in question order. Raises InvalidAnswersError."""
    asked = {question.key for question in questions}
    unknown = sum(key not in asked for key in answers)
    failed: list[str] = []
    normalized: dict[str, JsonValue] = {}
    for question in questions:
        if question.key not in answers:
            if question.required:
                failed.append(question.key)
            continue
        try:
            normalized[question.key] = question.normalize(answers[question.key])
        except InvalidAnswerError:
            failed.append(question.key)
    if failed or unknown:
        raise InvalidAnswersError(failed, unknown)
    return normalized


def dump_questions(questions: list[IntakeQuestion]) -> list[dict[str, JsonValue]]:
    """The JSON stored in `categories.intake_questions`, without absent optional fields."""
    dumped: list[dict[str, JsonValue]] = INTAKE_QUESTIONS.dump_python(
        questions, mode="json", exclude_none=True
    )
    return dumped
