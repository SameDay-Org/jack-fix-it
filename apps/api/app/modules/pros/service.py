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

from sqlalchemy import Select, Subquery
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.integrations.storage import Storage
from app.modules.categories.schemas import CategorySummary
from app.modules.categories.service import CategoryService
from app.modules.dispatch.kicks import RedispatchKick
from app.modules.pros.errors import (
    InvalidCategoryError,
    InvalidMediaError,
    InvalidProfileError,
    InvalidServiceAreaError,
)
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.pros.repository import ProDocumentRepository, ProProfileRepository
from app.modules.pros.schemas import ProProfileOut, ProProfileUpdate
from app.modules.service_areas.service import ServiceAreaService
from app.modules.uploads.keys import owned_upload
from app.modules.uploads.schemas import PhotoOut, UploadPurpose
from app.modules.users.service import UserService
from app.modules.users.types import UserAccount, UserRole

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DispatchCandidate:
    pro_id: uuid.UUID
    user_id: uuid.UUID
    rating_avg: Decimal | None  # NULL until the first review


@dataclass(frozen=True)
class AssignCandidate:
    """A pro as staff weigh them for one request (#82): what dispatch asks of a profile, each
    answer on its own, so a refusal can say which one failed."""

    pro_id: uuid.UUID
    user_id: uuid.UUID
    approved: bool
    payouts_enabled: bool
    in_category: bool
    in_area: bool


@dataclass(frozen=True)
class ProCoverage:
    """What a pro that receives requests covers: its categories and service areas (#478)."""

    category_ids: tuple[uuid.UUID, ...]
    service_area_ids: tuple[uuid.UUID, ...]


@dataclass(frozen=True)
class ProCard:
    """What a customer may see of a pro next to their quote (#188): no contact, documents,
    photo or Stripe account. `user_id` is for the caller's own lookups (masking the pro's
    contact details), never for a response."""

    pro_id: uuid.UUID
    user_id: uuid.UUID
    # "María P." (users.names.safe_public_name); None when a name is missing or shows a contact
    name: str | None
    years_of_experience: int | None
    verified: bool  # verification approved


@dataclass(frozen=True)
class VisiblePro:
    """An approved pro with an active account, as any signed-in user may see them (#78): the
    bio as written (the caller masks its contacts), when the profile was created and its
    active categories. `user_id` is for the caller's lookups (the rating, the contacts to
    mask), never for a response. No photo (#53), documents, areas, payouts or Stripe."""

    pro_id: uuid.UUID
    user_id: uuid.UUID
    name: str | None
    bio: str | None
    years_of_experience: int | None
    created_at: datetime
    categories: list[CategorySummary]


@dataclass(frozen=True)
class ProPublicDetails:
    """The profile a customer may see of a pro who quoted them (#53): the card, plus the bio as
    the pro wrote it (the caller masks its contacts), when the profile was created and its
    active categories. No photo, documents, service areas or Stripe account."""

    card: ProCard
    bio: str | None
    created_at: datetime
    categories: list[CategorySummary]  # active ones only, by slug


@dataclass(frozen=True)
class PayoutAccount:
    """A pro's payout side (#39): the profile, its Stripe Express account (None until the first
    onboarding link), when that account's create was attempted (None before the first attempt),
    whether payouts are enabled, as last read from Stripe, and whether staff approve the pro
    now (#41): Stripe can keep payouts enabled for a pro staff rejected."""

    profile_id: uuid.UUID
    stripe_account_id: str | None
    stripe_account_requested_at: datetime | None
    payouts_enabled: bool
    approved: bool


@dataclass(frozen=True)
class ConnectedPro:
    """The pro whose profile holds a Stripe Express account (#280): its payout side, who
    hears about it (the user) and whether they may receive requests once payouts are
    enabled (approved)."""

    account: PayoutAccount
    user_id: uuid.UUID
    approved: bool


def _payout_account(profile: ProProfile) -> PayoutAccount:
    return PayoutAccount(
        profile_id=profile.id,
        stripe_account_id=profile.stripe_account_id,
        stripe_account_requested_at=profile.stripe_account_requested_at,
        payouts_enabled=profile.payouts_enabled,
        approved=profile.verification_status is ProVerificationStatus.APPROVED,
    )


class ProService:
    def __init__(self, session: AsyncSession) -> None:
        self._profiles = ProProfileRepository(session)
        self._users = UserService(session)
        self._categories = CategoryService(session)

    @staticmethod
    def users() -> Subquery:
        """Each profile's id (`pro_id`) and user id (`user_id`), as a subquery: a job's
        parties resolve in the job's own query (#331)."""
        return ProProfileRepository.users()

    @staticmethod
    def payable() -> Subquery:
        """The id (`pro_id`) of every profile a transfer can be made to now (approved by
        staff, a Stripe account with payouts enabled), as a subquery: the transfer sweep (#68)
        joins it."""
        return ProProfileRepository.payable()

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

    async def adopt_photo_if_missing(self, user_id: uuid.UUID, key: str) -> bool:
        """Makes the pro's ID photo (#250; `key` is their own profile_photo upload, checked
        by the caller) their public profile photo while they have none, so the selfie shows
        until they pick another; a photo already set is untouched. The empty profile is
        created first when missing, as the first GET /pros/me does. True when the photo was
        set; the caller owns the commit."""
        if await self._profiles.insert_if_missing(user_id):
            logger.info("pro_profile_created", extra={"user_id": str(user_id)})
        adopted = await self._profiles.set_photo_if_missing(user_id, key)
        if adopted:
            logger.info("pro_profile_photo_adopted", extra={"user_id": str(user_id)})
        return adopted

    async def user_id_of(self, pro_id: uuid.UUID) -> uuid.UUID | None:
        """The user behind a profile, for a push to the pro (#65); None when there is none."""
        profile = await self._profiles.get_by_id(pro_id)
        return None if profile is None else profile.user_id

    async def get_profile_id_for_user(self, user_id: uuid.UUID) -> uuid.UUID | None:
        """The pro_profiles.id of a user, or None when the user has no pro profile."""
        return await self._profiles.get_id_by_user_id(user_id)

    async def lock_payout_account(self, user_id: uuid.UUID) -> tuple[bool, PayoutAccount]:
        """(created, account): the user's payout account (#39), its profile row locked FOR
        UPDATE until the transaction ends and inserted first when missing, empty and pending,
        as GET /pros/me does. The caller commits."""
        created = await self._profiles.insert_if_missing(user_id)
        profile = await self._profiles.get_by_user_id(user_id, lock=True)
        if profile is None:  # pragma: no cover - the row was just ensured in this transaction
            raise RuntimeError("pro profile missing after insert")
        return created, _payout_account(profile)

    async def payout_account(
        self, user_id: uuid.UUID, *, lock: bool = False
    ) -> PayoutAccount | None:
        """The user's payout account (#39), or None when they have no profile yet. `lock`: its
        profile row FOR UPDATE until the caller's transaction ends."""
        profile = await self._profiles.get_by_user_id(user_id, lock=lock)
        return None if profile is None else _payout_account(profile)

    async def payout_account_of_profile(self, pro_id: uuid.UUID) -> PayoutAccount | None:
        """The profile's payout account as last committed, unlocked: where a job's transfer
        goes (#68). None when no profile has this id."""
        profile = await self._profiles.get_by_id(pro_id)
        return None if profile is None else _payout_account(profile)

    async def lock_payout_account_by_profile(self, pro_id: uuid.UUID) -> PayoutAccount | None:
        """The profile's payout account, its row FOR UPDATE until the caller's transaction
        ends; None when no profile has this id (staff recovery, #39)."""
        profile = await self._profiles.get_by_id(pro_id, lock=True)
        return None if profile is None else _payout_account(profile)

    async def lock_connected_pro(self, stripe_account_id: str) -> ConnectedPro | None:
        """The pro holding this Stripe Express account, its profile row FOR UPDATE until the
        caller's transaction ends (the lock the payouts status takes, #39); None when no
        profile holds it (#280)."""
        profile = await self._profiles.get_by_stripe_account_id(stripe_account_id, lock=True)
        if profile is None:
            return None
        return ConnectedPro(
            account=_payout_account(profile),
            user_id=profile.user_id,
            approved=profile.verification_status is ProVerificationStatus.APPROVED,
        )

    async def mark_stripe_account_requested(self, pro_id: uuid.UUID) -> None:
        """Stamps the profile's account-create attempt now; the caller holds the row lock and
        commits before the create call."""
        await self._profiles.set_stripe_account_requested_now(pro_id)

    async def clear_stripe_account_requested(self, pro_id: uuid.UUID) -> None:
        """Forgets the profile's account-create attempt, so the next onboarding link creates
        again; the caller holds the row lock and commits."""
        await self._profiles.clear_stripe_account_requested(pro_id)

    async def set_stripe_account(self, pro_id: uuid.UUID, account_id: str) -> None:
        """Stores the profile's Express account id; the caller holds the row lock and commits."""
        await self._profiles.set_stripe_account_id(pro_id, account_id)

    async def set_payouts_enabled(self, pro_id: uuid.UUID, enabled: bool) -> bool:
        """Stores what Stripe says of the account's payouts; True when the value changed (only
        then is the row written). The caller commits."""
        return await self._profiles.set_payouts_enabled(pro_id, enabled)

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

    async def details_of(self, card: ProCard) -> ProPublicDetails | None:
        """The public profile behind a card the caller took from `hireable_cards` (#53): the
        caller resolves who may be shown first, so the reads here happen only for a shown pro.
        Two queries (the bio with the category ids, then the categories), whatever the pro
        has; one when they list no category. None when the profile is gone."""
        details = await self._profiles.public_details(card.pro_id)
        if details is None:  # pragma: no cover - the card was read from this profile just now
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
                years_of_experience=years,
                verified=status is ProVerificationStatus.APPROVED,
            )
            for pro_id, user_id, years, status in rows
        }

    async def visible_user_id(self, pro_id: uuid.UUID) -> uuid.UUID | None:
        """The account behind a profile visible_profile would show; None in the same cases,
        through the same single statement (#78)."""
        found = await self._profiles.visible_profile(
            pro_id, UserService.active_ids_of_role(UserRole.PRO)
        )
        return None if found is None else found[0]

    async def visible_profile(self, pro_id: uuid.UUID) -> VisiblePro | None:
        """The public profile any signed-in user may read (#78): only for an approved pro
        whose account is active with the pro role. None for every other case (no profile,
        pending, rejected, suspended, no longer a pro), decided by one statement, so the
        answers cannot tell them apart. Then one query for the name and one for the
        categories."""
        found = await self._profiles.visible_profile(
            pro_id, UserService.active_ids_of_role(UserRole.PRO)
        )
        if found is None:
            return None
        user_id, bio, years, created_at, category_ids = found
        names = await self._users.public_names([user_id])
        return VisiblePro(
            pro_id=pro_id,
            user_id=user_id,
            name=names.get(user_id),
            bio=bio,
            years_of_experience=years,
            created_at=created_at,
            categories=await self._categories.active_summaries(category_ids),
        )

    async def request_coverage(self, pro_id: uuid.UUID) -> ProCoverage | None:
        """The profile's categories and service areas when it receives requests (approved,
        payouts enabled: context doc section 5), for the re-dispatch after it may have become
        eligible (#478); None otherwise."""
        if not await self._profiles.receives_requests(pro_id):
            return None
        return ProCoverage(
            tuple(await self._profiles.category_ids(pro_id)),
            tuple(await self._profiles.service_area_ids(pro_id)),
        )

    async def assign_candidates(
        self, category_id: uuid.UUID, service_area_ids: Collection[uuid.UUID]
    ) -> list[AssignCandidate]:
        """The approved profiles in the category and in one of the areas, payouts enabled or
        not (#82): the pros staff may weigh for a request. The caller still checks the
        accounts."""
        return [
            AssignCandidate(
                pro_id=row.id,
                user_id=row.user_id,
                approved=True,
                payouts_enabled=row.payouts_enabled,
                in_category=True,
                in_area=True,
            )
            for row in await self._profiles.approved_in(category_id, service_area_ids)
        ]

    async def assign_candidate(
        self,
        pro_id: uuid.UUID,
        category_id: uuid.UUID,
        service_area_ids: Collection[uuid.UUID],
        *,
        lock: bool = False,
    ) -> AssignCandidate | None:
        """One profile against a request's category and areas (#82): each condition of
        receiving it, answered apart. None when no profile has this id. The caller still
        checks the account. `lock` (#511): read FOR SHARE, held until the caller's
        transaction ends (the profile, then its category and area rows): a revocation
        committed first is read, one made after waits for the caller's commit."""
        found = await self._profiles.with_coverage(pro_id, category_id, service_area_ids, lock=lock)
        if found is None:
            return None
        profile, in_category, in_area = found
        return AssignCandidate(
            pro_id=profile.id,
            user_id=profile.user_id,
            approved=profile.verification_status is ProVerificationStatus.APPROVED,
            payouts_enabled=profile.payouts_enabled,
            in_category=in_category,
            in_area=in_area,
        )

    async def categories_of(
        self, pro_ids: Collection[uuid.UUID]
    ) -> dict[uuid.UUID, list[CategorySummary]]:
        """Each of these profiles' active categories, by slug; a profile with none is left
        out. Two queries, whatever the count."""
        listed = await self._profiles.category_ids_of(pro_ids)
        wanted = {category_id for ids in listed.values() for category_id in ids}
        summaries = {item.id: item for item in await self._categories.active_summaries(wanted)}
        return {
            pro_id: sorted(
                (summaries[category_id] for category_id in ids if category_id in summaries),
                key=lambda summary: summary.slug,
            )
            for pro_id, ids in listed.items()
        }

    async def dispatch_candidates(
        self, category_id: uuid.UUID, service_area_ids: Collection[uuid.UUID]
    ) -> list[DispatchCandidate]:
        """Profiles that may receive requests (approved, payouts enabled: context doc section
        5) in the category and in one of the areas. The caller still checks the accounts."""
        return [
            # The rating is the reviews module's to compute (#78): dispatch sets it.
            DispatchCandidate(pro_id=row.id, user_id=row.user_id, rating_avg=None)
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
        kick: RedispatchKick,
    ) -> None:
        self._session = session
        self._profiles = ProProfileRepository(session)
        self._categories = categories
        self._service_areas = service_areas
        self._storage = storage
        self._config = config
        self._kick = kick

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
        if fields & {"category_ids", "service_area_ids"}:
            # Committed: requests no pro could take may be this pro's now (#478).
            await self._kick.after_commit(profile.id, "coverage_changed")
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
            rejection_reason=profile.rejection_reason,
            payouts_enabled=profile.payouts_enabled,
            categories=await self._categories.summaries(
                await self._profiles.category_ids(profile.id)
            ),
            service_areas=await self._service_areas.get_many(
                await self._profiles.service_area_ids(profile.id)
            ),
        )
