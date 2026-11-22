"""The tip as the customer's job shows it (#273). A leaf: jobs.schemas embeds TipOut in
CustomerJob without importing the tips service, which reads the jobs module."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.tips.models import TipChoice, TipStatus


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TipPreset(_Out):
    percent: int = Field(examples=[10], description="A whole percent of the job's price.")
    amount_cents: int = Field(
        description="What that percent comes to, computed by the server (rounded half up): the "
        "app shows it as is."
    )


class TipOptions(_Out):
    presets: list[TipPreset] = Field(
        description="The percents offered for this job, ascending; a percent whose amount falls "
        "outside the bounds below is left out."
    )
    min_cents: int = Field(description="The smallest tip, inclusive.")
    max_cents: int = Field(
        description="The largest tip, inclusive: a share of the job's price, capped."
    )


class TipOut(_Out):
    """The job's tip: what the customer chose, where its payment stands and what they may do."""

    status: TipStatus | None = Field(
        description="null until the customer chooses. declined: No tip. requires_payment: the "
        "Payment Sheet is open or was closed. processing, succeeded, failed, canceled: the "
        "payment's. A failed or canceled tip can be tried again while can_tip is true."
    )
    choice: TipChoice | None = Field(description="null until the customer chooses.")
    percent: int | None = Field(description="The offered percent chosen; null otherwise.")
    amount_cents: int = Field(
        description="The tip, in integer cents; 0 until chosen and for No tip."
    )
    currency: str = Field(examples=["usd"], description="Stripe's lower-case currency code.")
    options: TipOptions
    can_tip: bool = Field(
        description="Whether a tip may be chosen or paid now: inside the window, nothing paid or "
        "being paid yet."
    )
    closes_at: datetime = Field(
        description="When the window closes: the job's confirmation plus TIP_WINDOW_HOURS."
    )
