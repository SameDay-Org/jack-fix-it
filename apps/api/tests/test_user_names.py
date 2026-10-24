"""First and last names on user accounts (#165): register, PATCH /v1/auth/me, public_name, CLI."""

import json
import logging
from typing import Any

import httpx
import pytest
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.modules.users.models import User
from app.modules.users.names import PersonName, public_name, safe_public_name
from app.observability import JsonFormatter
from app.redaction import KnownValues
from tests.test_auth_api import EMAIL, VALIDATION_ERROR, get_user, register
from tests.test_create_staff_user import PASSWORD as STAFF_PASSWORD
from tests.test_create_staff_user import STORED_EMAIL as STAFF_EMAIL
from tests.test_create_staff_user import Terminal, staff_cli, user_by_email

NAME: TypeAdapter[str] = TypeAdapter(PersonName)
# Fixture names only.
FIRST = "María José"
LAST = "O'Neil-Pérez"


async def signed_in(client: httpx.AsyncClient, **names: Any) -> dict[str, str]:
    response = await register(client, **names)
    assert response.status_code == 201
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def patch_me(client: httpx.AsyncClient, headers: dict[str, str], body: Any) -> httpx.Response:
    return await client.patch("/v1/auth/me", json=body, headers=headers)


# The name type


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("María José", "María José"),
        ("O'Neil", "O'Neil"),
        # The apostrophe phone keyboards type.
        ("O\N{RIGHT SINGLE QUOTATION MARK}Neil", "O\N{RIGHT SINGLE QUOTATION MARK}Neil"),
        ("Jr.", "Jr."),
        ("Jean-Luc", "Jean-Luc"),
        ("  de   la  Cruz ", "de la Cruz"),
        ("Zoë", "Zoë"),
        # A combining diaeresis, kept as entered.
        ("Zoe\N{COMBINING DIAERESIS}", "Zoe\N{COMBINING DIAERESIS}"),
        ("李", "李"),
        ("a" * 60, "a" * 60),
    ],
)
def test_name_validation_accepts(raw: str, stored: str) -> None:
    assert NAME.validate_python(raw) == stored


@pytest.mark.parametrize(
    "raw",
    [
        "Ana2",
        "\N{FULLWIDTH DIGIT FOUR}",  # a fullwidth digit
        "Ana\x00",
        "Ana\tMaria",
        "Ana\nMaria",
        "Ana\N{ZERO WIDTH SPACE}Maria",  # zero-width space (a format character)
        "Ana 🙂",
        "a" * 61,
        "",
        "   ",
        "-",
        ".'",
        "Ana_Maria",
        "Ana@x",
        42,
    ],
    ids=[
        "digit",
        "fullwidth_digit",
        "nul",
        "tab",
        "newline",
        "zero_width",
        "emoji",
        "61_chars",
        "empty",
        "blank",
        "hyphen_only",
        "punctuation_only",
        "underscore",
        "at_sign",
        "not_a_string",
    ],
)
def test_name_validation_rejects(raw: object) -> None:
    with pytest.raises(ValidationError):
        NAME.validate_python(raw)


def test_public_name_initial_and_none_cases() -> None:
    assert public_name("María", "Pérez") == "María P."
    assert public_name("Jean-Luc", "de la Cruz") == "Jean-Luc D."
    assert public_name("Ana", "O'Neil") == "Ana O."
    assert public_name("Ana", "Ñúñez") == "Ana Ñ."
    for first, last in (("María", None), (None, "Pérez"), (None, None)):
        assert public_name(first, last) is None


# What PersonName lets through yet names a contact (Vault, #194).
CONTACT_NAMES = (
    "repair.example.com",
    "contact at example dot com",
    "three zero five five five five zero one nine nine",
)
OWN = KnownValues(emails=("juan.perez@x.com",), phones=("+13055550199",))


def test_safe_public_name_keeps_ordinary_names() -> None:
    for first, last, shown in (
        ("María", "Pérez", "María P."),
        ("Jean-Luc", "de la Cruz", "Jean-Luc D."),
        ("Ana", "O'Neil", "Ana O."),
        (
            "D\N{RIGHT SINGLE QUOTATION MARK}Angelo",
            "Ñúñez",
            "D\N{RIGHT SINGLE QUOTATION MARK}Angelo Ñ.",
        ),
        ("J.R.", "Smith", "J.R. S."),
    ):
        assert safe_public_name(first, last, OWN) == shown
    for first, last in (("María", None), (None, "Pérez"), (None, None)):
        assert safe_public_name(first, last, OWN) is None


@pytest.mark.parametrize("first", CONTACT_NAMES)
def test_safe_public_name_withholds_a_contact_pattern(first: str) -> None:
    """Withheld whole, never partly masked; with or without the account's own contacts."""
    assert safe_public_name(first, "Perez", OWN) is None
    assert safe_public_name(first, "Perez", KnownValues()) is None


def test_safe_public_name_withholds_the_accounts_own_email_and_phone() -> None:
    """A handle-shaped local part and an odd phone grouping are no pattern (app.redaction known
    gaps): only the account's own values withhold them. A stored name may predate PersonName,
    hence the digits."""
    for first in ("juan.perez", "30 55 55 01 99"):
        assert safe_public_name(first, "Gómez", OWN) is None
        assert safe_public_name(first, "Gómez", KnownValues()) == f"{first} G."


# Register


async def test_register_without_names_still_works(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await register(db_client)

    assert response.status_code == 201
    assert (response.json()["user"]["first_name"], response.json()["user"]["last_name"]) == (
        None,
        None,
    )
    user = await get_user(db_session)
    assert (user.first_name, user.last_name) == (None, None)


async def test_register_with_both_names_stores_trimmed(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await register(db_client, first_name="  María   José ", last_name=f" {LAST}  ")

    assert response.status_code == 201
    out = response.json()["user"]
    assert (out["first_name"], out["last_name"]) == (FIRST, LAST)
    user = await get_user(db_session)
    assert (user.first_name, user.last_name) == (FIRST, LAST)


@pytest.mark.parametrize(
    "names",
    [{"first_name": FIRST}, {"last_name": LAST}, {"first_name": FIRST, "last_name": None}],
    ids=["first_only", "last_only", "last_null"],
)
async def test_register_with_one_name_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, names: dict[str, Any]
) -> None:
    response = await register(db_client, **names)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    assert await db_session.scalar(select(User.id).where(User.email == EMAIL)) is None


async def test_register_with_an_invalid_name_422(db_client: httpx.AsyncClient) -> None:
    response = await register(db_client, first_name="Ana2", last_name=LAST)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR


# PATCH /v1/auth/me


async def test_patch_me_sets_names_and_returns_user(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    headers = await signed_in(db_client)

    both = await patch_me(db_client, headers, {"first_name": " María  José", "last_name": LAST})
    only_last = await patch_me(db_client, headers, {"last_name": "Pérez"})

    assert both.status_code == only_last.status_code == 200
    assert (both.json()["first_name"], both.json()["last_name"]) == (FIRST, LAST)
    # Once both are stored, one may change alone; the response is the whole UserOut.
    body = only_last.json()
    assert (body["email"], body["first_name"], body["last_name"]) == (EMAIL, FIRST, "Pérez")
    user = await get_user(db_session)
    await db_session.refresh(user)
    assert (user.first_name, user.last_name) == (FIRST, "Pérez")
    me = await db_client.get("/v1/auth/me", headers=headers)
    assert (me.json()["first_name"], me.json()["last_name"]) == (FIRST, "Pérez")


@pytest.mark.parametrize(
    "body",
    [
        {"first_name": FIRST, "last_name": LAST, "email": "other@example.com"},
        {"first_name": FIRST, "last_name": LAST, "role": "admin"},
        {"phone": "+14075550123"},
        {},
        {"first_name": None, "last_name": LAST},
        {"first_name": "Ana2", "last_name": LAST},
        ["first_name"],
    ],
    ids=["email", "role", "phone_only", "empty", "null_name", "invalid_name", "not_an_object"],
)
async def test_patch_me_forbids_other_fields_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, body: Any
) -> None:
    headers = await signed_in(db_client, first_name="Ana", last_name="Pérez")

    response = await patch_me(db_client, headers, body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    user = await get_user(db_session)
    await db_session.refresh(user)
    assert (user.email, user.role.value, user.first_name, user.last_name) == (
        EMAIL,
        "customer",
        "Ana",
        "Pérez",
    )


@pytest.mark.parametrize("name", ["first_name", "last_name"])
async def test_patch_me_requires_both_when_unset(
    db_client: httpx.AsyncClient, db_session: AsyncSession, name: str
) -> None:
    headers = await signed_in(db_client)

    response = await patch_me(db_client, headers, {name: "Ana"})

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    user = await get_user(db_session)
    await db_session.refresh(user)
    assert (user.first_name, user.last_name) == (None, None)


@pytest.mark.parametrize("header", [None, "Bearer not-a-token"], ids=["missing", "invalid"])
async def test_patch_me_unauthenticated_401(
    db_client: httpx.AsyncClient, header: str | None
) -> None:
    headers = {"Authorization": header} if header else {}

    response = await patch_me(db_client, headers, {"first_name": "Ana", "last_name": "Pérez"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"


# Staff CLI


async def test_staff_cli_accepts_names(db_session: AsyncSession, settings: Settings) -> None:
    terminal = Terminal(environ={"STAFF_PASSWORD": STAFF_PASSWORD})

    code = await staff_cli(
        db_session, settings, terminal, "--email", STAFF_EMAIL, "--role", "agent",
        "--password-env", "STAFF_PASSWORD", "--first-name", "  Ana  María ", "--last-name", LAST,
    )  # fmt: skip

    assert code == 0
    user = await user_by_email(db_session)
    assert user is not None
    assert (user.first_name, user.last_name) == ("Ana María", LAST)
    # The output names the user by id only.
    assert "Ana" not in terminal.text
    assert LAST not in terminal.text


@pytest.mark.parametrize(
    "names",
    [
        ["--first-name", "Ana"],
        ["--last-name", LAST],
        ["--first-name", "Ana2", "--last-name", LAST],
        ["--first-name", "Ana", "--last-name", "x" * 61],
    ],
    ids=["first_only", "last_only", "digit", "61_chars"],
)
async def test_staff_cli_refuses_invalid_names(
    db_session: AsyncSession, settings: Settings, names: list[str]
) -> None:
    terminal = Terminal(environ={"STAFF_PASSWORD": STAFF_PASSWORD})

    code = await staff_cli(
        db_session, settings, terminal, "--email", STAFF_EMAIL, "--role", "agent",
        "--password-env", "STAFF_PASSWORD", *names,
    )  # fmt: skip

    assert code == 1
    assert await user_by_email(db_session) is None
    assert "Ana" not in terminal.text  # the refusal never echoes a name
    assert "x" * 61 not in terminal.text


# Logs


async def test_no_names_in_logs(
    db_client: httpx.AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        headers = await signed_in(db_client, first_name=FIRST, last_name=LAST)
        await patch_me(db_client, headers, {"first_name": "Zoë", "last_name": "Núñez"})
        await patch_me(db_client, headers, {"first_name": "Bad1", "last_name": "Núñez"})
        await register(db_client, email="other@example.com", first_name="Solo")

    assert caplog.records
    # Decoded: the formatter escapes non-ASCII, so "María" would never match the raw line.
    output = "\n".join(str(json.loads(JsonFormatter().format(record))) for record in caplog.records)
    for name in ("María", "José", "O'Neil", "Pérez", "Zoë", "Núñez", "Bad1", "Solo"):
        assert name not in output
