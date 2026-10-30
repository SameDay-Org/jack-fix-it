"""Payouts (D7.1, #39): a pro connects the account Stripe pays them out to (ADR 0005).

One Stripe Connect Express account per pro, created with the first onboarding link and stored
on the profile; later links reuse it. The profile row stays locked (FOR UPDATE) from the check
to the stored id, and the create call carries a key derived from the profile id, committed
before the call, so neither two concurrent first calls nor a retry after a lost response make a
second account. The status reads the account from Stripe, the row locked over the read, and
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
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.stripe_connect import (
    AccountState,
    StripeConnect,
    StripeRejectedError,
    StripeUnavailableError,
)
from app.modules.payouts.errors import PaymentsProviderError, PaymentsUnavailableError
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

    @classmethod
    def from_settings(cls, settings: Settings) -> "PayoutsConfig":
        return cls(public_api_url=settings.public_api_url)


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
        created, account = await self._pros.lock_payout_account(user.id)
        if created:
            # The profile id names the account in Stripe (metadata, idempotency key): a new
            # profile is committed first, so a rollback after a lost create answer keeps it and
            # the retry sends the same key. Then the row is locked again.
            await self._session.commit()
            logger.info("pro_profile_created", extra={"user_id": str(user.id)})
            _, account = await self._pros.lock_payout_account(user.id)
        pro_id = account.profile_id
        account_id = account.stripe_account_id
        if account_id is None:
            async with self._stripe_call(pro_id, "create_account"):
                new = await stripe.create_express_account(
                    email=user.email,
                    profile_id=str(pro_id),
                    idempotency_key=account_idempotency_key(pro_id),
                )
            account_id = new.account_id
            await self._pros.set_stripe_account(pro_id, account_id)
            await self._session.commit()
            logger.info(
                "payouts_account_created",
                extra={"pro_id": str(pro_id), "stripe_request_id": new.request_id},
            )
        else:
            # Ends the transaction: the row lock is not held over the link call.
            await self._session.commit()
        async with self._stripe_call(pro_id, "create_link"):
            link = await stripe.create_onboarding_link(
                account_id, return_url=base_url + RETURN_PATH, refresh_url=base_url + REFRESH_PATH
            )
        logger.info("payouts_onboarding_link_created", extra={"pro_id": str(pro_id)})
        return OnboardingLinkOut(url=link.url, expires_at=link.expires_at)

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
