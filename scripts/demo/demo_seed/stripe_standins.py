"""Stand-ins for Stripe, for the demo's history and for a machine without TEST keys.

The 30-day history is dozens of paid jobs: charging a real test card for each would take
minutes and a Connect account per pro. These classes implement the ports of app/integrations
(the same seam the API's tests replace), so every row the history holds is still written by the
real services. Ids are derived from the idempotency key, as Stripe answers the same key with
the same object, and every id says `demo` so nobody takes one for a Stripe object.

Nothing here ever calls Stripe, and Stripe knows none of these ids. So the running stack
cannot act on a stand-in payment later: the API cannot refund it (the disputed job the video
resolves is paid through the real TEST gateway instead, stripe_test.py), and a stand-in job
left waiting for its confirmation fails its transfer when the worker's 48 h auto-confirm
comes. A demo database is for the day it was seeded: reseed rather than let one age.
"""

import hashlib
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from app.integrations.stripe_connect import AccountState
from app.integrations.stripe_payments import (
    CreatedCustomer,
    FoundPaymentIntents,
    FoundTipIntents,
    PaymentIntentFacts,
    PaymentIntentState,
    TipIntentFacts,
)
from app.integrations.stripe_refunds import FoundRefunds, RefundFacts
from app.integrations.stripe_transfers import FoundTransfers, TransferFacts

MARK: Final = "demo"
# Stripe's statuses, as the ports pass them through.
_REQUIRES_PAYMENT: Final = "requires_payment_method"
_SUCCEEDED: Final = "succeeded"
_CANCELED: Final = "canceled"


def stand_in_id(prefix: str, key: str) -> str:
    """`<prefix>_demo<20 hex>`: the same key always names the same object."""
    return f"{prefix}_{MARK}{hashlib.sha256(key.encode()).hexdigest()[:20]}"


def is_stand_in(stripe_id: str) -> bool:
    """Whether a Stripe id was made here (never by Stripe)."""
    return f"_{MARK}" in stripe_id


@dataclass
class _Intent:
    facts: PaymentIntentFacts
    status: str
    # The create's metadata: what a tip intent's reads report (#510's tip_intent, search).
    metadata: Mapping[str, str]


class StandInPayments:
    """app.integrations.stripe_payments.StripePayments, in memory."""

    def __init__(self) -> None:
        self._intents: dict[str, _Intent] = {}

    async def create_customer(self, *, user_id: str, idempotency_key: str) -> CreatedCustomer:
        return CreatedCustomer(customer_id=stand_in_id("cus", idempotency_key), request_id=None)

    async def create_payment_intent(
        self,
        *,
        amount_cents: int,
        currency: str,
        customer_id: str,
        transfer_group: str,
        metadata: Mapping[str, str],
        idempotency_key: str,
        description: str | None = None,
    ) -> PaymentIntentState:
        intent_id = stand_in_id("pi", idempotency_key)
        self._intents.setdefault(
            intent_id,
            _Intent(
                facts=PaymentIntentFacts(
                    payment_intent_id=intent_id,
                    amount_cents=amount_cents,
                    currency=currency,
                    customer_id=customer_id,
                    payment_id=metadata.get("payment_id"),
                ),
                status=_REQUIRES_PAYMENT,
                metadata=dict(metadata),
            ),
        )
        return self._state(intent_id)

    async def retrieve_payment_intent(self, payment_intent_id: str) -> PaymentIntentState:
        return self._state(payment_intent_id)

    async def search_payment_intents(self, payment_id: uuid.UUID) -> FoundPaymentIntents:
        found = tuple(
            intent.facts
            for intent in self._intents.values()
            if intent.facts.payment_id == str(payment_id)
        )
        return FoundPaymentIntents(intents=found, complete=True)

    async def payment_intent_facts(self, payment_intent_id: str) -> PaymentIntentFacts:
        return self._intents[payment_intent_id].facts

    async def tip_intent(self, payment_intent_id: str) -> TipIntentFacts:
        return self._tip_facts(payment_intent_id)

    async def search_tip_intents(self, tip_id: uuid.UUID) -> FoundTipIntents:
        found = tuple(
            self._tip_facts(intent_id)
            for intent_id, intent in self._intents.items()
            if intent.metadata.get("tip_id") == str(tip_id)
        )
        return FoundTipIntents(intents=found, complete=True)

    async def create_customer_session(self, customer_id: str) -> str:
        return stand_in_id("cuss_secret", customer_id)

    async def create_ephemeral_key(self, customer_id: str) -> str:
        return stand_in_id("ek", customer_id)

    async def cancel_payment_intent(self, payment_intent_id: str, *, idempotency_key: str) -> bool:
        intent = self._intents[payment_intent_id]
        if intent.status != _REQUIRES_PAYMENT:
            return False
        intent.status = _CANCELED
        return True

    async def charge(self, payment_intent_id: str) -> PaymentIntentFacts:
        """The customer's card was charged: what the Payment Sheet does in the app
        (flows.Checkout)."""
        intent = self._intents[payment_intent_id]
        intent.status = _SUCCEEDED
        return intent.facts

    def _tip_facts(self, intent_id: str) -> TipIntentFacts:
        intent = self._intents[intent_id]
        return TipIntentFacts(
            payment_intent_id=intent_id,
            amount_cents=intent.facts.amount_cents,
            currency=intent.facts.currency,
            customer_id=intent.facts.customer_id,
            status=intent.status,
            failed=False,
            kind=intent.metadata.get("kind"),
            tip_id=intent.metadata.get("tip_id"),
            job_id=intent.metadata.get("job_id"),
            attempt=intent.metadata.get("attempt"),
        )

    def _state(self, intent_id: str) -> PaymentIntentState:
        return PaymentIntentState(
            payment_intent_id=intent_id,
            client_secret=f"{intent_id}_secret_{MARK}",
            status=self._intents[intent_id].status,
            request_id=None,
        )


class StandInTransfers:
    """app.integrations.stripe_transfers.StripeTransfers, in memory."""

    def __init__(self) -> None:
        self._transfers: dict[str, tuple[str, TransferFacts]] = {}

    async def charge_of_payment_intent(self, payment_intent_id: str) -> str | None:
        return stand_in_id("ch", payment_intent_id)

    async def create_transfer(
        self,
        *,
        amount_cents: int,
        currency: str,
        destination: str,
        transfer_group: str,
        source_transaction: str | None,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> TransferFacts:
        transfer_id = stand_in_id("tr", idempotency_key)
        facts = TransferFacts(
            transfer_id=transfer_id,
            amount_cents=amount_cents,
            currency=currency,
            destination=destination,
            job_id=metadata.get("job_id"),
            reversed=False,
            request_id=None,
        )
        self._transfers.setdefault(transfer_id, (transfer_group, facts))
        return self._transfers[transfer_id][1]

    async def list_transfers(self, transfer_group: str) -> FoundTransfers:
        found = tuple(facts for group, facts in self._transfers.values() if group == transfer_group)
        return FoundTransfers(transfers=found, complete=True)

    async def retrieve_transfer(self, transfer_id: str) -> TransferFacts:
        return self._transfers[transfer_id][1]


class StandInRefunds:
    """app.integrations.stripe_refunds.StripeRefunds, in memory: every refund succeeds."""

    def __init__(self) -> None:
        self._refunds: dict[str, tuple[str, RefundFacts]] = {}

    async def create_refund(
        self,
        *,
        payment_intent_id: str,
        amount_cents: int,
        metadata: Mapping[str, str],
        idempotency_key: str,
    ) -> RefundFacts:
        refund_id = stand_in_id("re", idempotency_key)
        facts = RefundFacts(
            refund_id=refund_id,
            amount_cents=amount_cents,
            currency="usd",
            dispute_id=metadata.get("dispute_id"),
            status=_SUCCEEDED,
            request_id=None,
            refund_key=metadata.get("refund_key"),
        )
        self._refunds.setdefault(refund_id, (payment_intent_id, facts))
        return self._refunds[refund_id][1]

    async def list_refunds(self, payment_intent_id: str) -> FoundRefunds:
        found = tuple(
            facts for intent, facts in self._refunds.values() if intent == payment_intent_id
        )
        return FoundRefunds(refunds=found, complete=True)

    async def retrieve_refund(self, refund_id: str) -> RefundFacts:
        return self._refunds[refund_id][1]


class StandInAccounts:
    """app.integrations.stripe_connect.AccountReader: an Express account whose onboarding is
    done, as the payouts tests answer it. The seeded pros' payouts are enabled through the same
    `store_payouts_enabled` the status call and the account.updated event use."""

    async def retrieve_account(self, account_id: str) -> AccountState:
        return AccountState(details_submitted=True, payouts_enabled=True, requirements_due=False)
