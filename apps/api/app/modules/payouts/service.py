"""Payouts (D7.1, #39): a pro connects the account Stripe pays them out to (ADR 0005).

One Stripe Connect Express account per pro, created with the first onboarding link and stored
on the profile; later links reuse it. The profile row stays locked (FOR UPDATE) from the check
to the stored id, and the create call carries a key derived from the profile id, committed
before the call with the time of the attempt, so neither two concurrent first calls nor a retry
after a lost response make a second account: within STRIPE_ACCOUNT_RECONCILE_AFTER_SECONDS of
the attempt, Stripe answers the same key with the same account; later, when Stripe may have
forgotten the key, the retry looks the account up by its metadata first and adopts it. Two
matches, or a lookup that could not finish, create nothing: 409 for support to resolve in the
Stripe dashboard. The status reads the account from Stripe, the row locked over the read, and
keeps pro_profiles.payouts_enabled current: dispatch and quote acceptance read that column
(context doc section 5).

Logs carry the profile id and Stripe's request id and error code: never the email, an account
id, a link or a Stripe response.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_connect import (
    AccountState,
    StripeConnect,
    StripeRejectedError,
    StripeUnavailableError,
)
from app.modules.payouts.errors import (
    PaymentsProviderError,
    PaymentsUnavailableError,
    PayoutsNeedsReviewError,
)
from app.modules.payouts.schemas import OnboardingLinkOut, PayoutsOut, PayoutsStatus
from app.modules.pros.service import ProService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

# The public pages Stripe sends the pro's browser back to (payouts/router.py serves them).
RETURN_PATH: Final = "/v1/payouts/onboarding/return"
REFRESH_PATH: Final = "/v1/payouts/onboarding/refresh"


def account_idempotency_key(pro_id: uuid.UUID) -> str:
    """The same key for every attempt to create this profile's account (AGENTS.md "Money")."""
    return f"pro-express-account:{pro_id}"


def payouts_status(state: AccountState) -> PayoutsStatus:
    """`enabled` follows payouts_enabled alone, as dispatch does, even while Stripe asks for
    more information by a later deadline."""
    if state.payouts_enabled:
        return PayoutsStatus.ENABLED
    if not state.details_submitted or state.requirements_due:
        return PayoutsStatus.INCOMPLETE
    return PayoutsStatus.IN_REVIEW


@dataclass(frozen=True)
class PayoutsConfig:
    public_api_url: str | None
    # How old a profile's unanswered account create must be before a retry looks it up first.
    account_reconcile_after: timedelta

    @classmethod
    def from_settings(cls, settings: Settings) -> "PayoutsConfig":
        return cls(
            public_api_url=settings.public_api_url,
            account_reconcile_after=timedelta(
                seconds=settings.stripe_account_reconcile_after_seconds
            ),
        )


class PayoutsService:
    def __init__(
        self,
        session: AsyncSession,
        pros: ProService,
        stripe: StripeConnect | None,
        config: PayoutsConfig,
    ) -> None:
        self._session = session
        self._pros = pros
        self._stripe = stripe
        self._config = config

    async def onboarding_link(self, user: UserAccount) -> OnboardingLinkOut:
        """A Stripe-hosted onboarding link for the caller's Express account, which the first
        call creates (with the profile, when missing)."""
        stripe = self._require_stripe()
        base_url = self._config.public_api_url
        if base_url is None:
            logger.warning("payouts_public_api_url_missing")
            raise PaymentsUnavailableError
        pro_id, account_id = await self._account(stripe, user)
        async with self._stripe_call(pro_id, "create_link"):
            link = await stripe.create_onboarding_link(
                account_id, return_url=base_url + RETURN_PATH, refresh_url=base_url + REFRESH_PATH
            )
        logger.info("payouts_onboarding_link_created", extra={"pro_id": str(pro_id)})
        return OnboardingLinkOut(url=link.url, expires_at=link.expires_at)

    async def _account(self, stripe: StripeConnect, user: UserAccount) -> tuple[uuid.UUID, str]:
        """(profile id, Express account id): the stored account, else one adopted from Stripe or
        created, with the profile when missing. Ends the transaction: the row lock is not held
        over the link call."""
        created, account = await self._pros.lock_payout_account(user.id)
        pro_id = account.profile_id
        if account.stripe_account_id is not None:
            await self._session.commit()
            return pro_id, account.stripe_account_id
        attempted = account.stripe_account_requested_at
        if attempted is not None and datetime.now(UTC) - attempted >= (
            self._config.account_reconcile_after
        ):
            adopted = await self._adopt_lost_account(stripe, pro_id)
            if adopted is not None:
                return pro_id, adopted
            attempted = None  # nothing landed: this create is a first attempt again
        if attempted is None:
            # The profile id names the account in Stripe (metadata, idempotency key), and the
            # attempt's time says when Stripe may forget that key: both are committed first (a
            # new profile too), so a rollback after a lost create answer keeps them. Then the
            # row is locked again; a call that stored the account meanwhile is the one kept.
            await self._pros.mark_stripe_account_requested(pro_id)
            await self._session.commit()
            if created:
                logger.info("pro_profile_created", extra={"user_id": str(user.id)})
            _, account = await self._pros.lock_payout_account(user.id)
            if account.stripe_account_id is not None:
                await self._session.commit()
                return pro_id, account.stripe_account_id
        async with self._stripe_call(pro_id, "create_account"):
            new = await stripe.create_express_account(
                email=user.email,
                profile_id=str(pro_id),
                idempotency_key=account_idempotency_key(pro_id),
            )
        await self._pros.set_stripe_account(pro_id, new.account_id)
        await self._session.commit()
        logger.info(
            "payouts_account_created",
            extra={"pro_id": str(pro_id), "stripe_request_id": new.request_id},
        )
        return pro_id, new.account_id

    async def _adopt_lost_account(self, stripe: StripeConnect, pro_id: uuid.UUID) -> str | None:
        """An earlier create's answer was lost long enough ago that Stripe may have forgotten
        its key: the account it made, if any, is found by its metadata, the row still locked.
        One match is stored and committed; None when nothing landed. Several matches, or a
        listing stopped at its page bound, create nothing: support keeps one of the accounts in
        the Stripe dashboard and deletes the others, and the pro's next call adopts it."""
        async with self._stripe_call(pro_id, "find_accounts"):
            found = await stripe.find_accounts_by_profile(str(pro_id))
        if found.complete and len(found.account_ids) == 1:
            [account_id] = found.account_ids
            await self._pros.set_stripe_account(pro_id, account_id)
            await self._session.commit()
            logger.warning("payouts_account_adopted", extra={"pro_id": str(pro_id)})
            return account_id
        if found.complete and not found.account_ids:
            logger.info("payouts_account_lookup_empty", extra={"pro_id": str(pro_id)})
            return None
        await self._session.rollback()
        logger.error(
            "payouts_account_ambiguous",
            extra={
                "pro_id": str(pro_id),
                "count": len(found.account_ids),
                "listing_complete": found.complete,
            },
        )
        raise PayoutsNeedsReviewError

    async def status(self, user: UserAccount) -> PayoutsOut:
        """Where the caller's onboarding stands, read from Stripe; a changed payouts_enabled is
        stored, true to false too.

        The profile row stays locked (FOR UPDATE) from the read to the stored value: overlapping
        status calls for one pro read Stripe one after the other, so the last answer is the one
        stored, and each response is what its call stored."""
        stripe = self._require_stripe()
        account = await self._pros.payout_account(user.id, lock=True)
        if account is None or account.stripe_account_id is None:
            await self._session.commit()
            enabled = account is not None and account.payouts_enabled
            return PayoutsOut(status=PayoutsStatus.NOT_STARTED, payouts_enabled=enabled)
        async with self._stripe_call(account.profile_id, "retrieve_account"):
            state = await stripe.retrieve_account(account.stripe_account_id)
        # Against the stored row, not the value read before the call: the UPDATE writes only a
        # change.
        changed = await self._pros.set_payouts_enabled(account.profile_id, state.payouts_enabled)
        await self._session.commit()
        if changed:
            logger.info(
                "payouts_enabled_changed",
                extra={"pro_id": str(account.profile_id), "payouts_enabled": state.payouts_enabled},
            )
        return PayoutsOut(status=payouts_status(state), payouts_enabled=state.payouts_enabled)

    def _require_stripe(self) -> StripeConnect:
        if self._stripe is None:
            logger.warning("payouts_stripe_not_configured")
            raise PaymentsUnavailableError
        return self._stripe

    @asynccontextmanager
    async def _stripe_call(self, pro_id: uuid.UUID, operation: str) -> AsyncIterator[None]:
        """Stripe's failure as the API's error, the transaction rolled back first: nothing
        stored changes."""
        try:
            yield
        except StripeUnavailableError as error:
            await self._session.rollback()
            logger.error(
                "payouts_stripe_unavailable",
                extra={
                    "pro_id": str(pro_id),
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsUnavailableError from None
        except StripeRejectedError as error:
            await self._session.rollback()
            logger.error(
                "payouts_stripe_rejected",
                extra={
                    "pro_id": str(pro_id),
                    "operation": operation,
                    "stripe_request_id": error.request_id,
                    "stripe_code": error.code,
                },
            )
            raise PaymentsProviderError from None
