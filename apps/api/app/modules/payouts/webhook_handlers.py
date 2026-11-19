"""The account.updated handler (#280), registered in app.modules.webhooks.handlers.

Stripe sends account.updated on the Connect endpoint (POST /v1/webhooks/stripe/connect, its own
signing secret) when a pro's Express account changes. The handler finds the profile holding the
account (`event.account`, the connected account the event is about; `data.object.id` names the
same account), locks its row and reads the account from Stripe again: the event's own flags and
the order events arrive in are never trusted, so a late or repeated event ends at the state
Stripe has now. payouts_enabled is stored through the same code as the payouts status
(service.store_payouts_enabled), only a change written.

- An account no profile holds (the platform's own, or a pro deleted since) is logged with the
  event's id and type and acknowledged: Stripe would otherwise retry it for ever.
- Stripe failing, or no Stripe key: raised, so the worker rolls the handler back and runs the
  event again after its backoff, until the event is failed for staff. Nothing is written.
- A change is logged (`payouts_enabled_changed`, ids only) after the worker's commit. When
  payouts turn on for an approved pro, the pro hears it then too: from now on they receive
  requests. Not approved yet, they hear nothing (approval comes with its own message, #41).

The handler never commits: the worker does (#40). An event whose object is not an account with
an id, or whose `account` names another account than its object, is malformed: logged (the
event id and type) and raised, so it ends failed for staff.
"""

import logging
from collections.abc import Callable, Mapping
from functools import partial
from types import MappingProxyType
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.stripe_connect import AccountReader, worker_stripe_connect
from app.modules.dispatch.kicks import RedispatchKick
from app.modules.notifications.events import push_payouts_enabled
from app.modules.payouts.service import store_payouts_enabled
from app.modules.pros.service import ConnectedPro, ProService
from app.modules.webhooks.events import AfterCommit, StripeEvent, StripeEventHandler
from app.queue import JobQueue

logger = logging.getLogger(__name__)

ACCOUNT_UPDATED: Final = "account.updated"

StripeConnectProvider = Callable[[], AccountReader | None]


class AccountEventMalformedError(Exception):
    """The event's object is not a Stripe account with an id."""


class PayoutsNotConfiguredError(Exception):
    """No Stripe key: the account cannot be read, so the event is run again later."""


def account_id_of(event: StripeEvent) -> str:
    """The connected account the event is about."""
    data = event.payload.get("data")
    account = data.get("object") if isinstance(data, Mapping) else None
    object_id = account.get("id") if isinstance(account, Mapping) else None
    connected = event.payload.get("account")
    if (
        not isinstance(account, Mapping)
        or account.get("object") != "account"
        or not isinstance(object_id, str)
        or (connected is not None and connected != object_id)
    ):
        logger.error(
            "account_event_malformed",
            extra={"stripe_event_id": event.stripe_event_id, "event_type": event.event_type},
        )
        raise AccountEventMalformedError
    return object_id


async def announce(
    pro: ConnectedPro,
    enabled: bool,
    stripe_event_id: str,
    queue: JobQueue,
    timeout_seconds: float,
) -> None:
    """After the worker's commit: the change logged, and the approved pro told payouts are on
    and queued a re-dispatch of the requests no pro could take (#478)."""
    logger.info(
        "payouts_enabled_changed",
        extra={"pro_id": str(pro.account.profile_id), "payouts_enabled": enabled},
    )
    if enabled and pro.approved:
        await push_payouts_enabled(
            queue,
            pro_user_id=pro.user_id,
            stripe_event_id=stripe_event_id,
            timeout_seconds=timeout_seconds,
        )
        await RedispatchKick(queue, timeout_seconds).after_commit(
            pro.account.profile_id, "payouts_enabled"
        )


def account_updated_handler(connect: StripeConnectProvider) -> StripeEventHandler:
    """The handler, reading accounts with the client `connect` gives (the worker's own in
    production, a fake in tests)."""

    async def account_updated(
        session: AsyncSession, event: StripeEvent, after_commit: AfterCommit
    ) -> None:
        stripe_account_id = account_id_of(event)
        log = {"stripe_event_id": event.stripe_event_id, "event_type": event.event_type}
        pros = ProService(session)
        pro = await pros.lock_connected_pro(stripe_account_id)
        if pro is None:
            logger.warning("account_event_unknown_account", extra=log)
            return
        stripe = connect()
        if stripe is None:
            logger.warning("payouts_stripe_not_configured", extra=log)
            raise PayoutsNotConfiguredError
        state, changed = await store_payouts_enabled(pros, stripe, pro.account, stripe_account_id)
        if changed:
            after_commit.add(partial(announce, pro, state.payouts_enabled, event.stripe_event_id))

    return account_updated


ACCOUNT_HANDLERS: Final[Mapping[str, StripeEventHandler]] = MappingProxyType(
    {ACCOUNT_UPDATED: account_updated_handler(worker_stripe_connect)}
)
