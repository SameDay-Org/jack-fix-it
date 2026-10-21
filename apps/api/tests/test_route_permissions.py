"""Every /v1 route makes an auth decision: public (PUBLIC_ROUTES) or authenticated (#124)."""

from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute, iter_route_contexts

from app.main import create_app
from app.modules.auth.dependencies import CurrentUser, get_current_user
from app.modules.auth.permissions import PUBLIC_ROUTES, AdminUser, require_roles
from app.modules.users.types import UserAccount, UserRole
from tests.conftest import make_settings

V1_PREFIX = "/v1"


def depends_on(dependant: Dependant, target: Callable[..., object]) -> bool:
    """`target` anywhere in the dependency tree: directly, through require_roles or an alias."""
    return any(sub.call is target or depends_on(sub, target) for sub in dependant.dependencies)


def v1_routes(app: FastAPI) -> dict[tuple[str, str], bool]:
    """(method, path) of every /v1 route -> whether it requires an access token.

    Walks the effective routes, so router and include_router dependencies count too.
    """
    routes: dict[tuple[str, str], bool] = {}
    for context in iter_route_contexts(app.routes):
        if not isinstance(context.original_route, APIRoute) or context.path is None:
            continue
        if not context.path.startswith(f"{V1_PREFIX}/"):
            continue
        authenticated = depends_on(context.dependant, get_current_user)
        for method in context.methods or ():
            routes[(method, context.path)] = authenticated
    return routes


def unprotected_routes(app: FastAPI) -> list[str]:
    return sorted(
        f"{method} {path}"
        for (method, path), authenticated in v1_routes(app).items()
        if not authenticated and (method, path) not in PUBLIC_ROUTES
    )


def test_every_v1_route_is_public_or_authenticated() -> None:
    app = create_app(make_settings())

    missing = unprotected_routes(app)

    assert missing == [], (
        "These /v1 routes make no auth decision. Use CurrentUser, a role alias or "
        f"require_roles(...), or add them to PUBLIC_ROUTES with a reason: {missing}"
    )
    assert v1_routes(app), "no /v1 route found: the guard would pass vacuously"


def test_public_routes_list_matches_reality() -> None:
    routes = v1_routes(create_app(make_settings()))

    stale = sorted(f"{m} {p}" for m, p in PUBLIC_ROUTES if (m, p) not in routes)
    assert stale == [], f"PUBLIC_ROUTES lists routes that do not exist: {stale}"
    # A listed route that requires a token anyway is a wrong entry, not a public route.
    authenticated = sorted(f"{m} {p}" for m, p in PUBLIC_ROUTES if routes.get((m, p)))
    assert authenticated == [], f"PUBLIC_ROUTES lists authenticated routes: {authenticated}"


def test_guard_detects_an_unprotected_route() -> None:
    app = create_app(make_settings())
    router = APIRouter(prefix=f"{V1_PREFIX}/test-guard")

    @router.get("/unprotected")
    async def unprotected() -> None: ...

    @router.post("/signed-in")
    async def signed_in(user: CurrentUser) -> None: ...

    @router.get("/admin")
    async def admin(user: AdminUser) -> None: ...

    @router.get("/roles")
    async def roles(
        user: Annotated[UserAccount, Depends(require_roles(UserRole.PRO, UserRole.AGENT))],
    ) -> None: ...

    app.include_router(router)
    # A whole router protected when it is included also counts.
    protected_router = APIRouter()

    @protected_router.delete("/item")
    async def item() -> None: ...

    app.include_router(
        protected_router,
        prefix=f"{V1_PREFIX}/test-guard-included",
        dependencies=[Depends(get_current_user)],
    )

    assert unprotected_routes(app) == ["GET /v1/test-guard/unprotected"]
