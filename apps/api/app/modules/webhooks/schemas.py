from typing import Literal

from pydantic import BaseModel


class WebhookReceived(BaseModel):
    """Stripe reads only the status code; the body says the event is safely stored."""

    received: Literal[True] = True
