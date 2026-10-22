"""Pros: the only way other modules reach a pro profile (ADR 0003), and the pro's own profile
(D6.1, #36): what they do (categories) and where (service areas).

A pro only ever reads or edits their own profile: the caller is the key, there is no id. The
profile is created empty (pending) on the first read. An edit validates everything before it
writes, then changes only the fields sent, in one transaction. Logs carry ids and field names:
never the bio or a storage key.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.categories.service import CategoryService
from app.modules.pros.errors import (
    InvalidCategoryError,
    InvalidMediaError,
    InvalidProfileError,
    InvalidServiceAreaError,
)
from app.modules.pros.models import ProProfile
from app.modules.pros.repository import ProProfileRepository
from app.modules.pros.schemas import PhotoOut, ProProfileOut, ProProfileUpdate
from app.modules.service_areas.service import ServiceAreaService
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.service import owned_upload
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


class ProService:
    def __init__(self, session: AsyncSession) -> None:
        self._profiles = ProProfileRepository(session)

    async def get_profile_id_for_user(self, user_id: uuid.UUID) -> uuid.UUID | None:
        """The pro_profiles.id of a user, or None when the user has no pro profile."""
        return await self._profiles.get_id_by_user_id(user_id)


@dataclass(frozen=True)
class ProProfileConfig:
    max_categories: int
    max_service_areas: int
    photo_url_ttl_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "ProProfileConfig":
        return cls(
            max_categories=settings.pro_max_categories,
            max_service_areas=settings.pro_max_service_areas,
            photo_url_ttl_seconds=settings.download_url_ttl_seconds,
        )


class ProProfileService:
    def __init__(
        self,
        session: AsyncSession,
        categories: CategoryService,
        service_areas: ServiceAreaService,
        storage: Storage,
        config: ProProfileConfig,
    ) -> None:
        self._session = session
        self._profiles = ProProfileRepository(session)
        self._categories = categories
        self._service_areas = service_areas
        self._storage = storage
        self._config = config

    async def get_own(self, user: UserAccount) -> ProProfileOut:
        """The caller's profile, created empty (pending) on the first call."""
        return await self._out(await self._ensure(user, lock=False))

    async def update_own(self, user: UserAccount, data: ProProfileUpdate) -> ProProfileOut:
        fields = data.model_fields_set
        if (
            "photo_key" in fields
            and data.photo_key is not None
            and owned_upload(data.photo_key, user.id, UploadPurpose.PROFILE_PHOTO) is None
        ):
            raise InvalidMediaError
        if "category_ids" in fields:
            categories = self._unique_within(data.category_ids, self._config.max_categories)
            if await self._categories.active_ids(categories) != categories:
                raise InvalidCategoryError
        if "service_area_ids" in fields:
            areas = self._unique_within(data.service_area_ids, self._config.max_service_areas)
            if await self._service_areas.active_ids(areas) != areas:
                raise InvalidServiceAreaError

        profile = await self._ensure(user, lock=True)
        if "bio" in fields:
            profile.bio = data.bio or None  # an empty string clears it
        if "years_of_experience" in fields:
            profile.years_of_experience = data.years_of_experience
        if "photo_key" in fields:
            profile.photo_key = data.photo_key
        if "category_ids" in fields:
            await self._profiles.replace_categories(profile.id, data.category_ids)
        if "service_area_ids" in fields:
            await self._profiles.replace_service_areas(profile.id, data.service_area_ids)
        await self._session.commit()
        logger.info(
            "pro_profile_updated", extra={"user_id": str(user.id), "fields": sorted(fields)}
        )
        return await self._out(profile)

    async def _ensure(self, user: UserAccount, *, lock: bool) -> ProProfile:
        """The caller's profile, created first if missing; `lock` holds it for an edit."""
        if await self._profiles.insert_if_missing(user.id):
            await self._session.commit()
            logger.info("pro_profile_created", extra={"user_id": str(user.id)})
        profile = await self._profiles.get_by_user_id(user.id, lock=lock)
        if profile is None:  # pragma: no cover - the row was just ensured and is never deleted
            raise RuntimeError("pro profile missing after insert")
        return profile

    @staticmethod
    def _unique_within(ids: list[uuid.UUID], limit: int) -> set[uuid.UUID]:
        requested = set(ids)
        if len(requested) != len(ids) or len(ids) > limit:
            raise InvalidProfileError
        return requested

    async def _out(self, profile: ProProfile) -> ProProfileOut:
        photo = None
        if profile.photo_key is not None:
            ttl = self._config.photo_url_ttl_seconds
            photo = PhotoOut(
                url=self._storage.presign_get(profile.photo_key, ttl),
                expires_at=datetime.now(UTC) + timedelta(seconds=ttl),
            )
        return ProProfileOut(
            bio=profile.bio,
            years_of_experience=profile.years_of_experience,
            photo=photo,
            verification_status=profile.verification_status,
            payouts_enabled=profile.payouts_enabled,
            categories=await self._categories.summaries(
                await self._profiles.category_ids(profile.id)
            ),
            service_areas=await self._service_areas.get_many(
                await self._profiles.service_area_ids(profile.id)
            ),
        )
