"""GET and PATCH /v1/me/notification-preferences (D13, #217)."""

from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications import catalog
from app.modules.notifications.models import NotificationPreference
from app.modules.notifications.preferences import (
    KIND_GROUP,
    PREFERENCE_GROUPS,
    SPECS,
    TEST_KIND,
    Channel,
    push_kind,
)
from app.modules.notifications.schemas import NotificationPreferencesPatch
from app.modules.users.types import UserRole
from tests.test_devices_api import caller

BASE = "/v1/me/notification-preferences"
VALIDATION_ERROR = {"error": {"code": "validation_error", "message": "The request is invalid."}}
LOCKED = {
    "error": {"code": "preference_locked", "message": "This notification cannot be turned off."}
}
INVALID_TOKEN = "invalid_token"


def channel(name: str, enabled: bool, locked: bool = False) -> dict[str, Any]:
    return {"channel": name, "enabled": enabled, "locked": locked}


DEFAULTS = {
    "groups": [
        {"group": "job_updates", "channels": [channel("push", True)]},
        {"group": "quotes_and_opportunities", "channels": [channel("push", True)]},
        {"group": "reminders", "channels": [channel("push", True)]},
        {"group": "marketing", "channels": [channel("push", False), channel("email", False)]},
        {
            "group": "account_and_security",
            "channels": [
                channel("push", True, locked=True),
                channel("email", True, locked=True),
                channel("sms", True, locked=True),
            ],
        },
    ]
}


def change(group: str, name: str, enabled: bool) -> dict[str, Any]:
    return {"group": group, "channel": name, "enabled": enabled}


def enabled_in(body: dict[str, Any], group: str, name: str) -> bool:
    [entry] = [g for g in body["groups"] if g["group"] == group]
    [pair] = [c for c in entry["channels"] if c["channel"] == name]
    value: bool = pair["enabled"]
    return value


async def stored(session: AsyncSession) -> set[tuple[str, str, bool]]:
    statement = select(
        NotificationPreference.group, NotificationPreference.channel, NotificationPreference.enabled
    ).execution_options(populate_existing=True)
    return {(row[0], row[1], row[2]) for row in (await session.execute(statement)).all()}


async def test_get_defaults_for_new_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    for role in (UserRole.CUSTOMER, UserRole.PRO):  # same groups for both roles
        _, headers = await caller(db_session, role)
        response = await db_client.get(BASE, headers=headers)
        assert response.status_code == 200
        assert response.json() == DEFAULTS


async def test_patch_marketing_email_on_then_get(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, headers = await caller(db_session)

    response = await db_client.patch(
        BASE,
        json={
            "changes": [change("marketing", "email", True), change("job_updates", "push", False)]
        },
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == (await db_client.get(BASE, headers=headers)).json()
    body = response.json()
    assert enabled_in(body, "marketing", "email") is True
    assert enabled_in(body, "marketing", "push") is False  # untouched: still the default
    assert enabled_in(body, "job_updates", "push") is False
    # Back on, and a value equal to the default: GET reads it either way.
    response = await db_client.patch(
        BASE,
        json={
            "changes": [change("marketing", "email", False), change("job_updates", "push", True)]
        },
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json() == DEFAULTS


async def test_patch_locked_off_is_422_and_writes_nothing(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, headers = await caller(db_session)
    for locked in ("push", "email", "sms"):
        response = await db_client.patch(
            BASE,
            json={
                "changes": [
                    change("marketing", "email", True),  # valid, but not stored either
                    change("account_and_security", locked, False),
                ]
            },
            headers=headers,
        )
        assert response.status_code == 422
        assert response.json() == LOCKED

    assert await stored(db_session) == set()
    assert (await db_client.get(BASE, headers=headers)).json() == DEFAULTS


async def test_patch_locked_on_is_noop(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, headers = await caller(db_session)

    response = await db_client.patch(
        BASE,
        json={
            "changes": [
                change("account_and_security", "sms", True),
                change("marketing", "push", True),
            ]
        },
        headers=headers,
    )

    assert response.status_code == 200
    assert enabled_in(response.json(), "account_and_security", "sms") is True
    assert enabled_in(response.json(), "marketing", "push") is True
    assert await stored(db_session) == {("marketing", "push", True)}


async def test_patch_unknown_group_or_channel_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, headers = await caller(db_session)
    valid = change("marketing", "email", True)
    for invalid in (
        change("newsletter", "push", True),  # unknown group
        change("marketing", "fax", True),  # unknown channel
        change("job_updates", "sms", True),  # a channel the group does not have
        change("reminders", "email", False),
        {**change("marketing", "push", True), "locked": False},  # an unknown field
        {"group": "marketing", "channel": "push"},  # enabled missing
        {"group": "marketing", "channel": "push", "enabled": None},
        {"group": "marketing", "channel": "push", "enabled": "maybe"},
    ):
        response = await db_client.patch(BASE, json={"changes": [valid, invalid]}, headers=headers)
        assert response.status_code == 422, invalid
        assert response.json() == VALIDATION_ERROR

    assert await stored(db_session) == set()


async def test_patch_duplicates_empty_and_21_items_are_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _, headers = await caller(db_session)
    pairs = [(spec.group.value, c.value) for spec in PREFERENCE_GROUPS for c in spec.channels]
    distinct = [change(g, c, True) for g, c in pairs]
    # Only 9 pairs exist, so 21 items repeat some: the length is refused before the repeats.
    too_many = {"changes": (distinct * 3)[:21]}
    with pytest.raises(ValidationError) as error:
        NotificationPreferencesPatch.model_validate(too_many)
    assert {e["type"] for e in error.value.errors()} == {"too_long"}
    bodies: list[dict[str, Any]] = [
        {"changes": [change("marketing", "email", True), change("marketing", "email", False)]},
        {"changes": [change("marketing", "email", True), change("marketing", "email", True)]},
        {"changes": []},
        {},
        too_many,
    ]
    for body in bodies:
        response = await db_client.patch(BASE, json=body, headers=headers)
        assert response.status_code == 422
        assert response.json() == VALIDATION_ERROR

    assert await stored(db_session) == set()
    # Every pair once, locked ones on, is accepted (the limit is 20; there are 9 pairs).
    response = await db_client.patch(BASE, json={"changes": distinct}, headers=headers)
    assert response.status_code == 200


async def test_patch_isolated_per_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    ana_id, ana = await caller(db_session)
    _, bruno = await caller(db_session, UserRole.PRO)

    response = await db_client.patch(
        BASE, json={"changes": [change("quotes_and_opportunities", "push", False)]}, headers=ana
    )

    assert response.status_code == 200
    assert enabled_in(response.json(), "quotes_and_opportunities", "push") is False
    assert (await db_client.get(BASE, headers=bruno)).json() == DEFAULTS
    rows = (await db_session.scalars(select(NotificationPreference))).all()
    assert [(row.user_id, row.group, row.enabled) for row in rows] == [
        (ana_id, "quotes_and_opportunities", False)
    ]


async def test_requires_token(db_client: httpx.AsyncClient) -> None:
    body = {"changes": [change("marketing", "email", True)]}
    for headers in ({}, {"Authorization": "Bearer not-a-token"}):
        get = await db_client.get(BASE, headers=headers)
        patch = await db_client.patch(BASE, json=body, headers=headers)
        for response in (get, patch):
            assert response.status_code == 401
            assert response.json()["error"]["code"] == INVALID_TOKEN


def test_every_catalog_kind_has_a_group() -> None:
    kinds = {push_kind(key) for key in catalog.catalog_keys()}
    assert set(KIND_GROUP) == kinds - {TEST_KIND}
    assert TEST_KIND in kinds
    assert TEST_KIND not in KIND_GROUP  # never muted
    for group in KIND_GROUP.values():
        assert Channel.PUSH in SPECS[group].channels


def test_openapi_documents_the_error_codes(app: FastAPI) -> None:
    paths = app.openapi()["paths"][BASE]
    assert "invalid_token" in paths["get"]["responses"]["401"]["description"]
    patch = paths["patch"]["responses"]
    assert "invalid_token" in patch["401"]["description"]
    assert "preference_locked" in patch["422"]["description"]
    assert "validation_error" in patch["422"]["description"]
