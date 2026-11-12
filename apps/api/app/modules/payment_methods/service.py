"""Payment methods (#253): the customer's saved cards, the wallet in their profile.

The cards live in Stripe, attached to the customer's Stripe Customer; the API stores nothing of
them (no table, no card data), only the Customer's id on the user (#58). Stripe must be
configured: else 503 not_configured.

- Adding a card: the Customer is created on first use, with the key and the parameters of a
  first payment (#58: key `customer:<user id>`, metadata user_id, no email or name), under the
  user's row lock. Stripe answers a key whose first request is still in flight with a 409, so
  a second tap must not reach Stripe: it waits on the lock and reads the id the first stored.
  A first payment's create (#58) takes no such lock: racing it, one of the two calls is a 503
  to ask again, and one Customer exists either way (the same key). Then a new SetupIntent for
  the Customer and a new ephemeral key: what the app's Payment Sheet needs, in setup mode, to
  send the card to Stripe. The publishable key must be set too.
- The list: the customer's cards, the most recently added first, each with `is_default` from
  the Customer's `invoice_settings.default_payment_method`. A user with no Customer has no
  cards, and Stripe is not asked.
- The default and the delete address a card by its Stripe id, and the card must be attached to
  the caller's own Customer: Stripe is asked for the card, and one it does not have, one
  attached to another customer, one detached already and anything that is not a card are the
  same 404, after the same single read (a user with no Customer gets it without a read: that
  tells them nothing about anyone else's cards).
- Deleting the default card first makes the next one, the most recently added of the others,
  the default, then detaches the card; with no other card, none is the default. In that order,
  so a failure between the two leaves a wallet that still has a default, and the delete can be
  asked for again.

Stripe failing in any way (unreachable, a timeout, a 409, 429 or 5xx, or a refusal) is 503
payments_unavailable: one stable body, never Stripe's message. Nothing is retried here, and the
SDK retries only as STRIPE_MAX_NETWORK_RETRIES says. This module's logs carry the user's id, the
operation and Stripe's request id and error code only: never a client secret, an ephemeral key,
a customer id, a PaymentMethod id or anything of a card. (The access log records the path of
every request, which for the default and the delete holds the card's id.)

No transaction stays open across a Stripe call, but the one that creates the Customer: once per
user, for the lock above.
"""

import logging
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, is_publishable_key
from app.integrations.stripe_errors import StripeRejectedError, StripeUnavailableError
from app.integrations.stripe_payment_methods import SavedCard, StripePaymentMethods
from app.integrations.stripe_payments import StripePayments
from app.modules.payment_methods.errors import PaymentMethodNotFoundError
from app.modules.payment_methods.schemas import PaymentMethodOut, SetupIntentOut
from app.modules.payments.errors import PaymentsNotConfiguredError
from app.modules.payments.service import customer_idempotency_key
from app.modules.payouts.errors import PaymentsUnavailableError
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PaymentMethodsConfig:
    # The key the Payment Sheet initializes Stripe with; None: adding a card is not configured.
    publishable_key: str | None

    @classmethod
    def from_settings(cls, settings: Settings) -> "PaymentMethodsConfig":
        return cls(publishable_key=settings.stripe_publishable_key)


def _newest_first(cards: Iterable[SavedCard]) -> list[SavedCard]:
    """The most recently added first; the id settles two cards of the same second."""
    return sorted(cards, key=lambda card: (card.created, card.payment_method_id), reverse=True)


def _out(card: SavedCard, default_id: str | None) -> PaymentMethodOut:
    return PaymentMethodOut(
        id=card.payment_method_id,
        brand=card.brand,
        last4=card.last4,
        exp_month=card.exp_month,
        exp_year=card.exp_year,
        is_default=card.payment_method_id == default_id,
    )


class PaymentMethodService:
    def __init__(
        self,
        session: AsyncSession,
        payments: StripePayments | None,
        methods: StripePaymentMethods | None,
        config: PaymentMethodsConfig,
    ) -> None:
        self._session = session
        self._payments = payments
        self._methods = methods
        self._config = config
        self._users = UserService(session)

    async def setup_intent(self, user: UserAccount) -> SetupIntentOut:
        """What the Payment Sheet needs to save a card on the caller: their Stripe Customer
        (created on first use), a new SetupIntent and a new ephemeral key."""
        payments, methods = self._require_stripe()
        publishable_key = self._require_publishable_key()
        customer_id = await self._customer(payments, user)
        async with self._stripe_call(user, "create_setup_intent"):
            intent = await methods.create_setup_intent(customer_id)
        async with self._stripe_call(user, "create_ephemeral_key"):
            ephemeral_key_secret = await payments.create_ephemeral_key(customer_id)
        logger.info(
            "payment_method_setup_intent_issued",
            extra={"user_id": str(user.id), "stripe_request_id": intent.request_id},
        )
        return SetupIntentOut(
            client_secret=intent.client_secret,
            ephemeral_key_secret=ephemeral_key_secret,
            customer_id=customer_id,
            publishable_key=publishable_key,
        )

    async def list_own(self, user: UserAccount) -> list[PaymentMethodOut]:
        """The caller's saved cards, the most recently added first."""
        _, methods = self._require_stripe()
        customer_id = await self._stored_customer(user)
        if customer_id is None:
            return []
        async with self._stripe_call(user, "list_cards"):
            cards = await methods.list_cards(customer_id)
        async with self._stripe_call(user, "default_payment_method"):
            default_id = await methods.default_payment_method(customer_id)
        return [_out(card, default_id) for card in _newest_first(cards)]

    async def set_default(self, user: UserAccount, payment_method_id: str) -> PaymentMethodOut:
        """Makes one of the caller's saved cards their default."""
        _, methods = self._require_stripe()
        customer_id, card = await self._own_card(methods, user, payment_method_id)
        async with self._stripe_call(user, "set_default_payment_method"):
            await methods.set_default_payment_method(customer_id, card.payment_method_id)
        logger.info("payment_method_default_set", extra={"user_id": str(user.id)})
        return _out(card, card.payment_method_id)

    async def delete(self, user: UserAccount, payment_method_id: str) -> None:
        """Detaches one of the caller's saved cards; the default's place goes to the most
        recently added of the others, set before the detach (see the module doc)."""
        _, methods = self._require_stripe()
        customer_id, card = await self._own_card(methods, user, payment_method_id)
        async with self._stripe_call(user, "default_payment_method"):
            default_id = await methods.default_payment_method(customer_id)
        promoted = False
        if default_id == card.payment_method_id:
            async with self._stripe_call(user, "list_cards"):
                cards = await methods.list_cards(customer_id)
            others = [
                other
                for other in _newest_first(cards)
                if other.payment_method_id != card.payment_method_id
            ]
            if others:
                async with self._stripe_call(user, "set_default_payment_method"):
                    await methods.set_default_payment_method(
                        customer_id, others[0].payment_method_id
                    )
                promoted = True
        async with self._stripe_call(user, "detach"):
            await methods.detach(card.payment_method_id)
        logger.info(
            "payment_method_deleted",
            extra={
                "user_id": str(user.id),
                "was_default": default_id == card.payment_method_id,
                "promoted": promoted,
            },
        )

    def _require_stripe(self) -> tuple[StripePayments, StripePaymentMethods]:
        if self._payments is None or self._methods is None:
            logger.warning("payment_methods_stripe_not_configured")
            raise PaymentsNotConfiguredError
        return self._payments, self._methods

    def _require_publishable_key(self) -> str:
        key = self._config.publishable_key
        if key is None:
            logger.warning("payment_methods_stripe_not_configured")
            raise PaymentsNotConfiguredError
        if not is_publishable_key(key):
            # Settings refuse such a key at load; this keeps one built another way out of the
            # response. Never logs the value: it may be a secret.
            logger.error("payment_methods_publishable_key_invalid")
            raise PaymentsNotConfiguredError
        return key

    async def _stored_customer(self, user: UserAccount) -> str | None:
        """The caller's stored Stripe Customer id; None when they have none. Ends the
        transaction: no Stripe call runs inside one."""
        stored = await self._users.stripe_customer_id(user.id)
        await self._session.commit()
        return stored

    async def _customer(self, payments: StripePayments, user: UserAccount) -> str:
        """The caller's Stripe Customer id: the stored one, else created with the user's key
        and stored, under the user's row lock (see the module doc). Ends the transaction."""
        stored = await self._stored_customer(user)
        if stored is not None:
            return stored
        # First use. Read again under the lock: a call that held it has stored the id by now.
        stored = await self._users.lock_stripe_customer_id(user.id)
        if stored is not None:
            await self._session.commit()
            return stored
        # A failure rolls back, which releases the lock.
        async with self._stripe_call(user, "create_customer"):
            created = await payments.create_customer(
                user_id=str(user.id), idempotency_key=customer_idempotency_key(user.id)
            )
        if await self._users.set_stripe_customer_id_if_missing(user.id, created.customer_id):
            await self._session.commit()
            logger.info(
                "stripe_customer_created",
                extra={"user_id": str(user.id), "stripe_request_id": created.request_id},
            )
            return created.customer_id
        # Not reached under the lock: nothing else stores an id while it is held. Kept so
        # that a caller gets the stored id, never one that was not stored.
        await self._session.rollback()  # pragma: no cover
        stored = await self._stored_customer(user)  # pragma: no cover
        return stored or created.customer_id  # pragma: no cover

    async def _own_card(
        self, methods: StripePaymentMethods, user: UserAccount, payment_method_id: str
    ) -> tuple[str, SavedCard]:
        """The caller's Stripe Customer id and the card with this id attached to it; else the
        one 404 of the module doc."""
        customer_id = await self._stored_customer(user)
        if customer_id is None:
            raise PaymentMethodNotFoundError
        async with self._stripe_call(user, "retrieve_card"):
            card = await methods.retrieve_card(payment_method_id)
        # The ownership check: the id alone proves nothing, the card must be the caller's.
        if card is None or card.customer_id != customer_id:
            raise PaymentMethodNotFoundError
        return customer_id, card

    @asynccontextmanager
    async def _stripe_call(self, user: UserAccount, operation: str) -> AsyncIterator[None]:
        """Stripe's failure as the API's one 503, the transaction rolled back first. The log
        tells an outage from a refusal; the response does not."""
        try:
            yield
        except (StripeUnavailableError, StripeRejectedError) as error:
            await self._session.rollback()
            logger.error(
                "payment_method_stripe_rejected"
                if isinstance(error, StripeRejectedError)
                else "payment_method_stripe_unavailable",
                extra={
                    "user_id": str(user.id),
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsUnavailableError from None
