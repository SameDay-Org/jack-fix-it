"""The ID card's fields on the account (#250 part 1, #290): the public code, the home city and
state, the ID photo and member since, on GET and PATCH /v1/auth/me."""

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import PresignedUpload
from app.modules.pros.models import ProProfile
from app.modules.users import public_codes
from app.modules.users.models import User
from app.modules.users.service import UserService
from app.modules.users.types import UserRole
from app.observability import JsonFormatter
from tests.conftest import make_settings
from tests.test_auth_api import PASSWORD, VALIDATION_ERROR, register

PHOTO_TTL = 123
CODE = re.compile(public_codes.PATTERN)
# Fixture values only.
CITY = "Fort Lauderdale"
STATE = "WY"
INVALID_MEDIA = {"error": {"code": "invalid_media", "message": "The attached media is invalid."}}


@dataclass
class FakeStorage:
    gets: list[tuple[str, int]] = field(default_factory=list)

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:  # pragma: no cover - the account never uploads
        raise AssertionError("the account never uploads")

    def presign_get(self, key: str, expires_in: int) -> str:
        self.gets.append((key, expires_in))
        return f"https://storage.example.invalid/get/{key}?sig=fake"


@pytest.fixture
def settings() -> Settings:
    return make_settings(download_url_ttl_seconds=PHOTO_TTL)


@pytest.fixture
def storage(app: FastAPI) -> FakeStorage:
    # What get_storage hands out, to the auth routes' lazy provider and to /v1/pros/me alike.
    fake = FakeStorage()
    app.state.storage = fake
    return fake


@dataclass(frozen=True)
class Caller:
    id: uuid.UUID
    headers: dict[str, str]

    def upload_key(self, purpose: str = "profile_photo", extension: str = ".jpg") -> str:
        return f"u/{self.id}/{purpose}/{uuid.uuid4().hex}{extension}"


async def sign_up(client: httpx.AsyncClient, role: str = "customer") -> Caller:
    response = await register(client, email=f"{role}-{uuid.uuid4().hex[:8]}@example.com", role=role)
    assert response.status_code == 201, response.text
    body = response.json()
    return Caller(
        id=uuid.UUID(body["user"]["id"]),
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )


async def get_me(client: httpx.AsyncClient, caller: Caller) -> httpx.Response:
    return await client.get("/v1/auth/me", headers=caller.headers)


async def patch_me(client: httpx.AsyncClient, caller: Caller, body: Any) -> httpx.Response:
    return await client.patch("/v1/auth/me", json=body, headers=caller.headers)


async def row(session: AsyncSession, caller: Caller) -> User:
    statement = select(User).where(User.id == caller.id).execution_options(populate_existing=True)
    return (await session.scalars(statement)).one()


async def pro_profile(session: AsyncSession, caller: Caller) -> ProProfile | None:
    statement = (
        select(ProProfile)
        .where(ProProfile.user_id == caller.id)
        .execution_options(populate_existing=True)
    )
    return (await session.scalars(statement)).one_or_none()


def logged(caplog: pytest.LogCaptureFixture) -> str:
    formatter = JsonFormatter()
    return "\n".join(formatter.format(record) for record in caplog.records)


# The public code


async def test_register_assigns_a_crockford_public_code(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await register(db_client, email="card@example.com")

    assert response.status_code == 201
    code = response.json()["user"]["public_code"]
    assert CODE.fullmatch(code)
    user = (await db_session.scalars(select(User).where(User.email == "card@example.com"))).one()
    assert user.public_code == code
    # Many accounts, every code of the alphabet's shape and no two alike.
    users = UserService(db_session)
    accounts = [
        await users.create_user(
            email=f"many-{index}@example.com", password_hash="x", role=UserRole.PRO, locale="en"
        )
        for index in range(200)
    ]
    codes = {account.public_code for account in accounts}
    assert len(codes) == 200
    assert all(CODE.fullmatch(code) for code in codes)


async def test_public_code_collision_retries(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    users = UserService(db_session)
    taken = await users.create_user(
        email="first@example.com", password_hash="x", role=UserRole.CUSTOMER, locale="en"
    )
    draws = iter([taken.public_code, taken.public_code, "ABCD2345"])
    monkeypatch.setattr(public_codes, "generate_public_code", lambda: next(draws))

    with caplog.at_level(logging.WARNING):
        second = await users.create_user(
            email="second@example.com", password_hash="x", role=UserRole.CUSTOMER, locale="en"
        )

    assert second.public_code == "ABCD2345"
    assert second.id != taken.id
    collisions = [r for r in caplog.records if r.message == "public_code_collision"]
    assert [getattr(r, "attempt", None) for r in collisions] == [1, 2]
    assert taken.public_code not in logged(caplog)


async def test_public_code_exhausted_is_a_500_that_names_no_code(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    taken = (await register(db_client, email="taken@example.com")).json()["user"]["public_code"]
    monkeypatch.setattr(public_codes, "generate_public_code", lambda: taken)

    with caplog.at_level(logging.WARNING):
        response = await register(db_client, email="unlucky@example.com")

    assert response.status_code == 500
    assert taken not in response.text
    assert (
        await db_session.scalar(select(User.id).where(User.email == "unlucky@example.com")) is None
    )
    messages = [r.message for r in caplog.records]
    assert messages.count("public_code_collision") == public_codes.MAX_TRIES
    assert "unhandled_error" in messages
    assert taken not in logged(caplog)


def test_generated_codes_use_the_alphabet_only() -> None:
    codes = {public_codes.generate_public_code() for _ in range(2000)}
    assert all(CODE.fullmatch(code) for code in codes)
    assert len(codes) > 1990  # random, not a sequence
    assert set(public_codes.ALPHABET).isdisjoint("ILOU")


# City and state


async def test_me_sets_and_clears_city_and_state(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    ana = await sign_up(db_client)

    before = (await get_me(db_client, ana)).json()
    set_both = await patch_me(db_client, ana, {"home_city": f"  {CITY} ", "home_state": STATE})
    shown = (await get_me(db_client, ana)).json()
    cleared = await patch_me(db_client, ana, {"home_city": None, "home_state": None})

    assert (before["home_city"], before["home_state"]) == (None, None)
    assert set_both.status_code == 200, set_both.text
    assert (set_both.json()["home_city"], set_both.json()["home_state"]) == (CITY, STATE)
    assert (shown["home_city"], shown["home_state"]) == (CITY, STATE)
    assert cleared.status_code == 200
    assert (cleared.json()["home_city"], cleared.json()["home_state"]) == (None, None)
    user = await row(db_session, ana)
    assert (user.home_city, user.home_state) == (None, None)


@pytest.mark.parametrize(
    "state",
    [
        "fl",
        "ZZ",
        "F",
        "FLA",
        "PR",
        "F L",
        "\N{FULLWIDTH LATIN CAPITAL LETTER F}\N{FULLWIDTH LATIN CAPITAL LETTER L}",
        "",
    ],
)
async def test_me_state_must_be_a_us_code(
    db_client: httpx.AsyncClient, db_session: AsyncSession, state: str
) -> None:
    ana = await sign_up(db_client)

    response = await patch_me(db_client, ana, {"home_city": CITY, "home_state": state})

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    user = await row(db_session, ana)
    assert (user.home_city, user.home_state) == (None, None)


@pytest.mark.parametrize(
    "body",
    [
        {"home_city": CITY},
        {"home_state": STATE},
        {"home_city": None, "home_state": STATE},
        {"home_city": CITY, "home_state": None},
        {"home_city": None},
        {"home_city": "", "home_state": STATE},
        {"home_city": "   ", "home_state": STATE},
        {"home_city": "a" * 81, "home_state": STATE},
        {"home_city": "Fort\x00Lauderdale", "home_state": STATE},
        {"home_city": CITY, "home_state": STATE, "member_since": "2020-01-01"},
        {"public_code": "ABCD2345"},
    ],
)
async def test_me_city_without_state_is_422(
    db_client: httpx.AsyncClient, db_session: AsyncSession, body: dict[str, Any]
) -> None:
    ana = await sign_up(db_client)

    response = await patch_me(db_client, ana, body)

    assert response.status_code == 422
    assert response.json() == VALIDATION_ERROR
    user = await row(db_session, ana)
    assert (user.home_city, user.home_state) == (None, None)


async def test_me_keeps_city_and_state_while_other_fields_change(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await sign_up(db_client)
    assert (
        await patch_me(db_client, ana, {"home_city": CITY, "home_state": STATE})
    ).status_code == 200

    names = await patch_me(db_client, ana, {"first_name": "Ana", "last_name": "Pérez"})
    photo = await patch_me(db_client, ana, {"photo_key": ana.upload_key()})

    assert names.status_code == photo.status_code == 200
    user = await row(db_session, ana)
    assert (user.home_city, user.home_state) == (CITY, STATE)
    assert user.first_name == "Ana"
    assert user.photo_key is not None


# The ID photo


async def test_me_sets_own_profile_photo(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await sign_up(db_client)
    key = ana.upload_key(extension=".png")

    patched = await patch_me(db_client, ana, {"photo_key": key})
    shown = await get_me(db_client, ana)
    cleared = await patch_me(db_client, ana, {"photo_key": None})

    assert patched.status_code == 200, patched.text
    assert patched.json()["photo"]["url"] == shown.json()["photo"]["url"]
    assert shown.json()["photo"]["url"] == f"https://storage.example.invalid/get/{key}?sig=fake"
    assert "photo_key" not in shown.json()
    assert cleared.status_code == 200
    assert cleared.json()["photo"] is None
    assert (await row(db_session, ana)).photo_key is None
    assert storage.gets == [(key, PHOTO_TTL), (key, PHOTO_TTL)]


async def test_me_refuses_another_users_photo_key(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana, bruno = await sign_up(db_client), await sign_up(db_client, "pro")
    anas_key = ana.upload_key()
    assert (await patch_me(db_client, ana, {"photo_key": anas_key})).status_code == 200

    response = await patch_me(db_client, bruno, {"photo_key": anas_key})
    with_city = await patch_me(
        db_client, bruno, {"home_city": CITY, "home_state": STATE, "photo_key": anas_key}
    )

    assert response.status_code == with_city.status_code == 422
    assert response.json() == with_city.json() == INVALID_MEDIA
    bruno_row = await row(db_session, bruno)
    assert (bruno_row.photo_key, bruno_row.home_city, bruno_row.home_state) == (None, None, None)
    assert await pro_profile(db_session, bruno) is None
    assert (await row(db_session, ana)).photo_key == anas_key


@pytest.mark.parametrize(
    "key",
    [
        "request_media",
        "job_photo",
        "pro_document",
        "pdf",
        "malformed",
        "traversal",
        "overlong",
        "empty",
    ],
)
async def test_me_refuses_another_purpose_key(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage, key: str
) -> None:
    ana = await sign_up(db_client)
    keys = {
        "request_media": ana.upload_key("request_media"),
        "job_photo": ana.upload_key("job_photo"),
        "pro_document": ana.upload_key("pro_document"),
        "pdf": ana.upload_key(extension=".pdf"),
        "malformed": ana.upload_key()[:-4],
        "traversal": "../" + ana.upload_key(),
        "overlong": ana.upload_key() + "0" * 600,
        "empty": "",
    }

    response = await patch_me(db_client, ana, {"photo_key": keys[key]})

    assert response.status_code == 422
    assert response.json()["error"]["code"] in {"invalid_media", "validation_error"}
    assert (await row(db_session, ana)).photo_key is None
    assert storage.gets == []


async def test_pro_selfie_fills_an_empty_pro_photo_only(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # A pro who never opened their profile: the selfie creates it and becomes its photo.
    newcomer = await sign_up(db_client, "pro")
    selfie = newcomer.upload_key()
    assert (await patch_me(db_client, newcomer, {"photo_key": selfie})).status_code == 200
    profile = await pro_profile(db_session, newcomer)
    assert profile is not None
    assert profile.photo_key == selfie
    # A newer ID photo, or clearing it, leaves the public photo alone.
    assert (
        await patch_me(db_client, newcomer, {"photo_key": newcomer.upload_key()})
    ).status_code == 200
    assert (await patch_me(db_client, newcomer, {"photo_key": None})).status_code == 200
    assert (await pro_profile(db_session, newcomer)).photo_key == selfie  # type: ignore[union-attr]
    public = await db_client.get("/v1/pros/me", headers=newcomer.headers)
    assert public.status_code == 200
    assert public.json()["photo"]["url"].endswith(f"{selfie}?sig=fake")

    # A pro who chose a public photo keeps it.
    veteran = await sign_up(db_client, "pro")
    chosen = veteran.upload_key()
    picked = await db_client.patch(
        "/v1/pros/me", json={"photo_key": chosen}, headers=veteran.headers
    )
    assert picked.status_code == 200, picked.text
    assert (
        await patch_me(db_client, veteran, {"photo_key": veteran.upload_key()})
    ).status_code == 200
    assert (await pro_profile(db_session, veteran)).photo_key == chosen  # type: ignore[union-attr]

    # A customer's selfie touches no pro profile.
    customer = await sign_up(db_client)
    assert (
        await patch_me(db_client, customer, {"photo_key": customer.upload_key()})
    ).status_code == 200
    assert await pro_profile(db_session, customer) is None


# GET /me


async def test_me_returns_signed_photo_and_member_since(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana = await sign_up(db_client)
    user = await row(db_session, ana)

    bare = (await get_me(db_client, ana)).json()
    key = ana.upload_key()
    before = datetime.now(UTC)
    assert (await patch_me(db_client, ana, {"photo_key": key})).status_code == 200
    me = (await get_me(db_client, ana)).json()
    after = datetime.now(UTC)

    assert bare["member_since"] == user.created_at.astimezone(UTC).date().isoformat()
    assert bare["photo"] is None
    assert me["member_since"] == bare["member_since"]
    assert me["photo"]["url"] == f"https://storage.example.invalid/get/{key}?sig=fake"
    expires_at = datetime.fromisoformat(me["photo"]["expires_at"])
    ttl = timedelta(seconds=PHOTO_TTL)
    assert before + ttl <= expires_at <= after + ttl
    assert storage.gets == [(key, PHOTO_TTL), (key, PHOTO_TTL)]
    assert set(me) == {
        "id",
        "email",
        "role",
        "locale",
        "status",
        "phone",
        "phone_verified",
        "first_name",
        "last_name",
        "public_code",
        "home_city",
        "home_state",
        "photo",
        "member_since",
    }


async def test_login_and_phone_verify_show_the_card_fields(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    # Every UserOut comes from the same presenter: the sign-in response carries the photo too.
    response = await register(db_client, email="login@example.com")
    ana = Caller(
        id=uuid.UUID(response.json()["user"]["id"]),
        headers={"Authorization": f"Bearer {response.json()['access_token']}"},
    )
    key = ana.upload_key()
    assert (await patch_me(db_client, ana, {"photo_key": key})).status_code == 200

    login = await db_client.post(
        "/v1/auth/login", json={"email": "login@example.com", "password": PASSWORD}
    )

    assert login.status_code == 200, login.text
    assert login.json()["user"]["photo"]["url"].endswith(f"{key}?sig=fake")
    assert login.json()["user"]["public_code"] == response.json()["user"]["public_code"]


# Access and logs


async def test_user_a_cannot_set_user_b_fields(
    db_client: httpx.AsyncClient, db_session: AsyncSession, storage: FakeStorage
) -> None:
    ana, bruno = await sign_up(db_client), await sign_up(db_client)

    own = await patch_me(
        db_client, ana, {"home_city": CITY, "home_state": STATE, "photo_key": ana.upload_key()}
    )
    with_brunos_key = await patch_me(db_client, ana, {"photo_key": bruno.upload_key()})
    anas_view = (await get_me(db_client, ana)).json()
    brunos_view = (await get_me(db_client, bruno)).json()

    assert own.status_code == 200
    assert with_brunos_key.status_code == 422
    bruno_row = await row(db_session, bruno)
    assert (bruno_row.home_city, bruno_row.home_state, bruno_row.photo_key) == (None, None, None)
    assert (brunos_view["home_city"], brunos_view["photo"]) == (None, None)
    assert anas_view["public_code"] != brunos_view["public_code"]
    assert anas_view["id"] != brunos_view["id"]


async def test_logs_carry_ids_only(
    db_client: httpx.AsyncClient,
    db_session: AsyncSession,
    storage: FakeStorage,
    caplog: pytest.LogCaptureFixture,
) -> None:
    ana = await sign_up(db_client)
    key = ana.upload_key()

    with caplog.at_level(logging.DEBUG):
        await patch_me(db_client, ana, {"home_city": CITY, "home_state": STATE, "photo_key": key})
        await patch_me(db_client, ana, {"photo_key": "u/someone/else.jpg"})
        me = (await get_me(db_client, ana)).json()

    output = logged(caplog)
    for secret in (CITY, STATE, key, me["public_code"], "sig=fake", "someone"):
        assert secret not in output
    [updated] = [r for r in caplog.records if r.message == "user_updated"]
    assert getattr(updated, "user_id", None) == str(ana.id)
    assert getattr(updated, "fields", None) == ["home_city", "home_state", "photo_key"]
