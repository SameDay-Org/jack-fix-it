"""Phone verification by SMS code through Twilio Verify (D4.3, #26; ADR 0004).

Twilio generates, sends, expires and checks the codes: the API never sees a code it did not
receive from the user, and never stores one. Calls go to the Verify REST API with httpx
(async, basic auth, timeout from settings); the Twilio SDK would pull in a synchronous client.

Nothing here logs a phone number, a code, or a Twilio response body (bodies echo the number).
"""

import logging
from typing import Final, Protocol

import httpx
from starlette.requests import Request

from app.config import Settings

logger = logging.getLogger(__name__)

VERIFY_BASE_URL: Final = "https://verify.twilio.com/v2"
APPROVED: Final = "approved"


class InvalidPhoneError(Exception):
    """Twilio rejected the number itself (malformed, unreachable by SMS, unsupported)."""


class VerificationUnavailableError(Exception):
    """Twilio could not be reached or did not behave as expected."""


class VerificationThrottledError(Exception):
    """Twilio refused to send another code to this number for now (max send attempts)."""


# Twilio error codes (https://www.twilio.com/docs/api/errors) that are about the number itself.
INVALID_NUMBER_CODES: Final = frozenset(
    {
        60200,  # Invalid parameter: the To number
        60205,  # SMS is not supported by landline phone numbers
        21211,  # Invalid 'To' phone number
        21614,  # 'To' number is not a valid mobile number
    }
)
MAX_SEND_ATTEMPTS: Final = 60203
MAX_CHECK_ATTEMPTS: Final = 60202
VERIFICATION_NOT_FOUND: Final = 20404


class PhoneVerifier(Protocol):
    async def start(self, phone: str) -> None:
        """Sends a code to the phone by SMS."""
        ...

    async def check(self, phone: str, code: str) -> bool:
        """True only when the code is the one sent to the phone and still valid."""
        ...


class TwilioPhoneVerifier:
    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        service_sid: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._auth = httpx.BasicAuth(account_sid, auth_token)
        self._service_url = f"{VERIFY_BASE_URL}/Services/{service_sid}"
        self._timeout = timeout_seconds
        self._transport = transport

    @classmethod
    def from_settings(cls, settings: Settings) -> "TwilioPhoneVerifier":
        if (
            settings.twilio_account_sid is None
            or settings.twilio_auth_token is None
            or settings.twilio_verify_service_sid is None
        ):
            raise RuntimeError("TWILIO_* settings are not set; phone verification is unavailable")
        return cls(
            account_sid=settings.twilio_account_sid,
            auth_token=settings.twilio_auth_token.get_secret_value(),
            service_sid=settings.twilio_verify_service_sid,
            timeout_seconds=settings.twilio_timeout_seconds,
        )

    async def start(self, phone: str) -> None:
        response = await self._post("Verifications", {"To": phone, "Channel": "sms"}, "start")
        error = _error_code(response)
        if response.status_code == 400 and error in INVALID_NUMBER_CODES:
            raise InvalidPhoneError
        if response.status_code == 429 and error == MAX_SEND_ATTEMPTS:
            raise VerificationThrottledError
        self._expect_success(response, "start")

    async def check(self, phone: str, code: str) -> bool:
        response = await self._post("VerificationCheck", {"To": phone, "Code": code}, "check")
        error = _error_code(response)
        # No pending verification (expired, already used or never sent), or too many wrong
        # codes so Twilio closed it: both mean a bad code, not an outage.
        if (response.status_code, error) in (
            (404, VERIFICATION_NOT_FOUND),
            (429, MAX_CHECK_ATTEMPTS),
        ):
            return False
        if response.status_code == 400 and error in INVALID_NUMBER_CODES:
            raise InvalidPhoneError
        self._expect_success(response, "check")
        try:
            status = response.json().get("status")
        except (ValueError, AttributeError):
            logger.error("twilio_verify_unexpected_response", extra={"operation": "check"})
            raise VerificationUnavailableError from None
        return bool(status == APPROVED)

    async def _post(self, path: str, data: dict[str, str], operation: str) -> httpx.Response:
        try:
            async with httpx.AsyncClient(
                auth=self._auth, timeout=self._timeout, transport=self._transport
            ) as client:
                return await client.post(f"{self._service_url}/{path}", data=data)
        except httpx.HTTPError as error:
            # The exception text may carry the URL and request; log only its type.
            logger.error(
                "twilio_verify_unreachable",
                extra={"operation": operation, "error": type(error).__name__},
            )
            raise VerificationUnavailableError from None

    @staticmethod
    def _expect_success(response: httpx.Response, operation: str) -> None:
        if response.is_success:
            return
        logger.error(
            "twilio_verify_failed",
            extra={
                "operation": operation,
                "status_code": response.status_code,
                "twilio_code": _error_code(response),
            },
        )
        raise VerificationUnavailableError


def _error_code(response: httpx.Response) -> int | None:
    """Twilio's numeric error code from an error body; never the body's message, which can
    echo the number."""
    if response.is_success:
        return None
    try:
        code = response.json().get("code")
    except (ValueError, AttributeError):
        return None
    return code if isinstance(code, int) else None


def get_phone_verifier(request: Request) -> PhoneVerifier:
    """FastAPI dependency: one verifier per app, built on first use (tests override this).

    Missing settings raise: a generic, logged 500, never a crash at import or startup.
    """
    verifier: PhoneVerifier | None = getattr(request.app.state, "phone_verifier", None)
    if verifier is None:
        verifier = TwilioPhoneVerifier.from_settings(request.app.state.settings)
        request.app.state.phone_verifier = verifier
    return verifier
