"""The Live Activity tokens (#596, PR 2a; Cesar 2026-11-23): the push token of the activity a
customer's iPhone runs for an ongoing job, which the live view's APNs updates (PR 2b) go to.

- Who sends one: the job's customer, for a job under way (the live view's stages), from one
  of their own registered devices, named by its Expo push token. Anyone else's job, or an
  unknown one, is 404; a job not under way, 409 job_not_live; a push token that is no device of
  theirs, 404 device_not_found.
- One per job and device: an activity that gets a new token replaces the old one.
- Where it goes: the device's delete takes it (a phone signed out, Expo's DeviceNotRegistered,
  an account deleted). A phone can move to another account: whoever sends updates reads only
  the tokens of devices still the job's customer's.
- Logs carry the job's and the device's ids, never a token.
"""

import logging
import uuid
from typing import Final

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import violated_constraint
from app.errors import NotFoundError
from app.modules.devices.service import DeviceService
from app.modules.jobs.errors import JobNotLiveError, LiveDeviceNotFoundError
from app.modules.jobs.live import live_stage
from app.modules.jobs.models import LiveActivityToken
from app.modules.jobs.repository import JobRepository
from app.modules.jobs.schemas import LiveActivityTokenIn
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)

# The device's foreign key: a device deleted while its token was being kept.
_DEVICE_GONE: Final = "fk_live_activity_tokens_device_id_devices"


class LiveActivityTokenService:
    def __init__(self, session: AsyncSession, devices: DeviceService) -> None:
        self._session = session
        self._devices = devices
        self._jobs = JobRepository(session)

    async def keep(self, user: UserAccount, job_id: uuid.UUID, data: LiveActivityTokenIn) -> None:
        """Keeps the activity's token for the job and the caller's device, and commits."""
        job = await self._jobs.get(job_id)
        if job is None or job.customer_id != user.id:
            raise NotFoundError
        if live_stage(job) is None:
            raise JobNotLiveError
        device_id = await self._devices.own_device_id(user.id, data.expo_push_token)
        if device_id is None:
            raise LiveDeviceNotFoundError
        statement = insert(LiveActivityToken).values(
            job_id=job_id, device_id=device_id, token=data.live_activity_token
        )
        statement = statement.on_conflict_do_update(
            index_elements=[LiveActivityToken.job_id, LiveActivityToken.device_id],
            set_={"token": statement.excluded.token, "updated_at": func.now()},
        )
        try:
            await self._session.execute(statement)
            await self._session.commit()
        except IntegrityError as error:
            await self._session.rollback()
            if violated_constraint(error) == _DEVICE_GONE:
                raise LiveDeviceNotFoundError from None
            raise
        logger.info(
            "live_activity_token_kept", extra={"job_id": str(job_id), "device_id": str(device_id)}
        )
