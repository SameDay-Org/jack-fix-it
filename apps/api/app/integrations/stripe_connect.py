"""Stripe Connect Express accounts for pro payouts (D7.1, #39; ADR 0005).

The platform keeps the money and transfers to each pro's Express account after the job, so an
account asks for the `transfers` capability only. Calls go through the official SDK's async
client on httpx (timeout and retries from settings): no synchronous call blocks the event loop.

What leaves this module is typed and minimal: an account's state as three booleans, a link's URL
and expiry. Stripe's errors become `StripeUnavailableError` (network, timeout, 409, 429, 5xx) or
`StripeRejectedError` (any other 4xx), each carrying only Stripe's request id and error code:
an SDK error's text can name the account id, so it is never chained or logged. The `stripe`
logger, which names every request URL (account ids included) at INFO and request bodies (the
email) at DEBUG, runs at WARNING (app/observability.py).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import NoReturn, Protocol

import stripe
from starlette.requests import Request

from app.config import Settings

EXPRESS_COUNTRY = "US"


class StripeCallError(Exception):
    """A Stripe call failed. Carries Stripe's request id and error code, never its message."""

    def __init__(self, *, request_id: str | None = None, code: str | None = None) -> None:
        super().__init__(type(self).__name__)
        self.request_id = request_id
        self.code = code


class StripeUnavailableError(StripeCallError):
    """Stripe could not be reached, timed out, rate-limited the call or answered a 5xx."""


class StripeRejectedError(StripeCallError):
    """Stripe answered a 4xx: a bad request, a deleted account, a key it refuses."""


@dataclass(frozen=True)
class CreatedAccount:
    account_id: str
    request_id: str | None


@dataclass(frozen=True)
class OnboardingLink:
    url: str
    expires_at: datetime


@dataclass(frozen=True)
class AccountState:
    details_submitted: bool
    payouts_enabled: bool
    # requirements.currently_due is non-empty; what is due stays with Stripe.
    requirements_due: bool


class StripeConnect(Protocol):
    async def create_express_account(
        self, *, email: str, profile_id: str, idempotency_key: str
    ) -> CreatedAccount:
        """Creates a US Express account asking for transfers, the email prefilled."""
        ...

    async def create_onboarding_link(
        self, account_id: str, *, return_url: str, refresh_url: str
    ) -> OnboardingLink:
        """A single-use Stripe-hosted onboarding link for the account."""
        ...

    async def retrieve_account(self, account_id: str) -> AccountState: ...


class StripeExpressConnect:
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
    def from_settings(cls, settings: Settings) -> "StripeExpressConnect":
        if settings.stripe_secret_key is None:
            raise RuntimeError("STRIPE_SECRET_KEY is not set; payouts are unavailable")
        return cls(
            secret_key=settings.stripe_secret_key.get_secret_value(),
            timeout_seconds=settings.stripe_timeout_seconds,
            max_network_retries=settings.stripe_max_network_retries,
        )

    async def create_express_account(
        self, *, email: str, profile_id: str, idempotency_key: str
    ) -> CreatedAccount:
        try:
            account = await self._client.v1.accounts.create_async(
                params={
                    "type": "express",
                    "country": EXPRESS_COUNTRY,
                    "email": email,
                    "capabilities": {"transfers": {"requested": True}},
                    "metadata": {"pro_profile_id": profile_id},
                },
                options={"idempotency_key": idempotency_key},
            )
        except stripe.StripeError as error:
            _raise_typed(error)
        response = account.last_response
        return CreatedAccount(
            account_id=account.id, request_id=response.request_id if response else None
        )

    async def create_onboarding_link(
        self, account_id: str, *, return_url: str, refresh_url: str
    ) -> OnboardingLink:
        try:
            link = await self._client.v1.account_links.create_async(
                params={
                    "account": account_id,
                    "type": "account_onboarding",
                    "return_url": return_url,
                    "refresh_url": refresh_url,
                }
            )
        except stripe.StripeError as error:
            _raise_typed(error)
        return OnboardingLink(url=link.url, expires_at=datetime.fromtimestamp(link.expires_at, UTC))

    async def retrieve_account(self, account_id: str) -> AccountState:
        try:
            account = await self._client.v1.accounts.retrieve_async(account_id)
        except stripe.StripeError as error:
            _raise_typed(error)
        requirements = account.requirements
        return AccountState(
            details_submitted=bool(account.details_submitted),
            payouts_enabled=bool(account.payouts_enabled),
            requirements_due=bool(requirements and requirements.currently_due),
        )


def _raise_typed(error: stripe.StripeError) -> NoReturn:
    """Stripe's error as ours, with its request id and code only; never chained, as its text
    and body can name the account."""
    status = error.http_status
    # No status: the network or a timeout. 409 (a concurrent request, a lock timeout) and 429
    # are Stripe's own "retry later".
    kind = (
        StripeUnavailableError
        if status is None or status in (409, 429) or status >= 500
        else StripeRejectedError
    )
    # The SDK sets `code` on some error classes only; the parsed error body has it on all.
    code = error.code or (error.error.code if error.error else None)
    raise kind(request_id=error.request_id, code=code) from None


def get_stripe_connect(request: Request) -> StripeConnect | None:
    """FastAPI dependency: one client per app, built on first use (tests override this).

    None without STRIPE_SECRET_KEY (allowed outside staging and production): the payout
    endpoints then answer 503.
    """
    connect: StripeConnect | None = getattr(request.app.state, "stripe_connect", None)
    if connect is None:
        settings: Settings = request.app.state.settings
        if settings.stripe_secret_key is None:
            return None
        connect = StripeExpressConnect.from_settings(settings)
        request.app.state.stripe_connect = connect
    return connect
