"""Who may call a route: every /v1 route makes exactly one auth decision (D4.4, #124).

- Public: listed in PUBLIC_ROUTES, with the reason. tests/test_route_permissions.py fails on any
  /v1 route that is neither listed nor depends on get_current_user.
- Any signed-in user: `CurrentUser` (auth.dependencies).
- By role: `AppUser`, `PanelUser`, `CustomerUser`, `ProUser`, `AdminUser`, or
  `Depends(require_roles(...))` for another combination. A wrong role is 403: the role is the
  caller's own, not a secret.
- By owner: resources addressed by id call `ensure_owner`, which answers 404 to anyone else,
  so another user's resource is never revealed. Whether staff may see others' resources is a
  per-feature rule, never this helper's.
"""

import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated, Final

from fastapi import Depends

from app.errors import ForbiddenError, NotFoundError
from app.modules.auth.dependencies import CurrentUser
from app.modules.users.types import UserAccount, UserRole

# (method, path) of the /v1 routes that need no access token.
PUBLIC_ROUTES: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        # Creating an account or starting a session cannot require one; both are rate-limited.
        ("POST", "/v1/auth/register"),
        ("POST", "/v1/auth/login"),
        # The refresh token in the body is the credential: the access token may have expired.
        ("POST", "/v1/auth/refresh"),
        ("POST", "/v1/auth/logout"),
        # Forgotten password: the caller has no session by definition; the emailed code is the
        # credential, and both routes are rate-limited per IP and per email.
        ("POST", "/v1/auth/password/forgot"),
        ("POST", "/v1/auth/password/reset"),
        # The catalog: the landing page and the request flow show categories and served areas
        # before anyone signs in. Read-only, active rows only, rate-limited per IP.
        ("GET", "/v1/categories"),
        ("GET", "/v1/service-areas"),
        # Served or not: the request flow and the landing page ask before login (#46).
        ("GET", "/v1/service-areas/check"),
        # Out of the served area, a web visitor joins the waitlist without an account; a valid
        # bearer, if sent, links the entry to the user. Rate-limited per IP and per contact.
        ("POST", "/v1/waitlist"),
    }
)


def require_roles(*roles: UserRole) -> Callable[[UserAccount], Awaitable[UserAccount]]:
    """A dependency giving the current user when their role is one of `roles`, else 403."""
    if not roles:
        raise ValueError("require_roles needs at least one role")
    allowed = frozenset(roles)

    async def dependency(user: CurrentUser) -> UserAccount:
        if user.role not in allowed:
            raise ForbiddenError
        return user

    return dependency


# The mobile app's users, and the admin/BDC panel's ("agent e admin só acessam o painel").
AppUser = Annotated[UserAccount, Depends(require_roles(UserRole.CUSTOMER, UserRole.PRO))]
PanelUser = Annotated[UserAccount, Depends(require_roles(UserRole.AGENT, UserRole.ADMIN))]
CustomerUser = Annotated[UserAccount, Depends(require_roles(UserRole.CUSTOMER))]
ProUser = Annotated[UserAccount, Depends(require_roles(UserRole.PRO))]
AdminUser = Annotated[UserAccount, Depends(require_roles(UserRole.ADMIN))]


def ensure_owner(owner_id: uuid.UUID, user: UserAccount) -> None:
    """The default for resources addressed by id: 404 unless the caller owns it."""
    if owner_id != user.id:
        raise NotFoundError
