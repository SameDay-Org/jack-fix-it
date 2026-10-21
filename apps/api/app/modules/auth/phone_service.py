"""Phone verification by SMS code (D4.3, #26): a signed-in user proves they own a number.

- send: checks the number's country code and answers 202. A number another account has
  verified gets the same 202 but no SMS. Twilio is called only after the response is sent
  (deliver_code, a background task), so neither the answer, its timing, nor a Twilio error can
  tell whether a number is taken. Twilio failures on send are logged, not returned.
- verify: asks Twilio whether the code is right first. Only then is the number stored, so a
  "number taken" 409 can only reach someone who just proved they control that phone.

Logs carry the user id only: never the number or the code.
"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations import sms_verify
from app.integrations.sms_verify import PhoneVerifier
from app.modules.auth.errors import (
    InvalidCodeError,
    InvalidPhoneNumberError,
    VerificationUnavailableError,
)
from app.modules.users.errors import PhoneUnavailableError
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


class PhoneVerificationService:
    def __init__(
        self,
        session: AsyncSession,
        users: UserService,
        verifier: PhoneVerifier,
        allowed_country_codes: list[str],
    ) -> None:
        self._session = session
        self._users = users
        self._verifier = verifier
        self._allowed_country_codes = tuple(allowed_country_codes)

    async def prepare_send(self, user: UserAccount, phone: str) -> bool:
        """Validates the request; True when a code should be delivered (deliver_code)."""
        self._check_country(phone)
        if await self._users.phone_verified_by_other(phone, user.id):
            logger.info("phone_send_skipped", extra={"user_id": str(user.id)})
            return False
        return True

    async def deliver_code(self, user_id: uuid.UUID, phone: str) -> None:
        """Asks Twilio to text the code. Runs after the response, so it never raises."""
        extra = {"user_id": str(user_id)}
        try:
            await self._verifier.start(phone)
        except sms_verify.InvalidPhoneError:
            logger.info("phone_code_not_sent", extra={**extra, "reason": "invalid_number"})
            return
        except sms_verify.VerificationThrottledError:
            logger.info("phone_code_not_sent", extra={**extra, "reason": "throttled"})
            return
        except sms_verify.VerificationUnavailableError:
            logger.error("phone_verification_unavailable", extra=extra)
            return
        logger.info("phone_code_sent", extra=extra)

    async def verify_code(self, user: UserAccount, phone: str, code: str) -> UserAccount:
        """Stores the number as the user's verified phone and commits. Idempotent."""
        self._check_country(phone)
        try:
            approved = await self._verifier.check(phone, code)
        except sms_verify.InvalidPhoneError:
            approved = False
        except sms_verify.VerificationUnavailableError:
            logger.error("phone_verification_unavailable", extra={"user_id": str(user.id)})
            raise VerificationUnavailableError from None
        if not approved:
            logger.info("phone_code_rejected", extra={"user_id": str(user.id)})
            raise InvalidCodeError
        try:
            account = await self._users.set_verified_phone(user.id, phone, datetime.now(UTC))
        except PhoneUnavailableError:
            logger.info("phone_verify_conflict", extra={"user_id": str(user.id)})
            raise
        await self._session.commit()
        logger.info("phone_verified", extra={"user_id": str(user.id)})
        return account

    def _check_country(self, phone: str) -> None:
        if not phone.startswith(self._allowed_country_codes):
            raise InvalidPhoneNumberError
