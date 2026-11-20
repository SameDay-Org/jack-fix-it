"""The legal documents' acceptances (#97): GET /v1/me/terms, POST /v1/me/terms-acceptance and
UserOut.terms_required. The versions come from the settings; the texts are the apps'."""

import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.terms.models import TermsAcceptance
from tests.conftest import make_settings

TERMS, PRIVACY, PRO_AGREEMENT = "2026-11-20", "privacy-2026.1", "pro_v1"
PASSWORD = "correct horse battery"


@pytest.fixture
def settings() -> Settings:
    return make_settings(
        terms_version=TERMS, privacy_version=PRIVACY, pro_agreement_version=PRO_AGREEMENT
    )


async def sign_up(client: httpx.AsyncClient, role: str = "customer") -> dict[str, Any]:
    response = await client.post(
        "/v1/auth/register",
        json={
            "email": f"{role}-{uuid.uuid4().hex[:10]}@example.com",
            "password": PASSWORD,
            "role": role,
        },
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def bearer(session: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {session['access_token']}"}


async def accept(
    client: httpx.AsyncClient, session: dict[str, Any], kind: str, version: str, **extra: Any
) -> httpx.Response:
    return await client.post(
        "/v1/me/terms-acceptance",
        json={"kind": kind, "version": version, **extra},
        headers=bearer(session),
    )


async def test_a_new_customer_must_accept_terms_and_privacy(db_client: httpx.AsyncClient) -> None:
    registered = await sign_up(db_client)

    terms = await db_client.get("/v1/me/terms", headers=bearer(registered))

    assert registered["user"]["terms_required"] is True
    assert terms.status_code == 200
    assert terms.json() == {
        "terms_required": True,
        "documents": [
            {"kind": "terms", "version": TERMS, "accepted": False, "accepted_at": None},
            {"kind": "privacy", "version": PRIVACY, "accepted": False, "accepted_at": None},
        ],
    }


async def test_accepting_every_document_lifts_the_requirement_everywhere(
    db_client: httpx.AsyncClient,
) -> None:
    registered = await sign_up(db_client, "pro")
    for kind, version in (("terms", TERMS), ("privacy", PRIVACY)):
        assert (await accept(db_client, registered, kind, version)).status_code == 200
    # A pro also accepts the pro agreement.
    assert (await db_client.get("/v1/auth/me", headers=bearer(registered))).json()[
        "terms_required"
    ] is True

    accepted = await accept(db_client, registered, "pro_agreement", PRO_AGREEMENT)
    me = await db_client.get("/v1/auth/me", headers=bearer(registered))
    login = await db_client.post(
        "/v1/auth/login", json={"email": registered["user"]["email"], "password": PASSWORD}
    )
    terms = await db_client.get("/v1/me/terms", headers=bearer(registered))

    assert accepted.json()["accepted"] is True
    assert me.json()["terms_required"] is False
    assert login.json()["user"]["terms_required"] is False
    assert terms.json()["terms_required"] is False
    assert [d["kind"] for d in terms.json()["documents"]] == ["terms", "privacy", "pro_agreement"]


async def test_accepting_again_answers_the_same_with_the_first_time(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    registered = await sign_up(db_client)

    first = await accept(db_client, registered, "terms", TERMS)
    again = await accept(db_client, registered, "terms", TERMS)

    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    rows = await db_session.scalar(
        select(func.count())
        .select_from(TermsAcceptance)
        .where(TermsAcceptance.user_id == uuid.UUID(registered["user"]["id"]))
    )
    assert rows == 1


@pytest.mark.parametrize(
    ("kind", "version"),
    [("terms", "2026-01-01"), ("privacy", TERMS), ("pro_agreement", PRO_AGREEMENT)],
    ids=["an_older_version", "another_kinds_version", "a_kind_the_role_does_not_accept"],
)
async def test_anything_but_a_document_in_force_is_refused(
    db_client: httpx.AsyncClient, db_session: AsyncSession, kind: str, version: str
) -> None:
    registered = await sign_up(db_client)  # a customer: no pro agreement

    response = await accept(db_client, registered, kind, version)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "terms_not_current"
    assert await db_session.scalar(select(func.count()).select_from(TermsAcceptance).where(
        TermsAcceptance.user_id == uuid.UUID(registered["user"]["id"])
    )) == 0  # fmt: skip


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "cookies", "version": TERMS},
        {"kind": "terms", "version": "has spaces"},
        {"kind": "terms", "version": "-leading-dash"},
        {"kind": "terms", "version": "x" * 65},
        {"kind": "terms"},
        {"kind": "terms", "version": TERMS, "text": "I agree"},
    ],
    ids=["unknown_kind", "spaces", "leading_dash", "too_long", "no_version", "extra_field"],
)
async def test_a_body_that_is_not_an_acceptance_is_refused(
    db_client: httpx.AsyncClient, body: dict[str, str]
) -> None:
    registered = await sign_up(db_client)

    response = await db_client.post(
        "/v1/me/terms-acceptance", json=body, headers=bearer(registered)
    )

    assert response.status_code == 422


async def test_the_routes_need_a_signed_in_caller(db_client: httpx.AsyncClient) -> None:
    assert (await db_client.get("/v1/me/terms")).status_code == 401
    assert (
        await db_client.post("/v1/me/terms-acceptance", json={"kind": "terms", "version": TERMS})
    ).status_code == 401


@pytest.mark.parametrize("settings", [make_settings()])
async def test_with_no_version_published_nothing_is_required(
    db_client: httpx.AsyncClient,
) -> None:
    registered = await sign_up(db_client, "pro")

    terms = await db_client.get("/v1/me/terms", headers=bearer(registered))
    refused = await accept(db_client, registered, "terms", TERMS)

    assert registered["user"]["terms_required"] is False
    assert terms.json() == {"terms_required": False, "documents": []}
    assert refused.status_code == 409


def test_a_version_setting_must_be_an_id() -> None:
    with pytest.raises(ValueError, match="terms_version"):
        make_settings(terms_version="not an id")
