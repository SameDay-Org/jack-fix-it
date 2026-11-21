"""What the tip's choice (service.py) and its events (webhooks.py) both say of a tip's
PaymentIntent (#273, #510 round 1). A leaf: both import it.

- The keys: `tip:<tip id>:<attempt>` for every create of an attempt's intent, and the cancel's,
  versioned by the tip's updated_at.
- Stripe's state of an intent as a tip status (status_of): read from Stripe, never from an
  event's copy.
- Whether an intent Stripe holds is a given tip's, attempt by attempt (mismatches): its kind,
  tip, job, attempt, customer, currency, and the attempt's amount when it is that attempt.
"""

import uuid
from datetime import UTC, datetime, timedelta

from app.integrations.stripe_payments import TIP_INTENT_KIND, TipIntentFacts
from app.modules.tips.models import TipStatus


def tip_payment_intent_idempotency_key(tip_id: uuid.UUID, attempt: int) -> str:
    """The same key for every create of this attempt's PaymentIntent (AGENTS.md "Money")."""
    return f"tip:{tip_id}:{attempt}"


def tip_cancel_idempotency_key(tip_id: uuid.UUID, attempt: int, version: datetime) -> str:
    """The key to cancel the attempt's PaymentIntent, versioned by the tip's updated_at as the
    payment's cancel is (payments/service.py): Stripe keeps a refusal under a key for 24 h, so
    once the tip changes (its charge failed) the next cancel gets a key of its own."""
    micros = (version - datetime(1970, 1, 1, tzinfo=UTC)) // timedelta(microseconds=1)
    return f"tip_cancel:{tip_id}:{attempt}:{micros}"


def status_of(facts: TipIntentFacts) -> TipStatus:
    """The tip's status for what Stripe says of its PaymentIntent now."""
    if facts.status == "succeeded":
        return TipStatus.SUCCEEDED
    if facts.status == "processing":
        return TipStatus.PROCESSING
    if facts.status == "canceled":
        return TipStatus.CANCELED
    # requires_payment_method after a charge that failed; else still to pay.
    return TipStatus.FAILED if facts.failed else TipStatus.REQUIRES_PAYMENT


def named_tip(value: str | None) -> uuid.UUID | None:
    """The tip id a metadata value names, as the tip's create writes it (a lowercase UUID with
    hyphens); None for anything else."""
    if value is None:
        return None
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        return None
    return parsed if str(parsed) == value else None


def named_attempt(value: str | None) -> int | None:
    """The attempt a metadata value names (a positive integer as the create writes it)."""
    if value is None or not value.isascii() or not value.isdigit():
        return None
    number = int(value)
    return number if number > 0 and str(number) == value else None


def mismatches(
    facts: TipIntentFacts,
    *,
    tip_id: uuid.UUID,
    job_id: uuid.UUID,
    attempt: int,
    amount_cents: int | None,
    currency: str,
    stripe_customer_id: str | None,
) -> list[str]:
    """The names of what in Stripe's intent is not this tip's ([] when it is). The amount is
    checked only for the tip's current attempt (an earlier attempt's amount is not kept), and
    only when given: None for an intent of a closed attempt (#510 round 2)."""
    named = named_attempt(facts.attempt)
    checks = [
        ("kind", facts.kind == TIP_INTENT_KIND),
        ("tip", facts.tip_id == str(tip_id)),
        ("job", facts.job_id == str(job_id)),
        # An attempt the tip had (this one or an earlier one): never one it has not reached.
        ("attempt", named is not None and named <= attempt),
        ("customer", stripe_customer_id is not None and facts.customer_id == stripe_customer_id),
        ("currency", facts.currency == currency),
    ]
    if amount_cents is not None and facts.attempt == str(attempt):
        checks.append(("amount", facts.amount_cents == amount_cents))
    return [name for name, same in checks if not same]
