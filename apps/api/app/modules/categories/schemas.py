import uuid
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, RootModel, field_validator, model_validator

from app.modules.categories.intake import REQUIRED_LOCALES, IntakeQuestion, IntakeQuestions


class CategorySeed(BaseModel):
    """One catalog entry of seed_data.json."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    slug: str = Field(pattern=r"^[a-z0-9-]+$", max_length=64)
    names: dict[str, str]
    icon: str | None = Field(default=None, max_length=64)
    requires_license: bool
    reference_price_cents: int | None = Field(default=None, ge=0)
    intake_questions: IntakeQuestions = Field(default_factory=list)
    active: bool

    @field_validator("names")
    @classmethod
    def _require_names(cls, names: dict[str, str]) -> dict[str, str]:
        missing = [locale for locale in REQUIRED_LOCALES if not names.get(locale, "").strip()]
        if missing:
            raise ValueError(f"names needs a non-empty value for {', '.join(missing)}")
        return names


class CategorySeedCatalog(RootModel[list[CategorySeed]]):
    """The whole seed file: entries in display order, each slug once."""

    @model_validator(mode="after")
    def _unique_slugs(self) -> Self:
        slugs = [entry.slug for entry in self.root]
        duplicates = sorted({slug for slug in slugs if slugs.count(slug) > 1})
        if duplicates:
            raise ValueError(f"duplicate slugs: {', '.join(duplicates)}")
        return self


class CategorySummary(BaseModel):
    id: uuid.UUID
    slug: str
    names: dict[str, str] = Field(description="Display name per locale, e.g. en and es.")


class CategoryOut(CategorySummary):
    icon: str | None
    requires_license: bool
    intake_questions: list[IntakeQuestion] = Field(
        description=(
            "What to ask the customer for this category, in order; answers go in the "
            "request's intake_answers under each key. Empty when there is nothing to ask."
        )
    )
