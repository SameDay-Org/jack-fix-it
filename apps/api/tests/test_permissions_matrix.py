"""Role dependencies and ensure_owner, through a test-only router (#124). Never mounted in app/."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

import httpx
import pytest
from fastapi import APIRouter, Depends, FastAPI
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth import security
from app.modules.auth.dependencies import CurrentUser
from app.modules.auth.permissions import (
    AdminUser,
    AppUser,
    CustomerUser,
    PanelUser,
    ProUser,
    ensure_owner,
    require_roles,
)
from app.modules.users.models import User
from app.modules.users.types import UserAccount, UserRole, UserStatus
from tests.conftest import TEST_JWT_SECRET

PREFIX = "/test-permissions"
FORBIDDEN = {"error": {"code": "forbidden", "message": "You do not have access to this resource."}}
NOT_FOUND = {"error": {"code": "not_found", "message": "Resource not found."}}
INVALID_TOKEN = {
    "error": {
        "code": "invalid_token",
        "message": "The access token is missing, invalid or expired.",
    }
}


class Caller(BaseModel):
    id: uuid.UUID


router = APIRouter(prefix=PREFIX)


@router.get("/current")
async def current(user: CurrentUser) -> Caller:
    return Caller(id=user.id)


@router.get("/app")
async def app_users(user: AppUser) -> Caller:
    return Caller(id=user.id)


@router.get("/panel")
async def panel(user: PanelUser) -> Caller:
    return Caller(id=user.id)


@router.get("/customer")
async def customer(user: CustomerUser) -> Caller:
    return Caller(id=user.id)


@router.get("/pro")
async def pro(user: ProUser) -> Caller:
    return Caller(id=user.id)


@router.get("/admin")
async def admin(user: AdminUser) -> Caller:
    return Caller(id=user.id)


@router.get("/agent-only")
async def agent_only(
    user: Annotated[UserAccount, Depends(require_roles(UserRole.AGENT))],
) -> Caller:
    return Caller(id=user.id)


@router.get("/pro-or-admin")
async def pro_or_admin(
    user: Annotated[UserAccount, Depends(require_roles(UserRole.PRO, UserRole.ADMIN))],
) -> Caller:
    return Caller(id=user.id)


@router.get("/owned/{owner_id}")
async def owned(owner_id: uuid.UUID, user: CurrentUser) -> Caller:
    ensure_owner(owner_id, user)
    return Caller(id=owner_id)


# Written out, not derived from the code under test. 200 = allowed, 403 = wrong role.
C, P, AG, AD = UserRole.CUSTOMER, UserRole.PRO, UserRole.AGENT, UserRole.ADMIN
EXPECTED: dict[str, dict[UserRole, int]] = {
    "current": {C: 200, P: 200, AG: 200, AD: 200},
    "app": {C: 200, P: 200, AG: 403, AD: 403},
    "panel": {C: 403, P: 403, AG: 200, AD: 200},
    "customer": {C: 200, P: 403, AG: 403, AD: 403},
    "pro": {C: 403, P: 200, AG: 403, AD: 403},
    "admin": {C: 403, P: 403, AG: 403, AD: 200},
    "agent-only": {C: 403, P: 403, AG: 200, AD: 403},
    "pro-or-admin": {C: 403, P: 200, AG: 403, AD: 200},
}
MATRIX = [(endpoint, role) for endpoint in EXPECTED for role in UserRole]


@pytest.fixture(autouse=True)
def mount_test_router(app: FastAPI) -> None:
    app.include_router(router)


async def make_user(
    session: AsyncSession, role: UserRole, status: UserStatus = UserStatus.ACTIVE
) -> tuple[uuid.UUID, dict[str, str]]:
    user = User(
        email=f"{role.value}-{uuid.uuid4().hex[:8]}@x.com",
        password_hash="x",
        role=role,
        status=status,
    )
    session.add(user)
    await session.flush()
    token = security.create_access_token(
        user_id=user.id, role=role, secret=TEST_JWT_SECRET, ttl_seconds=900, now=datetime.now(UTC)
    )
    return user.id, {"Authorization": f"Bearer {token}"}


def test_every_role_is_in_the_matrix() -> None:
    assert all(set(row) == set(UserRole) for row in EXPECTED.values())


@pytest.mark.parametrize(("endpoint", "role"), MATRIX, ids=[f"{e}-{r}" for e, r in MATRIX])
async def test_role_matrix(
    db_client: httpx.AsyncClient, db_session: AsyncSession, endpoint: str, role: UserRole
) -> None:
    user_id, headers = await make_user(db_session, role)

    response = await db_client.get(f"{PREFIX}/{endpoint}", headers=headers)

    assert response.status_code == EXPECTED[endpoint][role]
    if response.status_code == 200:
        assert response.json() == {"id": str(user_id)}
    else:
        assert response.json() == FORBIDDEN
        assert "WWW-Authenticate" not in response.headers


@pytest.mark.parametrize("endpoint", [*EXPECTED, f"owned/{uuid.uuid4()}"])
async def test_no_token_is_401(db_client: httpx.AsyncClient, endpoint: str) -> None:
    for headers in ({}, {"Authorization": "Bearer not-a-jwt"}, {"Authorization": "Basic x"}):
        response = await db_client.get(f"{PREFIX}/{endpoint}", headers=headers)
        assert response.status_code == 401
        assert response.json() == INVALID_TOKEN
        assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("role", list(UserRole))
async def test_suspended_user_is_401(
    db_client: httpx.AsyncClient, db_session: AsyncSession, role: UserRole
) -> None:
    user_id, headers = await make_user(db_session, role, UserStatus.SUSPENDED)

    for endpoint in [*EXPECTED, f"owned/{user_id}"]:
        response = await db_client.get(f"{PREFIX}/{endpoint}", headers=headers)
        assert response.status_code == 401, endpoint
        assert response.json() == INVALID_TOKEN


async def test_owner_gets_resource_other_user_gets_404(
    db_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    a_id, a_headers = await make_user(db_session, UserRole.CUSTOMER)
    b_id, b_headers = await make_user(db_session, UserRole.CUSTOMER)
    _, admin_headers = await make_user(db_session, UserRole.ADMIN)

    own = await db_client.get(f"{PREFIX}/owned/{a_id}", headers=a_headers)
    others = await db_client.get(f"{PREFIX}/owned/{b_id}", headers=a_headers)
    unknown = await db_client.get(f"{PREFIX}/owned/{uuid.uuid4()}", headers=a_headers)
    # Staff access is a per-feature rule, never ensure_owner's.
    staff = await db_client.get(f"{PREFIX}/owned/{a_id}", headers=admin_headers)

    assert own.status_code == 200
    assert own.json() == {"id": str(a_id)}
    for response in (others, unknown, staff):
        assert response.status_code == 404
        assert response.json() == NOT_FOUND
    # Another user's resource and a missing one read the same: nothing reveals B exists.
    assert others.text == unknown.text
    assert str(b_id) not in others.text
    assert (await db_client.get(f"{PREFIX}/owned/{b_id}", headers=b_headers)).status_code == 200


def test_require_roles_needs_a_role() -> None:
    with pytest.raises(ValueError, match="at least one role"):
        require_roles()
