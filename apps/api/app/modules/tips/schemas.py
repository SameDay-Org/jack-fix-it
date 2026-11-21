from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.modules.payments.schemas import PaymentSheetOut
from app.modules.tips.views import TipOut


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoTipIn(_In):
    choice: Literal["none"]


class PercentTipIn(_In):
    choice: Literal["percent"]
    percent: StrictInt = Field(
        examples=[10], description="One of the percents the job's tip options offer."
    )


class CustomTipIn(_In):
    choice: Literal["custom"]
    amount_cents: StrictInt = Field(
        examples=[1250], description="The tip in integer cents, within the options' bounds."
    )


# What the customer chose: the server checks it against the job's options and computes the
# amount of a percent from the job's price. An amount sent with a percent is refused (422).
TipCreate = Annotated[NoTipIn | PercentTipIn | CustomTipIn, Field(discriminator="choice")]


class TipCreateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tip: TipOut
    sheet: PaymentSheetOut | None = Field(
        description="What the Payment Sheet needs to pay the tip (its amount, no tax); null for "
        "No tip."
    )
