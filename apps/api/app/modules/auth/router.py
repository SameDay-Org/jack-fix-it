from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from app.errors import ErrorResponse
from app.modules.auth.dependencies import CurrentUser, get_auth_service
from app.modules.auth.schemas import AuthResponse, LoginRequest, RegisterRequest
from app.modules.auth.service import AuthService
from app.modules.users.schemas import UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def _error(description: str) -> dict[str, Any]:
    return {"model": ErrorResponse, "description": description}


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=AuthResponse,
    summary="Register",
    responses={
        status.HTTP_409_CONFLICT: _error("email_already_registered: the email is taken."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: invalid email, role, locale, or password length."
        ),
    },
)
async def register(
    data: RegisterRequest, auth: Annotated[AuthService, Depends(get_auth_service)]
) -> AuthResponse:
    """Creates a customer or pro account and starts a session. Never creates staff accounts."""
    return await auth.register(data)


@router.post(
    "/login",
    response_model=AuthResponse,
    summary="Log in",
    responses={
        status.HTTP_401_UNAUTHORIZED: _error("invalid_credentials: wrong email or password."),
        status.HTTP_403_FORBIDDEN: _error("account_suspended: the account is suspended."),
    },
)
async def login(
    data: LoginRequest, auth: Annotated[AuthService, Depends(get_auth_service)]
) -> AuthResponse:
    """Checks the email and password and starts a new session."""
    return await auth.login(data)


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
