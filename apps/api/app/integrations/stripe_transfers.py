"""Stripe transfers to the pros' connected accounts (D13.3, #68; ADR 0005).

The platform charges the customer (stripe_payments.py) and, once the job is confirmed, moves the
pro's share to their Express account with a Transfer: separate charges and transfers. The create
names the charge it pays from (`source_transaction`), so Stripe takes the money from that
charge's own funds even while they are still pending on the platform balance, and ties the
transfer to the charge's `transfer_group`. Every create carries the caller's idempotency key.

A transfer whose create answer was lost is found again by listing the request's
`transfer_group` (one page of TRANSFER_LIST_LIMIT; the List API reads Stripe's own records, so
it is not eventually consistent like Search) and reading each transfer's metadata job_id.
Once a transfer is stored, it is read again by id: whether it was reversed before then.

What leaves this module is typed and minimal: a charge's id, and a transfer's id, amount,
currency, destination, metadata job_id (a job's transfer) or kind and tip_id (a tip's, #273
PR A2) and whether it was reversed. Stripe's errors become
`StripeUnavailableError` (network, timeout, 409, 429, 5xx) or `StripeRejectedError` (any other
4xx), each carrying only Stripe's request id and error code (stripe_errors.py): an SDK error's
text can name the account or the transfer, so it is never chained or logged. Calls go through
the official SDK's async client on httpx (timeout and retries from settings).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

import stripe
from stripe.params import TransferCreateParams, TransferListParams

from app.config import Settings
from app.integrations.stripe_errors import raise_typed

# One page of a request's transfer group: a request has one job, so one transfer. More than a
# page is already an answer (the caller cannot tell, and creates nothing).
TRANSFER_LIST_LIMIT = 100


@dataclass(frozen=True)
class TransferFacts:
    """A transfer as the release compares it with its row. `destination` and the metadata
    (`job_id` for a job's transfer; `kind` "tip" and `tip_id` for a tip's, #273 PR A2) are None
    when the transfer has none; `reversed`: any part of it was reversed."""

    transfer_id: str
    amount_cents: int
    currency: str
    destination: str | None
    job_id: str | None
    reversed: bool
    request_id: str | None
    kind: str | None = None
    tip_id: str | None = None


@dataclass(frozen=True)
class FoundTransfers:
    """The transfers of a transfer group. `complete`: the listing returned every one (no
    further page)."""

    transfers: tuple[TransferFacts, ...]
    complete: bool


class StripeTransfers(Protocol):
    async def charge_of_payment_intent(self, payment_intent_id: str) -> str | None:
        """The id of the PaymentIntent's latest charge: what a transfer pays from. None when
        the intent has no charge."""
        ...

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
        """Creates the transfer to the connected account (see the module doc)."""
        ...

    async def list_transfers(self, transfer_group: str) -> FoundTransfers:
        """The platform's transfers of the group, one page."""
        ...

    async def retrieve_transfer(self, transfer_id: str) -> TransferFacts:
        """The transfer as Stripe holds it now: reversed or not since it was made."""
        ...


class StripeTransfersClient:
    def __init__(
        self,
        *,
        secret_key: str,
        timeout_seconds: float,
        max_network_retries: int,
        http_client: stripe.HTTPClient | None = None,
    ) -> None:
        self._client = stripe.StripeClient(
            secret_key,
            # The async-only httpx client: a synchronous call raises instead of blocking.
            http_client=http_client or stripe.HTTPXClient(timeout=timeout_seconds),
            max_network_retries=max_network_retries,
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> "StripeTransfersClient":
        if settings.stripe_secret_key is None:
            raise RuntimeError("STRIPE_SECRET_KEY is not set; transfers are unavailable")
        return cls(
            secret_key=settings.stripe_secret_key.get_secret_value(),
            timeout_seconds=settings.stripe_timeout_seconds,
            max_network_retries=settings.stripe_max_network_retries,
        )

    async def charge_of_payment_intent(self, payment_intent_id: str) -> str | None:
        try:
            intent = await self._client.v1.payment_intents.retrieve_async(payment_intent_id)
        except stripe.StripeError as error:
            raise_typed(error)
        charge = intent.latest_charge
        return charge if isinstance(charge, str) or charge is None else charge.id

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
        params: TransferCreateParams = {
            "amount": amount_cents,
            "currency": currency,
            "destination": destination,
            "transfer_group": transfer_group,
            "metadata": dict(metadata),
        }
        if source_transaction is not None:
            params["source_transaction"] = source_transaction
        try:
            transfer = await self._client.v1.transfers.create_async(
                params=params, options={"idempotency_key": idempotency_key}
            )
        except stripe.StripeError as error:
            raise_typed(error)
        return _facts(transfer)

    async def list_transfers(self, transfer_group: str) -> FoundTransfers:
        params: TransferListParams = {
            "transfer_group": transfer_group,
            "limit": TRANSFER_LIST_LIMIT,
        }
        try:
            page = await self._client.v1.transfers.list_async(params=params)
        except stripe.StripeError as error:
            raise_typed(error)
        return FoundTransfers(
            transfers=tuple(_facts(transfer) for transfer in page.data),
            complete=not page.has_more,
        )

    async def retrieve_transfer(self, transfer_id: str) -> TransferFacts:
        try:
            transfer = await self._client.v1.transfers.retrieve_async(transfer_id)
        except stripe.StripeError as error:
            raise_typed(error)
        return _facts(transfer)


def _facts(transfer: stripe.Transfer) -> TransferFacts:
    destination = transfer.destination
    metadata = transfer.metadata
    response = transfer.last_response

    def named(key: str) -> str | None:
        value = metadata[key] if metadata is not None and key in metadata else None
        return value if isinstance(value, str) else None

    return TransferFacts(
        transfer_id=transfer.id,
        amount_cents=transfer.amount,
        currency=transfer.currency,
        destination=(
            destination if isinstance(destination, str) or destination is None else destination.id
        ),
        job_id=named("job_id"),
        # A partial reversal leaves `reversed` false with an amount reversed.
        reversed=bool(transfer.reversed) or transfer.amount_reversed > 0,
        request_id=response.request_id if response else None,
        kind=named("kind"),
        tip_id=named("tip_id"),
    )
