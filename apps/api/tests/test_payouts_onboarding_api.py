"""Pro payouts over HTTP (D7.1, #39): the onboarding link, the status and the return pages.
Never calls Stripe: a fake replaces the wrapper."""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import URL, delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import Settings
from app.integrations.stripe_connect import (
    AccountState,
    CreatedAccount,
    OnboardingLink,
    ProfileAccounts,
    StripeConnect,
    StripeRejectedError,
    StripeUnavailableError,
    get_stripe_connect,
)
from app.modules.auth.permissions import PUBLIC_ROUTES
from app.modules.payouts.errors import PaymentsUnavailableError, PayoutsNeedsReviewError
from app.modules.payouts.service import PayoutsConfig, PayoutsService
from app.modules.pros.models import ProProfile
from app.modules.pros.repository import ProProfileRepository
from app.modules.pros.service import ProService
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from app.rate_limit import get_rate_limiter
from tests.conftest import LOCK_WAIT_DEADLINE_SECONDS, InMemoryRateLimiter, make_settings
from tests.test_pros_profile_api import FORBIDDEN, Caller, make_caller

# Fixture values only, distinct from the defaults, so the tests prove they come from settings.
PUBLIC_API_URL = "https://api.example.invalid"
APP_URL = "jackfixit-test://payouts-test"
LIMIT = 3
WINDOW = 600
NOW = 1_000.0
LINK_TTL = timedelta(minutes=5)
RECONCILE_AFTER = timedelta(hours=5)
CONFIG = PayoutsConfig(public_api_url=PUBLIC_API_URL, account_reconcile_after=RECONCILE_AFTER)
RETURN_URL = f"{PUBLIC_API_URL}/v1/payouts/onboarding/return"
REFRESH_URL = f"{PUBLIC_API_URL}/v1/payouts/onboarding/refresh"
LINK = "/v1/pros/me/payouts/onboarding-link"
STATUS = "/v1/pros/me/payouts"

UNAVAILABLE = {
    "error": {
        "code": "payments_unavailable",
        "message": "Payments are unavailable right now. Try again later.",
    }
}
PROVIDER_ERROR = {
    "error": {
        "code": "payments_error",
        "message": "The payment provider could not complete the request.",
    }
}
INVALID_TOKEN = {
    "error": {
        "code": "invalid_token",
        "message": "The access token is missing, invalid or expired.",
    }
}
RATE_LIMITED = {"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}}
NEEDS_REVIEW = {
    "error": {
        "code": "payouts_needs_review",
        "message": "Your payout account needs a review by our support team.",
    }
}

NOT_SUBMITTED = AccountState(details_submitted=False, payouts_enabled=False, requirements_due=True)
DUE = AccountState(details_submitted=True, payouts_enabled=False, requirements_due=True)
IN_REVIEW = AccountState(details_submitted=True, payouts_enabled=False, requirements_due=False)
ENABLED = AccountState(details_submitted=True, payouts_enabled=True, requirements_due=False)


@dataclass
class FakeStripe:
    """Records every call; `errors` makes one operation fail; `on_create` runs inside the create
    call, before it answers. `profiles` is each remote account's metadata profile id, which the
    lookup reads; `list_complete` False is a listing stopped at its page bound."""

    states: dict[str, AccountState] = field(default_factory=dict)
    created: list[dict[str, str]] = field(default_factory=list)
    links: list[tuple[str, str, str]] = field(default_factory=list)
    retrieved: list[str] = field(default_factory=list)
    errors: dict[str, Exception] = field(default_factory=dict)
    on_create: Callable[[], Awaitable[None]] | None = None
    profiles: dict[str, str] = field(default_factory=dict)
    looked_up: list[str] = field(default_factory=list)
    list_complete: bool = True

    async def create_express_account(
        self, *, email: str, profile_id: str, idempotency_key: str
    ) -> CreatedAccount:
        if "create" in self.errors:
            raise self.errors["create"]
        self.created.append(
            {"email": email, "profile_id": profile_id, "idempotency_key": idempotency_key}
        )
        if self.on_create is not None:
            await self.on_create()
        account_id = f"acct_fake{len(self.created)}{uuid.uuid4().hex[:6]}"
        self.states[account_id] = NOT_SUBMITTED
        self.profiles[account_id] = profile_id
        return CreatedAccount(account_id=account_id, request_id="req_fake_create")

    async def create_onboarding_link(
        self, account_id: str, *, return_url: str, refresh_url: str
    ) -> OnboardingLink:
        if "link" in self.errors:
            raise self.errors["link"]
        self.links.append((account_id, return_url, refresh_url))
        return OnboardingLink(
            url=f"https://connect.stripe.com/setup/e/{account_id}/fake-{len(self.links)}",
            expires_at=datetime.now(UTC).replace(microsecond=0) + LINK_TTL,
        )

    async def retrieve_account(self, account_id: str) -> AccountState:
        if "retrieve" in self.errors:
            raise self.errors["retrieve"]
        self.retrieved.append(account_id)
        return self.states[account_id]

    async def find_accounts_by_profile(self, profile_id: str) -> ProfileAccounts:
        if "find" in self.errors:
            raise self.errors["find"]
        self.looked_up.append(profile_id)
        matches = tuple(account for account, of in self.profiles.items() if of == profile_id)
        return ProfileAccounts(matches, complete=self.list_complete)

    async def account_profile_id(self, account_id: str) -> str | None:
        """An account missing from `profiles` is one Stripe does not know (a 404); an empty
        profile id is an account without that metadata."""
        if "retrieve" in self.errors:
            raise self.errors["retrieve"]
        if account_id not in self.profiles:
            raise StripeRejectedError(code="resource_missing")
        return self.profiles[account_id] or None


@dataclass
class IdempotentStripe(FakeStripe):
    """Answers a repeated idempotency key with the account its first call made, as Stripe does.
    The first `lost_answers` creates make the account, then fail as a timeout would."""

    accounts_by_key: dict[str, str] = field(default_factory=dict)
    lost_answers: int = 0

    async def create_express_account(
        self, *, email: str, profile_id: str, idempotency_key: str
    ) -> CreatedAccount:
        if "create" in self.errors:
            raise self.errors["create"]
        self.created.append(
            {"email": email, "profile_id": profile_id, "idempotency_key": idempotency_key}
        )
        account_id = self.accounts_by_key.get(idempotency_key)
        if account_id is None:
            account_id = f"acct_fake{len(self.accounts_by_key)}{uuid.uuid4().hex[:6]}"
            self.accounts_by_key[idempotency_key] = account_id
            self.states[account_id] = NOT_SUBMITTED
            self.profiles[account_id] = profile_id
        if self.lost_answers:
            self.lost_answers -= 1
            raise StripeUnavailableError
        return CreatedAccount(account_id=account_id, request_id="req_fake_create")


def _fake_stripe(request: Request) -> StripeConnect:
    """One override for every test (a closure per test would stay in FastAPI's caches, #196)."""
    fake: FakeStripe = request.app.state.fake_stripe
    return fake


@pytest.fixture
def settings() -> Settings:
    # The key is passed as None so a STRIPE_SECRET_KEY in the shell never reaches the app.
    return make_settings(
        stripe_secret_key=None,
        public_api_url=PUBLIC_API_URL,
        payouts_onboarding_app_url=APP_URL,
        payouts_onboarding_link_limit=LIMIT,
        payouts_onboarding_link_window_seconds=WINDOW,
        stripe_account_reconcile_after_seconds=int(RECONCILE_AFTER.total_seconds()),
    )


@pytest.fixture
def stripe(app: FastAPI) -> FakeStripe:
    app.state.fake_stripe = FakeStripe()
    app.dependency_overrides[get_stripe_connect] = _fake_stripe
    fake: FakeStripe = app.state.fake_stripe
    return fake


@pytest.fixture(autouse=True)
def limiter(app: FastAPI) -> InMemoryRateLimiter:
    # A fixed clock, so no test straddles two rate-limit windows.
    limiter = InMemoryRateLimiter(clock=lambda: NOW)
    app.dependency_overrides[get_rate_limiter] = lambda: limiter
    return limiter


async def pro(
    session: AsyncSession, *, account_id: str | None = None, requested_at: datetime | None = None
) -> Caller:
    """A committed pro (an error path rolls the request's transaction back), with a profile
    holding `account_id` and `requested_at` when either is given."""
    caller = await make_caller(session)
    if account_id is not None or requested_at is not None:
        session.add(
            ProProfile(
                user_id=caller.id,
                stripe_account_id=account_id,
                stripe_account_requested_at=requested_at,
            )
        )
    await session.commit()
    return caller


async def profile_of(session: AsyncSession, caller: Caller) -> ProProfile | None:
    return await session.scalar(
        select(ProProfile)
        .where(ProProfile.user_id == caller.id)
        .execution_options(populate_existing=True)
    )


async def email_of(session: AsyncSession, caller: Caller) -> str:
    email = await session.scalar(select(User.email).where(User.id == caller.id))
    assert email is not None
    return email


async def test_onboarding_link_creates_account_once(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    ana = await pro(db_session)
    assert await profile_of(db_session, ana) is None  # the first call creates the profile

    first = await db_client.post(LINK, headers=ana.headers)

    assert first.status_code == 200
    profile = await profile_of(db_session, ana)
    assert profile is not None
    [account_id] = list(stripe.states)
    assert profile.stripe_account_id == account_id
    assert profile.stripe_account_requested_at is not None
    assert stripe.looked_up == []
    assert stripe.created == [
        {
            "email": await email_of(db_session, ana),
            "profile_id": str(profile.id),
            "idempotency_key": f"pro-express-account:{profile.id}",
        }
    ]
    body = first.json()
    assert set(body) == {"url", "expires_at"}
    assert body["url"] == f"https://connect.stripe.com/setup/e/{account_id}/fake-1"
    assert datetime.fromisoformat(body["expires_at"]) > datetime.now(UTC)

    second = await db_client.post(LINK, headers=ana.headers)

    assert second.status_code == 200
    assert len(stripe.created) == 1  # never a second account for the same pro
    assert [link[0] for link in stripe.links] == [account_id, account_id]
    assert second.json()["url"].endswith("/fake-2")
    assert (await profile_of(db_session, ana)).stripe_account_id == account_id  # type: ignore[union-attr]


async def test_onboarding_link_urls_come_from_settings(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    ana = await pro(db_session)
    spoofed = {
        **ana.headers,
        "Host": "evil.example",
        "X-Forwarded-Host": "evil.example",
        "X-Forwarded-Proto": "http",
        "Forwarded": "host=evil.example;proto=http",
        "Origin": "https://evil.example",
        "Referer": "https://evil.example/",
    }

    response = await db_client.post(f"{LINK}?return_url=https://evil.example", headers=spoofed)

    assert response.status_code == 200
    [(_, return_url, refresh_url)] = stripe.links
    assert (return_url, refresh_url) == (RETURN_URL, REFRESH_URL)


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        (None, "not_started"),
        (NOT_SUBMITTED, "incomplete"),
        (
            AccountState(details_submitted=False, payouts_enabled=False, requirements_due=False),
            "incomplete",
        ),
        (DUE, "incomplete"),
        (IN_REVIEW, "in_review"),
        (ENABLED, "enabled"),
        # Stripe may ask for more by a later deadline while payouts stay on.
        (
            AccountState(details_submitted=True, payouts_enabled=True, requirements_due=True),
            "enabled",
        ),
    ],
)
async def test_payouts_status_mapping(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    state: AccountState | None,
    expected: str,
) -> None:
    account_id = None if state is None else f"acct_map{uuid.uuid4().hex[:8]}"
    ana = await pro(db_session, account_id=account_id)
    if account_id is not None and state is not None:
        stripe.states[account_id] = state

    response = await db_client.get(STATUS, headers=ana.headers)

    assert response.status_code == 200
    payouts_enabled = state is not None and state.payouts_enabled
    assert response.json() == {"status": expected, "payouts_enabled": payouts_enabled}
    assert stripe.retrieved == ([] if account_id is None else [account_id])


async def test_payouts_status_without_profile_is_not_started(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    ana = await pro(db_session)

    response = await db_client.get(STATUS, headers=ana.headers)

    assert response.json() == {"status": "not_started", "payouts_enabled": False}
    assert await profile_of(db_session, ana) is None  # a read creates nothing
    assert stripe.retrieved == []


async def test_payouts_status_persists_payouts_enabled(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    account_id = f"acct_persist{uuid.uuid4().hex[:8]}"
    ana = await pro(db_session, account_id=account_id)
    writes: list[bool] = []
    set_payouts_enabled = ProProfileRepository.set_payouts_enabled

    async def recording(self: ProProfileRepository, pro_id: uuid.UUID, enabled: bool) -> bool:
        changed = await set_payouts_enabled(self, pro_id, enabled)
        if changed:  # the row was written
            writes.append(enabled)
        return changed

    monkeypatch.setattr(ProProfileRepository, "set_payouts_enabled", recording)

    async def status_then_stored(state: AccountState) -> bool:
        stripe.states[account_id] = state
        response = await db_client.get(STATUS, headers=ana.headers)
        assert response.status_code == 200
        assert response.json()["payouts_enabled"] is state.payouts_enabled
        profile = await profile_of(db_session, ana)
        assert profile is not None
        return profile.payouts_enabled

    assert await status_then_stored(ENABLED) is True  # false -> true
    assert writes == [True]
    assert await status_then_stored(ENABLED) is True
    assert writes == [True]  # unchanged: no write
    assert await status_then_stored(DUE) is False  # true -> false
    assert writes == [True, False]
    assert await status_then_stored(IN_REVIEW) is False
    assert writes == [True, False]


async def test_set_payouts_enabled_writes_only_a_change(db_session: AsyncSession) -> None:
    ana = await pro(db_session, account_id=f"acct_write{uuid.uuid4().hex[:8]}")
    profile = await profile_of(db_session, ana)
    assert profile is not None
    repository = ProProfileRepository(db_session)

    assert await repository.set_payouts_enabled(profile.id, False) is False
    assert await repository.set_payouts_enabled(profile.id, True) is True
    assert await repository.set_payouts_enabled(profile.id, True) is False


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.AGENT, UserRole.ADMIN])
async def test_payouts_role_and_auth(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe, role: UserRole
) -> None:
    other = await make_caller(db_session, role)
    await db_session.commit()

    for method, path in (("POST", LINK), ("GET", STATUS)):
        forbidden = await db_client.request(method, path, headers=other.headers)
        assert (forbidden.status_code, forbidden.json()) == (403, FORBIDDEN)
        anonymous = await db_client.request(method, path)
        assert (anonymous.status_code, anonymous.json()) == (401, INVALID_TOKEN)

    assert (stripe.created, stripe.links, stripe.retrieved) == ([], [], [])
    assert await db_session.scalar(select(ProProfile).where(ProProfile.user_id == other.id)) is None


async def test_payouts_pro_isolation(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    a_account, b_account = (f"acct_{name}{uuid.uuid4().hex[:8]}" for name in ("a", "b"))
    ana = await pro(db_session, account_id=a_account)
    bea = await pro(db_session, account_id=b_account)
    stripe.states.update({a_account: ENABLED, b_account: DUE})

    link = await db_client.post(LINK, headers=ana.headers)
    status = await db_client.get(STATUS, headers=ana.headers)

    assert link.status_code == 200
    assert b_account not in link.text
    assert status.json() == {"status": "enabled", "payouts_enabled": True}
    assert [entry[0] for entry in stripe.links] == [a_account]
    assert stripe.retrieved == [a_account]
    assert stripe.created == []
    b_profile = await profile_of(db_session, bea)
    assert b_profile is not None
    assert (b_profile.stripe_account_id, b_profile.payouts_enabled) == (b_account, False)

    # And the other way round: B's calls touch B's account only.
    stripe.links.clear()
    stripe.retrieved.clear()
    assert (await db_client.get(STATUS, headers=bea.headers)).json()["status"] == "incomplete"
    assert (await db_client.post(LINK, headers=bea.headers)).status_code == 200
    assert stripe.retrieved == [b_account]
    assert [entry[0] for entry in stripe.links] == [b_account]
    a_profile = await profile_of(db_session, ana)
    assert a_profile is not None
    assert (a_profile.stripe_account_id, a_profile.payouts_enabled) == (a_account, True)


async def test_stripe_not_configured_is_503(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    # No override: the real dependency, and STRIPE_SECRET_KEY is unset.
    ana = await pro(db_session)

    for method, path in (("POST", LINK), ("GET", STATUS)):
        response = await db_client.request(method, path, headers=ana.headers)
        assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert await profile_of(db_session, ana) is None


async def test_public_api_url_missing_is_503(
    app: FastAPI, db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    app.state.settings = make_settings(public_api_url=None)
    ana = await pro(db_session)

    response = await db_client.post(LINK, headers=ana.headers)

    assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert stripe.created == []
    assert await profile_of(db_session, ana) is None


async def test_stripe_unavailable_and_errors(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    limiter: InMemoryRateLimiter,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await pro(db_session)
    account_id = f"acct_err{uuid.uuid4().hex[:8]}"
    bea = await pro(db_session, account_id=account_id)
    stripe.states[account_id] = ENABLED
    unavailable = StripeUnavailableError(request_id="req_fake_503", code=None)
    rejected = StripeRejectedError(request_id="req_fake_404", code="resource_missing")

    async def call(caller: Caller, method: str, path: str) -> httpx.Response:
        limiter.counts.clear()
        return await db_client.request(method, path, headers=caller.headers)

    with caplog.at_level(logging.DEBUG):
        # Timeout or 5xx on the create: no account id stored. The new profile was committed
        # before the call, so a retry sends the same key.
        stripe.errors = {"create": unavailable}
        response = await call(ana, "POST", LINK)
        assert (response.status_code, response.json()) == (503, UNAVAILABLE)
        profile = await profile_of(db_session, ana)
        assert profile is not None
        assert profile.stripe_account_id is None

        # On the link: the account id stays as it was.
        stripe.errors = {"link": unavailable}
        assert (await call(bea, "POST", LINK)).status_code == 503
        stripe.errors = {"link": rejected}
        response = await call(bea, "POST", LINK)
        assert (response.status_code, response.json()) == (502, PROVIDER_ERROR)
        assert (await profile_of(db_session, bea)).stripe_account_id == account_id  # type: ignore[union-attr]

        # On the status: payouts_enabled stays as it was.
        stripe.errors = {"retrieve": unavailable}
        response = await call(bea, "GET", STATUS)
        assert (response.status_code, response.json()) == (503, UNAVAILABLE)
        stripe.errors = {"retrieve": rejected}
        response = await call(bea, "GET", STATUS)
        assert (response.status_code, response.json()) == (502, PROVIDER_ERROR)
        assert (await profile_of(db_session, bea)).payouts_enabled is False  # type: ignore[union-attr]

        # A working round, so success logs are checked too.
        stripe.errors = {}
        assert (await call(ana, "POST", LINK)).status_code == 200
        assert (await call(bea, "GET", STATUS)).status_code == 200

    formatter = JsonFormatter()
    lines = [formatter.format(record) for record in caplog.records]
    rejected_logs = [json.loads(line) for line in lines if "payouts_stripe_rejected" in line]
    assert {(log["operation"], log["stripe_code"]) for log in rejected_logs} == {
        ("create_link", "resource_missing"),
        ("retrieve_account", "resource_missing"),
    }
    assert all(log["stripe_request_id"] == "req_fake_404" for log in rejected_logs)
    assert any("payouts_account_created" in line for line in lines)
    secrets = [
        await email_of(db_session, ana),
        await email_of(db_session, bea),
        account_id,
        *stripe.states,
        "connect.stripe.com",
        "sk_test_",
    ]
    for line in lines:
        for secret in secrets:
            assert secret not in line, line


async def _refused_lookup(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    caplog: pytest.LogCaptureFixture,
    *,
    matches: int,
) -> tuple[Caller, list[dict[str, object]]]:
    """A pro whose create was attempted longer ago than RECONCILE_AFTER, with no stored account,
    and `matches` remote accounts naming the profile: the call answers 409, creates nothing and
    stores nothing, the attempt's time unchanged. Returns the pro and the JSON log lines."""
    attempted = datetime.now(UTC) - RECONCILE_AFTER - timedelta(1)
    ana = await pro(db_session, requested_at=attempted)
    profile = await profile_of(db_session, ana)
    assert profile is not None
    profile_id = str(profile.id)  # read before the call, whose commit expires the row
    remote = [f"acct_dup{index}{uuid.uuid4().hex[:8]}" for index in range(matches)]
    stripe.profiles = dict.fromkeys(remote, profile_id)

    with caplog.at_level(logging.DEBUG):
        response = await db_client.post(LINK, headers=ana.headers)

    assert (response.status_code, response.json()) == (409, NEEDS_REVIEW)
    assert stripe.looked_up == [profile_id]
    assert stripe.created == []
    assert stripe.links == []
    after = await profile_of(db_session, ana)
    assert after is not None
    assert (after.stripe_account_id, after.stripe_account_requested_at) == (None, attempted)
    formatter = JsonFormatter()
    lines = [formatter.format(record) for record in caplog.records]
    for line in lines:
        for private in (*remote, await email_of(db_session, ana)):
            assert private not in line, line
    return ana, [json.loads(line) for line in lines]


async def test_no_matching_account_refuses_with_needs_review(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A complete listing with no account naming the profile does not prove the old create can
    never land (#279 Vault round 2): no new create, the attempt stays unresolved for staff."""
    _, logs = await _refused_lookup(db_client, db_session, stripe, caplog, matches=0)

    [ambiguous] = [log for log in logs if log["message"] == "payouts_account_ambiguous"]
    assert ambiguous["level"] == "ERROR"
    assert (ambiguous["count"], ambiguous["listing_complete"]) == (0, True)


async def test_two_matching_accounts_refuse_with_needs_review(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Two remote accounts name the profile: neither is adopted and no third is created; an
    ERROR log carries the pro id and the count, never an account id or the email."""
    _, logs = await _refused_lookup(db_client, db_session, stripe, caplog, matches=2)

    [ambiguous] = [log for log in logs if log["message"] == "payouts_account_ambiguous"]
    assert ambiguous["level"] == "ERROR"
    assert (ambiguous["count"], ambiguous["listing_complete"]) == (2, True)


async def test_listing_bound_reached_refuses_with_needs_review(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    stripe: FakeStripe,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The listing stopped at its page bound with one match so far: another may follow, so the
    match is not adopted and nothing is created."""
    stripe.list_complete = False

    _, logs = await _refused_lookup(db_client, db_session, stripe, caplog, matches=1)

    [ambiguous] = [log for log in logs if log["message"] == "payouts_account_ambiguous"]
    assert (ambiguous["count"], ambiguous["listing_complete"]) == (1, False)


async def test_lookup_failure_is_503_and_creates_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    ana = await pro(db_session, requested_at=datetime.now(UTC) - RECONCILE_AFTER - timedelta(1))
    stripe.errors = {"find": StripeUnavailableError(request_id="req_fake_503")}

    response = await db_client.post(LINK, headers=ana.headers)

    assert (response.status_code, response.json()) == (503, UNAVAILABLE)
    assert stripe.created == []
    assert (await profile_of(db_session, ana)).stripe_account_id is None  # type: ignore[union-attr]


async def test_onboarding_rate_limited(
    db_client: httpx.AsyncClient, db_session: AsyncSession, stripe: FakeStripe
) -> None:
    ana = await pro(db_session)
    bea = await pro(db_session)

    for _ in range(LIMIT):
        assert (await db_client.post(LINK, headers=ana.headers)).status_code == 200
    limited = await db_client.post(LINK, headers=ana.headers)

    assert (limited.status_code, limited.json()) == (429, RATE_LIMITED)
    assert int(limited.headers["Retry-After"]) > 0
    assert len(stripe.links) == LIMIT
    # Per pro: another pro still gets a link, and the status is not limited.
    assert (await db_client.post(LINK, headers=bea.headers)).status_code == 200
    assert (await db_client.get(STATUS, headers=ana.headers)).status_code == 200


@pytest.mark.parametrize("result", ["return", "refresh"])
async def test_return_pages(client: httpx.AsyncClient, result: str) -> None:
    # No token, no database: the plain client, with a query and headers that try to steer it.
    response = await client.get(
        f"/v1/payouts/onboarding/{result}?next=https://evil.example&x=%3Cscript%3Ealert(1)",
        headers={"Host": "evil.example", "X-Forwarded-Host": "evil.example"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-security-policy"] == "default-src 'none'"
    page = response.text
    link = f"{APP_URL}?result={result}"
    assert f'<meta http-equiv="refresh" content="0; url={link}">' in page
    assert f'<a href="{link}">Back to Jack Fix It</a>' in page
    assert "<script" not in page.lower()
    assert "evil" not in page
    assert "next=" not in page


def test_return_pages_are_public_and_unlisted(app: FastAPI) -> None:
    for result in ("return", "refresh"):
        assert ("GET", f"/v1/payouts/onboarding/{result}") in PUBLIC_ROUTES
    paths = app.openapi()["paths"]
    assert "/v1/pros/me/payouts" in paths
    assert "/v1/pros/me/payouts/onboarding-link" in paths
    assert not [path for path in paths if path.startswith("/v1/payouts/")]


# Calls that overlap or retry: real commits on their own connections. The tests create their
# own rows and delete them afterwards.


@dataclass(frozen=True)
class NewPro:
    """A committed pro user, without a profile yet."""

    sessions: async_sessionmaker[AsyncSession]
    user: UserAccount


@dataclass(frozen=True)
class CommittedPro:
    sessions: async_sessionmaker[AsyncSession]
    user: UserAccount
    profile_id: uuid.UUID


@pytest.fixture
async def new_pro(test_database_url: URL) -> AsyncIterator[NewPro]:
    engine = create_async_engine(test_database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        user = User(email=f"pro-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
        session.add(user)
        await session.commit()
        account = UserAccount(
            id=user.id, email=user.email, role=user.role, locale=user.locale, status=user.status
        )
    try:
        yield NewPro(sessions, account)
    finally:
        async with sessions() as session:
            await session.execute(delete(ProProfile).where(ProProfile.user_id == user.id))
            await session.execute(delete(User).where(User.id == user.id))
            await session.commit()
        await engine.dispose()


@pytest.fixture
async def committed_pro(new_pro: NewPro) -> CommittedPro:
    async with new_pro.sessions() as session:
        profile = ProProfile(user_id=new_pro.user.id)
        session.add(profile)
        await session.commit()
    return CommittedPro(new_pro.sessions, new_pro.user, profile.id)


async def test_onboarding_link_concurrent_first_calls_create_one_account(
    committed_pro: CommittedPro,
) -> None:
    """Whichever call creates the account holds it there, its profile row locked, until Postgres
    reports the other call waiting on that lock; then it stores the id and commits, and the
    other one reuses it. Without the lock, nothing ever waits and the create fails after the
    deadline."""
    sessions = committed_pro.sessions
    stripe = FakeStripe()
    async with sessions() as one, sessions() as two:
        pids = [await _backend_pid(one), await _backend_pid(two)]

        async def hold_until_the_other_waits() -> None:
            await _wait_until_one_blocks(sessions, pids)

        stripe.on_create = hold_until_the_other_waits
        results = await asyncio.gather(
            *(
                PayoutsService(session, ProService(session), stripe, CONFIG).onboarding_link(
                    committed_pro.user
                )
                for session in (one, two)
            ),
            return_exceptions=True,
        )

    assert [type(result).__name__ for result in results] == ["OnboardingLinkOut"] * 2
    assert len(stripe.created) == 1
    [account_id] = list(stripe.states)
    assert [link[0] for link in stripe.links] == [account_id, account_id]
    async with sessions() as session:
        stored = await session.scalar(
            select(ProProfile.stripe_account_id).where(ProProfile.id == committed_pro.profile_id)
        )
    assert stored == account_id


async def test_onboarding_link_retry_after_lost_create_answer_reuses_the_account(
    new_pro: NewPro,
) -> None:
    """A pro without a profile: Stripe makes the account, but its answer is lost. The new
    profile was committed before the call, so the retry, in a fresh session, sends the same key
    and metadata, and Stripe answers with the same account. With the profile rolled back, the
    retry made a new profile id, a new key and a second account."""
    stripe = IdempotentStripe(lost_answers=1)
    async with new_pro.sessions() as session:
        with pytest.raises(PaymentsUnavailableError):
            await PayoutsService(session, ProService(session), stripe, CONFIG).onboarding_link(
                new_pro.user
            )
    async with new_pro.sessions() as session:
        await PayoutsService(session, ProService(session), stripe, CONFIG).onboarding_link(
            new_pro.user
        )
        profile = await session.scalar(
            select(ProProfile).where(ProProfile.user_id == new_pro.user.id)
        )

    assert len(stripe.created) == 2
    assert stripe.created[1] == stripe.created[0]
    [account_id] = stripe.accounts_by_key.values()
    assert profile is not None
    assert stripe.created[0]["profile_id"] == str(profile.id)
    assert profile.stripe_account_id == account_id
    assert stripe.links == [(account_id, RETURN_URL, REFRESH_URL)]


async def _link(new_pro: NewPro, stripe: FakeStripe) -> None:
    """One onboarding-link call in a fresh session, as a later request would be."""
    async with new_pro.sessions() as session:
        await PayoutsService(session, ProService(session), stripe, CONFIG).onboarding_link(
            new_pro.user
        )


async def _profile(new_pro: NewPro) -> ProProfile:
    async with new_pro.sessions() as session:
        profile = await session.scalar(
            select(ProProfile).where(ProProfile.user_id == new_pro.user.id)
        )
    assert profile is not None
    return profile


async def _age_attempt(new_pro: NewPro, by: timedelta) -> None:
    """Moves the profile's create attempt `by` into the past, as time passing would."""
    async with new_pro.sessions() as session:
        await session.execute(
            update(ProProfile)
            .where(ProProfile.user_id == new_pro.user.id)
            .values(stripe_account_requested_at=ProProfile.stripe_account_requested_at - by)
        )
        await session.commit()


async def test_retry_within_window_replays_with_the_same_key(new_pro: NewPro) -> None:
    """Stripe made the account, its answer was lost, and the retry comes just inside
    RECONCILE_AFTER: Stripe still holds the key, so the retry sends it again, with no lookup,
    and gets the same account back."""
    stripe = IdempotentStripe(lost_answers=1)
    with pytest.raises(PaymentsUnavailableError):
        await _link(new_pro, stripe)
    await _age_attempt(new_pro, RECONCILE_AFTER - timedelta(minutes=5))
    attempted = (await _profile(new_pro)).stripe_account_requested_at

    await _link(new_pro, stripe)

    [account_id] = stripe.accounts_by_key.values()
    assert len(stripe.created) == 2
    assert stripe.created[1] == stripe.created[0]
    assert stripe.looked_up == []
    profile = await _profile(new_pro)
    assert (profile.stripe_account_id, profile.stripe_account_requested_at) == (
        account_id,
        attempted,
    )


async def test_retry_after_key_pruned_adopts_the_existing_account(new_pro: NewPro) -> None:
    """The Vault's reproduction (#279): Stripe made account A, its answer was lost, and the pro
    comes back after Stripe forgot the key (it may, once the key is 24 hours old). A create now
    would make account B; instead the retry finds A by its metadata and stores it, with no
    second create. Until then, and after, the profile is not hireable."""
    stripe = IdempotentStripe(lost_answers=1)
    with pytest.raises(PaymentsUnavailableError):
        await _link(new_pro, stripe)
    [account_a] = stripe.states
    lost = await _profile(new_pro)
    assert lost.stripe_account_id is None
    assert lost.stripe_account_requested_at is not None
    stripe.accounts_by_key.clear()  # Stripe pruned the key; account A stays
    await _age_attempt(new_pro, RECONCILE_AFTER + timedelta(minutes=5))

    await _link(new_pro, stripe)

    profile = await _profile(new_pro)
    assert list(stripe.states) == [account_a]
    assert len(stripe.created) == 1
    assert stripe.looked_up == [str(profile.id)]
    assert profile.stripe_account_id == account_a
    assert stripe.links == [(account_a, RETURN_URL, REFRESH_URL)]
    assert profile.payouts_enabled is False
    async with new_pro.sessions() as session:
        assert await ProService(session).hireable_cards([profile.id]) == {}


async def test_zero_matches_after_window_refuses_and_keeps_the_stamp(new_pro: NewPro) -> None:
    """The first create failed with nothing visible in Stripe; the retries come after
    RECONCILE_AFTER: each lookup finds nothing, and each answers 409 without a create, the
    attempt's time as it was. Round 2 stamped it again and created; that is gone (#279)."""
    stripe = IdempotentStripe(errors={"create": StripeUnavailableError()})
    with pytest.raises(PaymentsUnavailableError):
        await _link(new_pro, stripe)
    await _age_attempt(new_pro, RECONCILE_AFTER + timedelta(minutes=5))
    aged = (await _profile(new_pro)).stripe_account_requested_at
    stripe.errors.clear()

    for _ in range(2):
        with pytest.raises(PayoutsNeedsReviewError):
            await _link(new_pro, stripe)

    profile = await _profile(new_pro)
    assert stripe.states == {}
    assert stripe.created == []
    assert stripe.looked_up == [str(profile.id)] * 2
    assert (profile.stripe_account_id, profile.stripe_account_requested_at) == (None, aged)


@dataclass
class CachedFailureStripe(FakeStripe):
    """The Vault's model of an unresolved create (#279 round 2): Stripe answers the key with a
    cached 500 and shows no account, then makes the account while recovering from the incident
    (`recover`), without changing the cached answer. Once `pruned`, the key is forgotten and a
    create makes a new account. `recover_after_listing`: the recovery lands right after the
    next listing, between it and whatever the caller does next."""

    pruned: bool = False
    recover_after_listing: bool = False

    async def create_express_account(
        self, *, email: str, profile_id: str, idempotency_key: str
    ) -> CreatedAccount:
        if not self.pruned:
            self.created.append(
                {"email": email, "profile_id": profile_id, "idempotency_key": idempotency_key}
            )
            raise StripeUnavailableError(code="api_error")
        return await super().create_express_account(
            email=email, profile_id=profile_id, idempotency_key=idempotency_key
        )

    def recover(self) -> None:
        original = self.created[0]
        self.states["acct_recovered"] = NOT_SUBMITTED
        self.profiles["acct_recovered"] = original["profile_id"]

    async def find_accounts_by_profile(self, profile_id: str) -> ProfileAccounts:
        found = await super().find_accounts_by_profile(profile_id)
        if self.recover_after_listing:
            self.recover_after_listing = False
            self.recover()
        return found


@pytest.mark.parametrize("recovery", ["after_cached_failure_replay", "after_empty_listing"])
async def test_unresolved_create_never_makes_a_second_account(
    new_pro: NewPro, recovery: str
) -> None:
    """The Vault's two probes (#279 round 2), each of which left two accounts on round 2:

    - after_cached_failure_replay: past RECONCILE_AFTER the lookup is empty, then Stripe's
      incident recovery makes the account, then Stripe prunes the key;
    - after_empty_listing: past RECONCILE_AFTER, the key pruned, the recovery lands between the
      empty listing and the create that used to follow it.

    The empty lookup answers 409 with no create and the attempt's time unchanged; the next call
    finds the recovered account and adopts it: one remote account, never two."""
    stripe = CachedFailureStripe()
    with pytest.raises(PaymentsUnavailableError):
        await _link(new_pro, stripe)
    await _age_attempt(new_pro, RECONCILE_AFTER + timedelta(hours=1))
    attempted = (await _profile(new_pro)).stripe_account_requested_at
    if recovery == "after_empty_listing":
        stripe.pruned = True
        stripe.recover_after_listing = True

    with pytest.raises(PayoutsNeedsReviewError):
        await _link(new_pro, stripe)

    unresolved = await _profile(new_pro)
    assert (unresolved.stripe_account_id, unresolved.stripe_account_requested_at) == (
        None,
        attempted,
    )
    assert len(stripe.created) == 1
    if recovery == "after_cached_failure_replay":
        stripe.recover()
        stripe.pruned = True

    await _link(new_pro, stripe)

    profile = await _profile(new_pro)
    assert list(stripe.states) == ["acct_recovered"]
    assert len(stripe.created) == 1
    assert stripe.looked_up == [str(profile.id)] * 2
    assert profile.stripe_account_id == "acct_recovered"
    assert profile.stripe_account_requested_at == attempted
    assert profile.payouts_enabled is False


class HeldRead(FakeStripe):
    """Enters its account read, then answers once `release` is set."""

    def __init__(self, states: dict[str, AccountState]) -> None:
        super().__init__(states=states)
        self.reading = asyncio.Event()
        self.release = asyncio.Event()

    async def retrieve_account(self, account_id: str) -> AccountState:
        self.reading.set()
        await self.release.wait()
        return await super().retrieve_account(account_id)


async def test_payouts_status_overlapping_reads_store_the_last_answer(
    committed_pro: CommittedPro,
) -> None:
    """Two status calls for one pro overlap: the first is inside its Stripe read (payouts not
    enabled) when the second starts (enabled). The first read answers once the second call has
    finished or waits on the first. Whichever call finishes last, its answer is the stored one,
    and each call answers what Stripe told it. Gated on the value read before the call, the
    second stored true and the first answered false over it, leaving true stored. The second
    call must also have waited on the first's row lock: without it, an older Stripe answer
    could be stored over a newer one."""
    sessions = committed_pro.sessions
    account_id = f"acct_overlap{uuid.uuid4().hex[:8]}"
    async with sessions() as session:
        await session.execute(
            update(ProProfile)
            .where(ProProfile.id == committed_pro.profile_id)
            .values(stripe_account_id=account_id)
        )
        await session.commit()
    held = HeldRead(states={account_id: DUE})
    finished: list[str] = []

    async def status(name: str, session: AsyncSession, stripe: FakeStripe) -> bool:
        service = PayoutsService(session, ProService(session), stripe, CONFIG)
        response = await service.status(committed_pro.user)
        finished.append(name)
        return response.payouts_enabled

    async with sessions() as one, sessions() as two:
        pids = [await _backend_pid(one), await _backend_pid(two)]
        first = asyncio.create_task(status("first", one, held))
        async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
            await held.reading.wait()
        second = asyncio.create_task(
            status("second", two, FakeStripe(states={account_id: ENABLED}))
        )
        await _wait_until_one_blocks(sessions, pids, unless=second)
        second_waited = not second.done()
        held.release.set()
        answers = dict(zip(("first", "second"), await asyncio.gather(first, second), strict=True))
    async with sessions() as session:
        stored = await session.scalar(
            select(ProProfile.payouts_enabled).where(ProProfile.id == committed_pro.profile_id)
        )

    assert answers == {"first": False, "second": True}
    assert len(finished) == 2
    assert stored is answers[finished[-1]]
    assert second_waited


async def _backend_pid(session: AsyncSession) -> int:
    pid = await session.scalar(text("SELECT pg_backend_pid()"))
    assert isinstance(pid, int)
    return pid


async def _wait_until_one_blocks(
    sessions: async_sessionmaker[AsyncSession],
    pids: list[int],
    *,
    unless: asyncio.Task[bool] | None = None,
) -> None:
    """Returns once Postgres reports either backend waiting on a lock the other holds, or once
    the `unless` task is done."""
    first, second = pids
    query = text(
        "SELECT CAST(:second AS integer) = ANY(pg_blocking_pids(:first)) "
        "OR CAST(:first AS integer) = ANY(pg_blocking_pids(:second))"
    )
    async with sessions() as monitor:
        try:
            async with asyncio.timeout(LOCK_WAIT_DEADLINE_SECONDS):
                while not (unless is not None and unless.done()) and not await monitor.scalar(
                    query, {"first": first, "second": second}
                ):
                    pass
        except TimeoutError:
            pytest.fail(f"neither call waited on the other within {LOCK_WAIT_DEADLINE_SECONDS} s")
