from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status

from app.errors import ErrorResponse
from app.modules.auth.dependencies import (
    CurrentUser,
    get_auth_service,
    limit_login,
    limit_logout,
    limit_refresh,
    limit_register,
)
from app.modules.auth.schemas import (
    AuthResponse,
    LoginRequest,
    RefreshTokenRequest,
    RegisterRequest,
)
from app.modules.auth.service import AuthService
from app.modules.users.schemas import UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


_RATE_LIMITED: dict[int | str, dict[str, Any]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        **_error("rate_limited: too many requests from this client; retry later."),
        "headers": {
            "Retry-After": {
                "description": "Seconds until the current limit window ends.",
                "schema": {"type": "integer"},
            }
        },
    },
}


@router.post(
    "/register",
    dependencies=[Depends(limit_register)],
    status_code=status.HTTP_201_CREATED,
    response_model=AuthResponse,
    summary="Register",
    responses={
        status.HTTP_409_CONFLICT: _error("email_already_registered: the email is taken."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: invalid email, role, locale, or password length."
        ),
        **_RATE_LIMITED,
    },
)
async def register(
    data: RegisterRequest, auth: Annotated[AuthService, Depends(get_auth_service)]
) -> AuthResponse:
    """Creates a customer or pro account and starts a session. Never creates staff accounts."""
    return await auth.register(data)


@router.post(
    "/login",
    dependencies=[Depends(limit_login)],
    response_model=AuthResponse,
    summary="Log in",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_credentials: wrong email or password."),
        status.HTTP_403_FORBIDDEN: _error("account_suspended: the account is suspended."),
        **_RATE_LIMITED,
    },
)
async def login(
    data: LoginRequest, auth: Annotated[AuthService, Depends(get_auth_service)]
) -> AuthResponse:
    """Checks the email and password and starts a new session."""
    return await auth.login(data)


@router.post(
    "/refresh",
    dependencies=[Depends(limit_refresh)],
    response_model=AuthResponse,
    summary="Refresh the session",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error(
            "invalid_refresh_token: unknown, expired, revoked or reused refresh token, or the "
            "account is suspended."
        ),
        **_RATE_LIMITED,
    },
)
async def refresh(
    data: RefreshTokenRequest, auth: Annotated[AuthService, Depends(get_auth_service)]
) -> AuthResponse:
    """Spends the refresh token and returns a new access token and a new refresh token.

    Each refresh token works once. Presenting one that was already rotated is treated as theft:
    the whole session is revoked, including the newest token. Clients must therefore serialize
    refresh calls: of two concurrent calls with the same token, one succeeds and the other one
    ends the session.
    """
    return await auth.refresh(data.refresh_token)


@router.post(
    "/logout",
    dependencies=[Depends(limit_logout)],
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Log out",
    responses={
        status.HTTP_204_NO_CONTENT: {
            "description": "Always, whether the token was valid, unknown, expired or revoked."
        },
        **_RATE_LIMITED,
    },
)
async def logout(
    data: RefreshTokenRequest, auth: Annotated[AuthService, Depends(get_auth_service)]
) -> None:
    """Revokes the session the refresh token belongs to. No bearer token is needed.

    Always 204, so the endpoint cannot be used to test tokens. The access token is not revoked
    on the server: it stops working when it expires (`expires_in`).
    """
    await auth.logout(data.refresh_token)


@router.get(
    "/me",
    response_model=UserOut,
    summary="Current user",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error(
            "invalid_token: missing, invalid or expired access token."
        ),
    },
)
async def me(user: CurrentUser) -> UserOut:
    """The caller's own account."""
    return UserOut.model_validate(user)
