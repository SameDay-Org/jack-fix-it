"""Phone verification by SMS code (D4.3, #26): a signed-in user proves they own a number.

- send: checks the number's country code, then asks Twilio Verify to send a code. A number
  another account has verified gets the same answer, but nothing is sent, so the endpoint
  cannot tell whether a number is taken.
- verify: asks Twilio whether the code is right first. Only then is the number stored, so a
  "number taken" 409 can only reach someone who just proved they control that phone.

Logs carry the user id only: never the number or the code.
"""

import logging
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

    async def send_code(self, user: UserAccount, phone: str) -> None:
        self._check_country(phone)
        if await self._users.phone_verified_by_other(phone, user.id):
            logger.info("phone_send_skipped", extra={"user_id": str(user.id)})
            return
        try:
            await self._verifier.start(phone)
        except sms_verify.InvalidPhoneError:
            raise InvalidPhoneNumberError from None
        except sms_verify.VerificationUnavailableError:
            logger.error("phone_verification_unavailable", extra={"user_id": str(user.id)})
            raise VerificationUnavailableError from None
        logger.info("phone_code_sent", extra={"user_id": str(user.id)})

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
