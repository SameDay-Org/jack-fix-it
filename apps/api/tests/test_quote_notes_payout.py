"""#246: the quote's "How I'll do the job" note, and what the pro will receive at the platform's
take rate (Cesar, 2026-10-29: 15%, the platform absorbs Stripe's card fee)."""

import logging
import re
import unicodedata
import uuid
from typing import Any, Literal

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import get_storage
from app.modules.dispatch.models import DispatchStatus, RequestDispatch
from app.modules.quotes.models import Quote
from app.modules.quotes.schemas import (
    CustomerQuote,
    CustomerQuoteList,
    ProPublicProfile,
    QuotePro,
)
from app.modules.requests.models import RequestStatus
from app.modules.settings.models import Setting
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from app.queue import get_job_queue
from tests.conftest import make_settings
from tests.contact_overlaps import CUT_CONTACTS, PHONE_EMAIL_OVERLAPS
from tests.test_opportunities_api import (
    T0,
    World,
    build_world,
    dispatch,
    dispatch_row,
    make_request,
)
from tests.test_quote_accept_api import accept_path
from tests.test_quote_list_api import ITEM_KEYS, customer, headers_for, quoting_pro
from tests.test_quote_list_api import path as list_path
from tests.test_quote_pro_profile_api import PROFILE_KEYS, profile_path
from tests.test_quotes_api import (
    AMOUNT,
    TTL_HOURS,
    body,
    quote,
    quotes_of,
    set_setting,
    status_of,
)
from tests.test_quotes_api import path as quote_path
from tests.test_requests_api import ENQUEUE_TIMEOUT, FakeStorage, RecordingQueue

TAKE_RATE = "platform_take_rate_bps"
# What only the pro sees: never in a customer-facing schema, route or response.
SPLIT_FIELDS = {"pro_payout_cents", "platform_fee_cents", "take_rate_bps"}
NOT_CONFIGURED = {
    "error": {"code": "not_configured", "message": "This feature is not configured yet."}
}


@pytest.fixture
def settings() -> Settings:
    return make_settings(job_enqueue_timeout_seconds=ENQUEUE_TIMEOUT)


@pytest.fixture(autouse=True)
def queue(app: FastAPI) -> RecordingQueue:
    """The quote pushes' queue (#55): recorded, never Redis."""
    recorder = RecordingQueue()
    app.dependency_overrides[get_job_queue] = lambda: recorder
    return recorder


@pytest.fixture(autouse=True)
def storage(app: FastAPI) -> FakeStorage:
    fake = FakeStorage()
    app.dependency_overrides[get_storage] = lambda: fake
    return fake


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    return await build_world(db_session)


@pytest.fixture(autouse=True)
async def quote_ttl(db_session: AsyncSession) -> None:
    """The quote TTL, a fixture value; the take rate stays absent (the default) unless a test
    stores one. Both in the rolled-back test session."""
    await set_setting(db_session, "quote_ttl_hours", TTL_HOURS)
    await db_session.execute(delete(Setting).where(Setting.key == TAKE_RATE))


def detail_path(dispatch_id: uuid.UUID) -> str:
    return f"/v1/pros/me/opportunities/{dispatch_id}"


# The pro sees what they will receive


async def test_quote_response_includes_payout_for_pro(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    response = await quote(db_client, world.me, dispatch_id)

    assert response.status_code == 201, response.text
    out = response.json()
    # 98,765 at the default 1500 bps: a fee of 14,814.75, rounded half up.
    assert (out["amount_cents"], out["pro_payout_cents"], out["platform_fee_cents"]) == (
        AMOUNT,
        83_950,
        14_815,
    )
    # The amount is stored as given: the split is not stored (the job freezes it, #58/#61).
    [stored] = await quotes_of(db_session, request_id)
    assert stored.amount_cents == AMOUNT


@pytest.mark.parametrize(
    ("bps", "payout", "fee"),
    [(0, AMOUNT, 0), (1234, 86_577, 12_188), (10_000, 0, AMOUNT)],
    ids=["zero", "stored", "whole"],
)
async def test_quote_payout_reads_the_stored_take_rate(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    bps: int,
    payout: int,
    fee: int,
) -> None:
    await set_setting(db_session, TAKE_RATE, bps)
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    out = (await quote(db_client, world.me, dispatch_id)).json()

    assert (out["pro_payout_cents"], out["platform_fee_cents"]) == (payout, fee)


@pytest.mark.parametrize(
    "stored",
    ["1500", -1, 10_001, True, 1500.5, None, [1500], {"bps": 1500}],
    ids=["string", "negative", "above_whole", "true", "float", "null", "list", "object"],
)
async def test_an_invalid_take_rate_503_and_nothing_written(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    queue: RecordingQueue,
    caplog: pytest.LogCaptureFixture,
    stored: object,
) -> None:
    await set_setting(db_session, TAKE_RATE, stored)
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    with caplog.at_level(logging.DEBUG):
        response = await quote(db_client, world.me, dispatch_id)

    assert response.status_code == 503
    assert response.json() == NOT_CONFIGURED
    assert await quotes_of(db_session, request_id) == []
    assert (await dispatch_row(db_session, dispatch_id)).status is DispatchStatus.SENT
    assert await status_of(db_session, request_id) is RequestStatus.FINDING_PRO
    assert queue.jobs == {}  # no new quote push
    [invalid] = [r for r in caplog.records if r.message == "setting_invalid"]
    [refused] = [r for r in caplog.records if r.message == "quote_not_configured"]
    assert invalid.__dict__["key"] == refused.__dict__["key"] == TAKE_RATE
    assert '"value"' not in "\n".join(JsonFormatter().format(r) for r in caplog.records)


@pytest.mark.parametrize("field", ["pro_payout_cents", "platform_fee_cents", "take_rate_bps"])
async def test_client_cannot_send_the_split_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, field: str
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    response = await quote(db_client, world.me, dispatch_id, **{field: 1})

    assert response.status_code == 422
    assert await quotes_of(db_session, request_id) == []


@pytest.mark.parametrize(("stored", "shown"), [(None, 1500), (1234, 1234)], ids=["default", "set"])
async def test_opportunity_detail_take_rate(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    stored: int | None,
    shown: int,
) -> None:
    if stored is not None:
        await set_setting(db_session, TAKE_RATE, stored)
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await db_client.get(detail_path(dispatch_id), headers=world.me.caller.headers)

    assert response.status_code == 200, response.text
    assert response.json()["take_rate_bps"] == shown


async def test_opportunity_detail_invalid_take_rate_503_and_not_viewed(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await set_setting(db_session, TAKE_RATE, "1500")
    dispatch_id = await dispatch(db_session, await make_request(db_session, world), world.me)

    response = await db_client.get(detail_path(dispatch_id), headers=world.me.caller.headers)

    assert response.status_code == 503
    assert response.json() == NOT_CONFIGURED
    row = await dispatch_row(db_session, dispatch_id)
    assert (row.status, row.viewed_at) == (DispatchStatus.SENT, None)


# The approach note


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({}, None),
        ({"approach": None}, None),
        ({"approach": ""}, None),
        ({"approach": " \n\t "}, None),
        ({"approach": "  Shut the valve first.  "}, "Shut the valve first."),
        ({"approach": "x" * 2000}, "x" * 2000),
        ({"approach": f" {'x' * 2000} "}, "x" * 2000),
    ],
    ids=["omitted", "null", "empty", "blank", "trimmed", "max", "max_after_trim"],
)
async def test_approach_validation_stores(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    overrides: dict[str, Any],
    expected: str | None,
) -> None:
    """Empty or blank is no note: stored as null, not a 422."""
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    response = await quote(db_client, world.me, dispatch_id, **overrides)

    assert response.status_code == 201, response.text
    assert response.json()["approach"] == expected
    [stored] = await quotes_of(db_session, request_id)
    assert stored.approach == expected


@pytest.mark.parametrize(
    "approach",
    ["x" * 2001, "a\x00b", "\x00", 5, ["note"]],
    ids=["too_long", "nul", "only_nul", "number", "list"],
)
async def test_approach_validation_refuses_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World, approach: object
) -> None:
    request_id = await make_request(db_session, world)
    dispatch_id = await dispatch(db_session, request_id, world.me)

    response = await quote(db_client, world.me, dispatch_id, approach=approach)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert await quotes_of(db_session, request_id) == []


async def test_approach_masked_for_customer_raw_for_pro(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world)
    pro = await quoting_pro(db_session)  # hireable, and the test's first: it holds PRO_PHONE
    row = RequestDispatch(request_id=request_id, pro_id=pro.profile_id, sent_at=T0)
    db_session.add(row)
    await db_session.flush()
    local, domain = pro.email.split("@")
    # The pro's own email spaced out, their own phone in a grouping only the known-value pass
    # masks, a phone pattern and a handle: the same text as the scope, masked the same way.
    note = (
        "Shut the valve, swap the cartridge, then test for leaks. "
        f"Questions: {local.upper()} @ {domain.replace('.', ' . ')}, 30 55 55 01 99, "
        "786-555-0142 or DM @probe_fixer246."
    )

    sent = await db_client.post(
        quote_path(row.id),
        json=body(scope=note, approach=note),
        headers=headers_for(pro.user_id, UserRole.PRO),
    )

    assert sent.status_code == 201, sent.text
    assert (sent.json()["approach"], sent.json()["scope"]) == (note, note)  # the pro's own
    listed = await db_client.get(list_path(request_id), headers=customer(world))
    [item] = listed.json()["items"]
    assert set(item) == ITEM_KEYS
    masked = (
        "Shut the valve, swap the cartridge, then test for leaks. "
        "Questions: •••, •••, ••• or DM •••."
    )
    assert item["approach"] == item["scope"] == masked
    stored = await db_session.scalar(
        select(Quote.approach)
        .where(Quote.id == uuid.UUID(item["id"]))
        .execution_options(populate_existing=True)
    )
    assert stored == note  # masked at read: the original is kept
    profile = await db_client.get(
        profile_path(request_id, uuid.UUID(item["id"])), headers=customer(world)
    )
    assert profile.status_code == 200, profile.text
    assert set(profile.json()) == PROFILE_KEYS  # the public profile is unaffected
    assert "Shut the valve" not in profile.text

    accepted = await db_client.post(
        accept_path(request_id, uuid.UUID(item["id"])), headers=customer(world)
    )

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["approach"] == masked


@pytest.mark.parametrize("form", ["NFC", "NFD"])
async def test_a_phone_an_email_overlaps_is_masked_whole_in_scope_and_approach(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    form: Literal["NFC", "NFD"],
) -> None:
    """Vault round 1 on #240: the email took the phone's last group and the customer read
    "786 555". The pro's own phone is 305 555 0199, so the ASCII case (#257) would be masked
    by the known values; the three Vault inputs reach the patterns."""
    request_id = await make_request(db_session, world)
    pro = await quoting_pro(db_session)
    row = RequestDispatch(request_id=request_id, pro_id=pro.profile_id, sent_at=T0)
    db_session.add(row)
    await db_session.flush()
    marked, spacing_mark, unicode_domain = PHONE_EMAIL_OVERLAPS[:3]
    note = unicodedata.normalize(
        form, f"Questions: call {marked}, llama {spacing_mark}, or write {unicode_domain}."
    )

    sent = await db_client.post(
        quote_path(row.id),
        json=body(scope=note, approach=note),
        headers=headers_for(pro.user_id, UserRole.PRO),
    )

    assert sent.status_code == 201, sent.text
    listed = await db_client.get(list_path(request_id), headers=customer(world))
    assert listed.status_code == 200, listed.text
    [item] = listed.json()["items"]
    masked = "Questions: call •••, llama •••, or write •••."
    assert item["scope"] == item["approach"] == masked
    assert not re.search(r"\d", item["scope"] + item["approach"])


@pytest.mark.parametrize("form", ["NFC", "NFD"])
async def test_a_handle_or_street_an_email_cuts_is_masked_whole_in_scope_and_approach(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    world: World,
    form: Literal["NFC", "NFD"],
) -> None:
    """Vault round 2 on #240: the URL took "insta" and the customer read "jdoe1", the email
    took "Dr" and the customer read "1250 Ocean"."""
    request_id = await make_request(db_session, world)
    pro = await quoting_pro(db_session)
    row = RequestDispatch(request_id=request_id, pro_id=pro.profile_id, sent_at=T0)
    db_session.add(row)
    await db_session.flush()
    (handle, handle_secret), (street, street_secret) = CUT_CONTACTS
    note = unicodedata.normalize(
        form, f"Preguntas: escríbeme a {handle}, o pasa por {street} mañana."
    )

    sent = await db_client.post(
        quote_path(row.id),
        json=body(scope=note, approach=note),
        headers=headers_for(pro.user_id, UserRole.PRO),
    )

    assert sent.status_code == 201, sent.text
    listed = await db_client.get(list_path(request_id), headers=customer(world))
    assert listed.status_code == 200, listed.text
    [item] = listed.json()["items"]
    masked = "Preguntas: escríbeme a •••, o pasa por ••• mañana."
    assert item["scope"] == item["approach"] == masked
    for secret in (handle_secret, street_secret, "1250"):
        assert secret not in item["scope"] + item["approach"]


async def test_customer_quote_without_approach_shows_null(
    db_client: httpx.AsyncClient, db_session: AsyncSession, world: World
) -> None:
    request_id = await make_request(db_session, world)
    pro = await quoting_pro(db_session)
    row = RequestDispatch(request_id=request_id, pro_id=pro.profile_id, sent_at=T0)
    db_session.add(row)
    await db_session.flush()
    sent = await db_client.post(
        quote_path(row.id), json=body(), headers=headers_for(pro.user_id, UserRole.PRO)
    )
    assert sent.status_code == 201, sent.text

    [item] = (await db_client.get(list_path(request_id), headers=customer(world))).json()["items"]

    assert item["approach"] is None


# The customer never sees the payout, the fee or the take rate


def _property_names(value: object) -> set[str]:
    """Every property name anywhere in a JSON schema document."""
    names: set[str] = set()
    if isinstance(value, dict):
        properties = value.get("properties")
        if isinstance(properties, dict):
            names |= set(properties)
        for item in value.values():
            names |= _property_names(item)
    elif isinstance(value, list):
        for item in value:
            names |= _property_names(item)
    return names


def _response_property_names(operation: dict[str, Any], components: dict[str, Any]) -> set[str]:
    """The property names of every response schema of an operation, following $refs."""
    names: set[str] = set()
    pending = [
        media["schema"]
        for response in operation.get("responses", {}).values()
        for media in response.get("content", {}).values()
        if "schema" in media
    ]
    seen: set[str] = set()
    while pending:
        schema = pending.pop()
        names |= _property_names(schema)
        for ref in _refs(schema):
            name = ref.rsplit("/", 1)[-1]
            if name not in seen:
                seen.add(name)
                pending.append(components[name])
    return names


def _refs(value: object) -> list[str]:
    if isinstance(value, dict):
        own = [value["$ref"]] if isinstance(value.get("$ref"), str) else []
        return own + [ref for item in value.values() for ref in _refs(item)]
    if isinstance(value, list):
        return [ref for item in value for ref in _refs(item)]
    return []


def test_customer_quote_has_no_payout_fields(app: FastAPI) -> None:
    # The customer-facing schemas: the list, its items, the acceptance's response, the profile.
    for model in (CustomerQuote, CustomerQuoteList, QuotePro, ProPublicProfile):
        assert not SPLIT_FIELDS & _property_names(model.model_json_schema(mode="serialization"))

    schema = app.openapi()
    components = schema["components"]["schemas"]
    # Only the pro's own quote and opportunity show any of them.
    allowed = {
        ("post", "/v1/pros/me/opportunities/{dispatch_id}/quote"): {
            "pro_payout_cents",
            "platform_fee_cents",
        },
        ("get", "/v1/pros/me/opportunities/{dispatch_id}"): {"take_rate_bps"},
    }
    shown: dict[tuple[str, str], set[str]] = {}
    for path, operations in schema["paths"].items():
        for method, operation in operations.items():
            found = SPLIT_FIELDS & _response_property_names(operation, components)
            if found:
                shown[(method, path)] = found
    assert shown == allowed
    # The customer's quote routes are among those walked, and show none of them.
    for method, path in (
        ("get", "/v1/requests/{request_id}/quotes"),
        ("post", "/v1/requests/{request_id}/quotes/{quote_id}/accept"),
        ("get", "/v1/requests/{request_id}/quotes/{quote_id}/pro"),
    ):
        operation = schema["paths"][path][method]
        names = _response_property_names(operation, components)
        assert "amount_cents" in names or "bio" in names  # the walk reached the schema
        assert not SPLIT_FIELDS & names
