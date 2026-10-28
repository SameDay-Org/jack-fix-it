"""Pros: the only way other modules reach a pro profile (ADR 0003), and the pro's own profile
(D6.1, #36): what they do (categories) and where (service areas).

A pro only ever reads or edits their own profile: the caller is the key, there is no id. The
profile is created empty (pending) on the first read. An edit validates everything before it
writes, then changes only the fields sent, in one transaction. Logs carry ids and field names:
never the bio or a storage key.
"""

import logging
import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.categories.schemas import CategorySummary
from app.modules.categories.service import CategoryService
from app.modules.pros.errors import (
    InvalidCategoryError,
    InvalidMediaError,
    InvalidProfileError,
    InvalidServiceAreaError,
)
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.pros.repository import ProDocumentRepository, ProProfileRepository
from app.modules.pros.schemas import PhotoOut, ProProfileOut, ProProfileUpdate
from app.modules.service_areas.service import ServiceAreaService
from app.modules.uploads.schemas import UploadPurpose
from app.modules.uploads.service import owned_upload
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DispatchCandidate:
    pro_id: uuid.UUID
    user_id: uuid.UUID
    rating_avg: Decimal | None  # NULL until the first review


@dataclass(frozen=True)
class ProCard:
    """What a customer may see of a pro next to their quote (#188): no contact, documents,
    photo or Stripe account. `user_id` is for the caller's own lookups (masking the pro's
    contact details), never for a response."""

    pro_id: uuid.UUID
    user_id: uuid.UUID
    # "María P." (users.names.safe_public_name); None when a name is missing or shows a contact
    name: str | None
    rating_avg: Decimal | None  # NULL until the first review
    jobs_count: int
    years_of_experience: int | None
    verified: bool  # verification approved


@dataclass(frozen=True)
class ProPublicDetails:
    """The profile a customer may see of a pro who quoted them (#53): the card, plus the bio as
    the pro wrote it (the caller masks its contacts), when the profile was created and its
    active categories. No photo, documents, service areas or Stripe account."""

    card: ProCard
    bio: str | None
    created_at: datetime
    categories: list[CategorySummary]  # active ones only, by slug


class ProService:
    def __init__(self, session: AsyncSession) -> None:
        self._profiles = ProProfileRepository(session)
        self._users = UserService(session)
        self._categories = CategoryService(session)

    @staticmethod
    def photo_keys_among(keys: Collection[str]) -> Select[str | None]:
        """The upload keys among `keys` that a profile holds as its photo, as a statement (the
        uploads sweep of unreferenced uploads, #191)."""
        return ProProfileRepository.photo_keys_among(keys)

    @staticmethod
    def document_keys_among(keys: Collection[str]) -> Select[str]:
        """The upload keys among `keys` that a verification document holds, superseded ones
        too, as a statement (the uploads sweep of unreferenced uploads, #191)."""
        return ProDocumentRepository.file_keys_among(keys)

    async def get_profile_id_for_user(self, user_id: uuid.UUID) -> uuid.UUID | None:
        """The pro_profiles.id of a user, or None when the user has no pro profile."""
        return await self._profiles.get_id_by_user_id(user_id)

    async def hireable_cards(self, pro_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, ProCard]:
        """The public card of each pro among `pro_ids` who can still be hired, by profile id:
        approved with payouts enabled, like the pros who receive requests (#189). A pro left
        out cannot be paid out, so their quote is neither listed nor newly accepted. Two
        queries (the profiles, then their names), whatever the count."""
        return await self._cards(pro_ids, hireable_only=True)

    async def cards(self, pro_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, ProCard]:
        """The public card of each pro among `pro_ids`, by profile id, whether or not they can
        still be hired: the repeat of a completed acceptance (#189). `verified` is the pro's
        current verification. Two queries, whatever the count."""
        return await self._cards(pro_ids, hireable_only=False)

    async def hireable_details(self, pro_id: uuid.UUID) -> ProPublicDetails | None:
        """The public profile of a pro who can still be hired, by profile id; None for any
        other, with the same rule as `hireable_cards` (#53). Four queries (the card's two, the
        bio with the category ids, then the categories), whatever the pro has; three when they
        list no category."""
        card = (await self.hireable_cards({pro_id})).get(pro_id)
        details = await self._profiles.public_details(pro_id) if card else None
        if card is None or details is None:
            return None
        bio, created_at, category_ids = details
        return ProPublicDetails(
            card=card,
            bio=bio,
            created_at=created_at,
            categories=await self._categories.active_summaries(category_ids),
        )

    async def _cards(
        self, pro_ids: Collection[uuid.UUID], *, hireable_only: bool
    ) -> dict[uuid.UUID, ProCard]:
        rows = await self._profiles.public_fields(pro_ids, hireable_only=hireable_only)
        names = await self._users.public_names([row[1] for row in rows])
        return {
            pro_id: ProCard(
                pro_id=pro_id,
                user_id=user_id,
                name=names.get(user_id),
                rating_avg=rating_avg,
                jobs_count=jobs_count,
                years_of_experience=years,
                verified=status is ProVerificationStatus.APPROVED,
            )
            for pro_id, user_id, rating_avg, jobs_count, years, status in rows
        }

    async def dispatch_candidates(
        self, category_id: uuid.UUID, service_area_ids: Collection[uuid.UUID]
    ) -> list[DispatchCandidate]:
        """Profiles that may receive requests (approved, payouts enabled: context doc section
        5) in the category and in one of the areas. The caller still checks the accounts."""
        return [
            DispatchCandidate(pro_id=row.id, user_id=row.user_id, rating_avg=row.rating_avg)
            for row in await self._profiles.dispatch_candidates(category_id, service_area_ids)
        ]


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
        created, profile = await self._ensure(user, lock=False)
        if created:
            # A read that creates: the new profile is persisted on its own.
            await self._session.commit()
            logger.info("pro_profile_created", extra={"user_id": str(user.id)})
        return await self._out(profile)

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

        # One transaction from here: the profile's creation (when absent), the row lock and
        # every edit commit together, or none of them does.
        created, profile = await self._ensure(user, lock=True)
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
        if created:
            logger.info("pro_profile_created", extra={"user_id": str(user.id)})
        logger.info(
            "pro_profile_updated", extra={"user_id": str(user.id), "fields": sorted(fields)}
        )
        return await self._out(profile)

    async def _ensure(self, user: UserAccount, *, lock: bool) -> tuple[bool, ProProfile]:
        """(created, profile): the caller's profile, inserted first if missing, in the current
        transaction; the caller commits. `lock` holds the row for an edit.

        INSERT ... ON CONFLICT DO NOTHING keeps two first calls race-safe: the second waits for
        the first's transaction, then finds its row (or inserts, if the first rolled back).
        """
        created = await self._profiles.insert_if_missing(user.id)
        profile = await self._profiles.get_by_user_id(user.id, lock=lock)
        if profile is None:  # pragma: no cover - the row was just ensured in this transaction
            raise RuntimeError("pro profile missing after insert")
        return created, profile

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
