"""POST /v1/requests/{request_id}/quotes/{quote_id}/accept: the customer accepts a quote (D10.1,
#189)."""

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.service import SystemActor
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.quotes import service as quote_service
from app.modules.quotes.errors import QuoteNotAcceptableError
from app.modules.quotes.models import Quote, QuoteStatus
from app.modules.quotes.service import QuoteService
from app.modules.requests.models import RequestStatus
from app.modules.requests.state_machine import RequestStateMachine
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.test_opportunities_api import NOT_FOUND, World, build_world, make_request
from tests.test_quote_list_api import (
    FORBIDDEN,
    INVALID_TOKEN,
    ITEM_KEYS,
    QuotingPro,
    add_quote,
    counted_statements,
    customer,
    headers_for,
    path,
    quoting_pro,
)
from tests.test_quotes_api import quotes_of, status_of
from tests.test_requests_api import ENQUEUE_TIMEOUT, RecordingQueue, make_caller

NOT_ACCEPTABLE = {
    "error": {
        "code": "quote_not_acceptable",
        "message": "This quote can no longer be accepted.",
    }
}
# What every log record carries without an `extra`: the rest of a record is the event's own.
_RECORD_FIELDS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """QuoteService takes the new quote push's queue (#55): recorded, never Redis."""
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


def accept_path(request_id: uuid.UUID, quote_id: uuid.UUID) -> str:
    return f"/v1/requests/{request_id}/quotes/{quote_id}/accept"


async def accept(
    client: httpx.AsyncClient, world: World, request_id: uuid.UUID, quote_id: uuid.UUID
) -> httpx.Response:
    return await client.post(accept_path(request_id, quote_id), headers=customer(world))


async def statuses(
    session: AsyncSession, request_id: uuid.UUID
) -> tuple[RequestStatus, dict[uuid.UUID, QuoteStatus]]:
    """The request's status and each of its quotes', as committed (not the identity map)."""
    quotes = await quotes_of(session, request_id)
    return await status_of(session, request_id), {quote.id: quote.status for quote in quotes}


async def open_request(
    session: AsyncSession, world: World, count: int = 3
) -> tuple[uuid.UUID, list[uuid.UUID], list[QuotingPro]]:
    """A quote_ready request with `count` live pending quotes, cheapest first."""
    request_id = await make_request(session, world, RequestStatus.QUOTE_READY)
    pros = [await quoting_pro(session) for _ in range(count)]
    quotes = [
        await add_quote(session, request_id, pro, amount=10_000 + n) for n, pro in enumerate(pros)
    ]
    return request_id, quotes, pros


def events(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.message == message]


async def customer_account(session: AsyncSession, world: World) -> UserAccount:
    user = await session.get(User, world.customer_id)
    assert user is not None
    return UserAccount(
        id=user.id, email=user.email, role=user.role, locale=user.locale, status=user.status
    )


# Accepting


async def test_owner_accepts_a_pending_quote(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id, [cheap, chosen, dear], pros = await open_request(db_session, world)
    # The pro's own email in the scope: the response masks it, as the list does.
    stored = await db_session.get(Quote, chosen)
    assert stored is not None
    stored.scope = f"Replace the valve, write to {pros[1].email}"
    await db_session.flush()
    [listed_before] = [
        item
        for item in (await db_client.get(path(request_id), headers=customer(world))).json()["items"]
        if item["id"] == str(chosen)
    ]

    with caplog.at_level(logging.DEBUG):
        response = await accept(db_client, world, request_id, chosen)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == ITEM_KEYS
    assert body == {**listed_before, "status": "accepted"}
    assert body["scope"] == "Replace the valve, write to •••"
    assert body["pro"]["id"] == str(pros[1].profile_id)
    # The list now shows it accepted, the same item.
    listed_after = (await db_client.get(path(request_id), headers=customer(world))).json()
    assert body in listed_after["items"]
    assert await statuses(db_session, request_id) == (
        RequestStatus.ACCEPTED,
        {cheap: QuoteStatus.PENDING, chosen: QuoteStatus.ACCEPTED, dear: QuoteStatus.PENDING},
    )
    [logged] = events(caplog, "quote_accepted")
    extra = {key: value for key, value in logged.__dict__.items() if key not in _RECORD_FIELDS}
    assert extra == {
        "quote_id": str(chosen),
        "service_request_id": str(request_id),
        "pro_id": str(pros[1].profile_id),
    }
    [changed] = events(caplog, "request_status_changed")
    assert (changed.__dict__["from_status"], changed.__dict__["to_status"]) == (
        "quote_ready",
        "accepted",
    )
    assert changed.__dict__["actor_kind"] == "customer"
    output = "\n".join(JsonFormatter().format(record) for record in caplog.records)
    for secret in (pros[1].email, "Replace the valve"):
        assert secret not in output, secret


async def test_accepting_again_is_idempotent(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id, [other, chosen], _ = await open_request(db_session, world, count=2)

    with caplog.at_level(logging.INFO):
        first = await accept(db_client, world, request_id, chosen)
        with counted_statements(db_session) as statements:
            again = await accept(db_client, world, request_id, chosen)

    assert (first.status_code, again.status_code) == (200, 200)
    assert again.content == first.content
    assert await statuses(db_session, request_id) == (
        RequestStatus.ACCEPTED,
        {other: QuoteStatus.PENDING, chosen: QuoteStatus.ACCEPTED},
    )
    # Nothing written by the repeat: its statements only read (and lock). The test session's
    # own SAVEPOINT (its commit releases one) is not the service's.
    writes = [
        sql for sql in statements if sql.lstrip().upper().startswith(("UPDATE", "INSERT", "DELETE"))
    ]
    assert writes == []
    assert len(events(caplog, "quote_accepted")) == 1
    assert len(events(caplog, "request_status_changed")) == 1


async def test_accepted_quote_stays_acceptable_past_its_expiry(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """Accepted, the quote is no longer an offer: its expires_at no longer applies, as in the
    list, so a retry after it passed still answers 200."""
    request_id = await make_request(db_session, world, RequestStatus.ACCEPTED)
    quote_id = await add_quote(
        db_session,
        request_id,
        await quoting_pro(db_session),
        status=QuoteStatus.ACCEPTED,
        expires_in=-timedelta(hours=1),
    )

    response = await accept(db_client, world, request_id, quote_id)

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"


# Refused: 409, nothing changed


async def test_another_quote_after_acceptance_is_409(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    caplog: pytest.LogCaptureFixture,
) -> None:
    request_id, [first, second], _ = await open_request(db_session, world, count=2)
    assert (await accept(db_client, world, request_id, first)).status_code == 200
    caplog.clear()

    with caplog.at_level(logging.INFO):
        response = await accept(db_client, world, request_id, second)

    assert response.status_code == 409
    assert response.json() == NOT_ACCEPTABLE
    assert await statuses(db_session, request_id) == (
        RequestStatus.ACCEPTED,
        {first: QuoteStatus.ACCEPTED, second: QuoteStatus.PENDING},
    )
    assert events(caplog, "quote_accepted") == []


@pytest.mark.parametrize(
    ("status", "expires_in"),
    [
        (QuoteStatus.REJECTED, timedelta(hours=24)),
        (QuoteStatus.EXPIRED, timedelta(hours=24)),
        (QuoteStatus.WITHDRAWN, timedelta(hours=24)),
        # Still "pending" in the table (no expiry worker yet, #51), but past its expires_at.
        (QuoteStatus.PENDING, -timedelta(seconds=1)),
        # Accepted, but its request is back in quote_ready (payment failed, #61): not this
        # endpoint's state to repair.
        (QuoteStatus.ACCEPTED, timedelta(hours=24)),
    ],
)
async def test_closed_or_expired_quotes_are_not_acceptable(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    status: QuoteStatus,
    expires_in: timedelta,
) -> None:
    request_id = await make_request(db_session, world, RequestStatus.QUOTE_READY)
    quote_id = await add_quote(
        db_session, request_id, await quoting_pro(db_session), status=status, expires_in=expires_in
    )

    response = await accept(db_client, world, request_id, quote_id)

    assert response.status_code == 409
    assert response.json() == NOT_ACCEPTABLE
    assert await statuses(db_session, request_id) == (
        RequestStatus.QUOTE_READY,
        {quote_id: status},
    )


async def test_expiry_boundary_is_already_expired(
    db_session: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """expires_at equal to now is expired: an offer is open strictly before its expires_at."""
    request_id, [quote_id], _ = await open_request(db_session, world, count=1)
    stored = await db_session.get(Quote, quote_id)
    assert stored is not None
    service = QuoteService(db_session, RecordingQueue(), ENQUEUE_TIMEOUT)
    actor = await customer_account(db_session, world)

    def frozen_at(moment: datetime) -> type[datetime]:
        class Frozen(datetime):
            @classmethod
            def now(cls, tz: Any = None) -> "Frozen":
                return cls.fromtimestamp(moment.timestamp(), tz)

        return Frozen

    monkeypatch.setattr(quote_service, "datetime", frozen_at(stored.expires_at))
    savepoint = await db_session.begin_nested()
    with pytest.raises(QuoteNotAcceptableError):
        await service.accept(actor, request_id, quote_id)
    await savepoint.rollback()

    monkeypatch.setattr(
        quote_service, "datetime", frozen_at(stored.expires_at - timedelta(microseconds=1))
    )
    accepted = await service.accept(actor, request_id, quote_id)

    assert accepted.status is QuoteStatus.ACCEPTED


@pytest.mark.parametrize(
    ("verification", "payouts_enabled"),
    [
        (ProVerificationStatus.PENDING, True),
        (ProVerificationStatus.REJECTED, True),
        (ProVerificationStatus.APPROVED, False),
    ],
)
async def test_ineligible_pro_quote_is_not_acceptable(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    verification: ProVerificationStatus,
    payouts_enabled: bool,
) -> None:
    """Only approved pros with payouts enabled receive requests (context doc): one who lost
    either since quoting cannot be paid out."""
    request_id, [kept, lost], pros = await open_request(db_session, world, count=2)
    profile = await db_session.get(ProProfile, pros[1].profile_id)
    assert profile is not None
    profile.verification_status = verification
    profile.payouts_enabled = payouts_enabled
    await db_session.flush()

    response = await accept(db_client, world, request_id, lost)

    assert response.status_code == 409
    assert response.json() == NOT_ACCEPTABLE
    assert await statuses(db_session, request_id) == (
        RequestStatus.QUOTE_READY,
        {kept: QuoteStatus.PENDING, lost: QuoteStatus.PENDING},
    )
    listed = (await db_client.get(path(request_id), headers=customer(world))).json()["items"]
    assert [item["id"] for item in listed] == [str(kept)]


async def test_accepted_quote_of_a_pro_no_longer_hireable_is_409(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    """A retry once the pro lost their payouts: the quote is accepted, but it cannot be paid, so
    it is neither listed nor confirmed again (the list and the accept agree)."""
    request_id, [quote_id], pros = await open_request(db_session, world, count=1)
    assert (await accept(db_client, world, request_id, quote_id)).status_code == 200
    profile = await db_session.get(ProProfile, pros[0].profile_id)
    assert profile is not None
    profile.payouts_enabled = False
    await db_session.flush()

    response = await accept(db_client, world, request_id, quote_id)

    assert response.status_code == 409
    assert response.json() == NOT_ACCEPTABLE
    assert await statuses(db_session, request_id) == (
        RequestStatus.ACCEPTED,
        {quote_id: QuoteStatus.ACCEPTED},
    )


@pytest.mark.parametrize(
    "status",
    [
        RequestStatus.RECEIVED,
        RequestStatus.REVIEWING,
        RequestStatus.FINDING_PRO,
        RequestStatus.EXPIRED,
        RequestStatus.CANCELLED,
    ],
)
async def test_request_not_open_for_acceptance_is_409(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, status: RequestStatus
) -> None:
    request_id = await make_request(db_session, world, status)
    # A live pending quote left on the request (nothing closes quotes on a closed request yet).
    quote_id = await add_quote(db_session, request_id, await quoting_pro(db_session))

    response = await accept(db_client, world, request_id, quote_id)

    assert response.status_code == 409
    assert response.json() == NOT_ACCEPTABLE
    assert await statuses(db_session, request_id) == (status, {quote_id: QuoteStatus.PENDING})


# Who may accept


async def test_foreign_or_unknown_ids_are_404_alike(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id, [mine], _ = await open_request(db_session, world, count=1)
    other_request, [elsewhere], _ = await open_request(db_session, world, count=1)
    # Accepted already: its owner would get 200 with the quote, and a closed one 409.
    accepted_request = await make_request(db_session, world, RequestStatus.ACCEPTED)
    accepted = await add_quote(
        db_session, accepted_request, await quoting_pro(db_session), status=QuoteStatus.ACCEPTED
    )
    stranger = await make_caller(db_session, UserRole.CUSTOMER)

    responses = [
        # A quote of the customer's other request, under this one.
        await accept(db_client, world, request_id, elsewhere),
        # Another customer's request, with its own quote.
        await db_client.post(accept_path(request_id, mine), headers=stranger.headers),
        await db_client.post(accept_path(accepted_request, accepted), headers=stranger.headers),
        await accept(db_client, world, request_id, uuid.uuid4()),
        await accept(db_client, world, uuid.uuid4(), mine),
    ]

    assert [response.status_code for response in responses] == [404] * 5
    assert all(response.json() == NOT_FOUND for response in responses)
    assert len({response.content for response in responses}) == 1
    for request, quote in ((request_id, mine), (other_request, elsewhere)):
        assert await statuses(db_session, request) == (
            RequestStatus.QUOTE_READY,
            {quote: QuoteStatus.PENDING},
        )


async def test_non_customers_are_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id, [quote_id], pros = await open_request(db_session, world, count=1)
    admin = await make_caller(db_session, UserRole.ADMIN)
    callers = [
        headers_for(pros[0].user_id, UserRole.PRO),  # even the pro who quoted
        headers_for(world.agent_id, UserRole.AGENT),
        admin.headers,
    ]

    for headers in callers:
        response = await db_client.post(accept_path(request_id, quote_id), headers=headers)
        assert response.status_code == 403
        assert response.json() == FORBIDDEN
    for headers in ({}, {"Authorization": "Bearer not-a-token"}):
        response = await db_client.post(accept_path(request_id, quote_id), headers=headers)
        assert response.status_code == 401
        assert response.json() == INVALID_TOKEN
    assert await statuses(db_session, request_id) == (
        RequestStatus.QUOTE_READY,
        {quote_id: QuoteStatus.PENDING},
    )


async def test_malformed_ids_422(db_client: httpx.AsyncClient, world: World) -> None:
    for url in (
        f"/v1/requests/not-a-uuid/quotes/{uuid.uuid4()}/accept",
        f"/v1/requests/{uuid.uuid4()}/quotes/not-a-uuid/accept",
    ):
        response = await db_client.post(url, headers=customer(world))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


# One transaction


async def test_acceptance_is_atomic(
    db_session: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    request_id, [quote_id], _ = await open_request(db_session, world, count=1)
    seen: list[tuple[RequestStatus, dict[uuid.UUID, QuoteStatus]]] = []
    transition = RequestStateMachine.transition

    async def fail(
        self: RequestStateMachine,
        request: uuid.UUID,
        to: RequestStatus,
        actor: UserAccount | SystemActor,
    ) -> RequestStatus:
        # The real transition runs: both rows are written when the failure comes.
        await transition(self, request, to, actor)
        seen.append(await statuses(db_session, request_id))
        raise RuntimeError("synthetic failure at the end of the request's transition")

    monkeypatch.setattr(RequestStateMachine, "transition", fail)
    actor = await customer_account(db_session, world)
    savepoint = await db_session.begin_nested()  # the request's transaction
    with pytest.raises(RuntimeError):
        await QuoteService(db_session, RecordingQueue(), ENQUEUE_TIMEOUT).accept(
            actor, request_id, quote_id
        )
    await savepoint.rollback()

    assert seen == [(RequestStatus.ACCEPTED, {quote_id: QuoteStatus.ACCEPTED})]
    assert await statuses(db_session, request_id) == (
        RequestStatus.QUOTE_READY,
        {quote_id: QuoteStatus.PENDING},
    )


# The contract


def test_openapi_documents_the_route(app: FastAPI) -> None:
    schema = app.openapi()
    operation = schema["paths"]["/v1/requests/{request_id}/quotes/{quote_id}/accept"]["post"]

    assert set(operation["responses"]) == {"200", "401", "403", "404", "409", "422"}
    assert "quote_not_acceptable" in operation["responses"]["409"]["description"]
    assert "not_found" in operation["responses"]["404"]["description"]
    assert "forbidden" in operation["responses"]["403"]["description"]
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/CustomerQuote"
    }
    assert operation["tags"] == ["quotes"]
