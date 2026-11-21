"""The app-launch interest list (#409): visitors of the showcase page who want to hear when the
app is in the stores. An email only, one row per email.

- Only the web app's server calls it (app.web_service: its key), limited per visitor address and
  per email (a keyed hash) at the route.
- Idempotent: a repeat answers what the first join answered (202, no body), from one statement
  either way, so nobody learns whether an email is on the list. The first consent stands.
- The consent: the version of the words the visitor saw, and when (the database's clock).
- Nothing is sent from here; a staff export is later.

Logs carry flags only (new or not, the source, the language): never the email.
"""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.interest.repository import InterestRepository
from app.modules.interest.schemas import InterestJoin

logger = logging.getLogger(__name__)


class InterestService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._interest = InterestRepository(session)

    async def join(self, data: InterestJoin) -> None:
        """Puts the email on the list unless it is there, and commits (see the module doc)."""
        new = await self._interest.add_if_new(
            data.email, data.locale, data.source, data.consent_version
        )
        await self._session.commit()
        logger.info(
            "interest_joined",
            extra={"new": new, "source": data.source.value, "locale": data.locale},
        )
