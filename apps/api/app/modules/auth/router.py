from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, Response, status

from app.errors import ErrorResponse
from app.modules.auth.dependencies import (
    CurrentUser,
    get_auth_service,
    get_password_reset_service,
    get_phone_service,
    limit_login,
    limit_logout,
    limit_password_forgot,
    limit_password_reset,
    limit_phone_send,
    limit_phone_verify,
    limit_refresh,
    limit_register,
)
from app.modules.auth.password_reset import PasswordResetService
from app.modules.auth.phone_service import PhoneVerificationService
from app.modules.auth.schemas import (
    AuthResponse,
    LoginRequest,
    PasswordForgotRequest,
    PasswordResetRequest,
    PhoneSendRequest,
    PhoneVerifyRequest,
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


_UNAUTHORIZED = _error("invalid_token: missing, invalid or expired access token.")
_PHONE_INVALID = _error(
    "validation_error: not an E.164 number, a country code that is not allowed, or a "
    "malformed code."
)
_PHONE_UNAVAILABLE = _error("verification_unavailable: the SMS provider is unavailable.")


@router.post(
    "/phone/send",
    status_code=status.HTTP_202_ACCEPTED,
    response_class=Response,
    summary="Send a phone verification code",
    dependencies=[Depends(limit_phone_send)],
    responses={
        status.HTTP_202_ACCEPTED: {"description": "Accepted; a code is on its way by SMS."},
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: not an E.164 number, or a country code that is not allowed."
        ),
        **_RATE_LIMITED,
    },
)
async def send_phone_code(
    data: PhoneSendRequest,
    user: CurrentUser,
    phones: Annotated[PhoneVerificationService, Depends(get_phone_service)],
    background: BackgroundTasks,
) -> None:
    """Sends a verification code by SMS to the number, for the signed-in user.

    Always 202 for a valid number, including one already verified by another account (then
    nothing is sent). The SMS provider is called after the response, so neither the answer,
    its timing nor a provider error tells whether a number is taken; a code that never
    arrives surfaces at verify as invalid_code.
    """
    if await phones.prepare_send(user, data.phone):
        background.add_task(phones.deliver_code, user.id, data.phone)


@router.post(
    "/phone/verify",
    response_model=UserOut,
    summary="Verify the phone with the code",
    dependencies=[Depends(limit_phone_verify)],
    responses={
        status.HTTP_400_BAD_REQUEST: _error("invalid_code: wrong, expired or used code."),
        status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
        status.HTTP_409_CONFLICT: _error("phone_unavailable: the number is another account's."),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _PHONE_INVALID,
        status.HTTP_503_SERVICE_UNAVAILABLE: _PHONE_UNAVAILABLE,
        **_RATE_LIMITED,
    },
)
async def verify_phone(
    data: PhoneVerifyRequest,
    user: CurrentUser,
    phones: Annotated[PhoneVerificationService, Depends(get_phone_service)],
) -> UserOut:
    """Checks the code and stores the number as the user's verified phone (idempotent)."""
    return UserOut.model_validate(await phones.verify_code(user, data.phone, data.code))


@router.post(
    "/password/forgot",
    status_code=status.HTTP_202_ACCEPTED,
    response_class=Response,
    summary="Ask for a password reset code",
    dependencies=[Depends(limit_password_forgot)],
    responses={
        status.HTTP_202_ACCEPTED: {
            "description": "Always, whether or not an account has this email."
        },
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error("validation_error: not an email address."),
        **_RATE_LIMITED,
    },
)
async def forgot_password(
    data: PasswordForgotRequest,
    resets: Annotated[PasswordResetService, Depends(get_password_reset_service)],
    background: BackgroundTasks,
) -> None:
    """Emails a 6-digit reset code to the account with this email, if it exists and is active.

    Always 202 with no body. The account lookup and the email happen after the response, so
    neither the answer nor its timing tells whether the email has an account. A new request
    replaces the previous code; a code that never arrives surfaces at reset as invalid_code.
    """
    background.add_task(resets.send_code, data.email)


@router.post(
    "/password/reset",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Reset the password with the code",
    dependencies=[Depends(limit_password_reset)],
    responses={
        status.HTTP_204_NO_CONTENT: {"description": "The password changed; all sessions ended."},
        status.HTTP_400_BAD_REQUEST: _error(
            "invalid_code: no code, expired, wrong, already used or out of tries, or no "
            "active account with this email."
        ),
        status.HTTP_422_UNPROCESSABLE_CONTENT: _error(
            "validation_error: invalid email, a code that is not 6 digits, or password length."
        ),
        **_RATE_LIMITED,
    },
)
async def reset_password(
    data: PasswordResetRequest,
    resets: Annotated[PasswordResetService, Depends(get_password_reset_service)],
) -> None:
    """Sets a new password with the emailed code. No bearer token is needed.

    The code works once. A success revokes every refresh token of the account, so every
    session must log in again; access tokens already issued stop working when they expire.
    """
    await resets.reset(data.email, data.code, data.new_password)
