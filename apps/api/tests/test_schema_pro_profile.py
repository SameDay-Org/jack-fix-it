"""Schema of pro_categories, pro_service_areas and pro_profiles.years_of_experience (#36)."""

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.categories.models import Category
from app.modules.pros.models import ProCategory, ProProfile, ProServiceArea
from app.modules.service_areas.models import ServiceArea
from app.modules.users.models import User, UserRole
from tests.test_schema_core import assert_rejected


async def make_pro(session: AsyncSession) -> ProProfile:
    user = User(email=f"pro-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
    session.add(user)
    await session.flush()
    profile = ProProfile(user_id=user.id)
    session.add(profile)
    await session.flush()
    return profile


async def make_category(session: AsyncSession) -> Category:
    category = Category(slug=f"test-{uuid.uuid4().hex[:8]}", names={"en": "Test", "es": "Prueba"})
    session.add(category)
    await session.flush()
    return category


async def make_area(session: AsyncSession) -> ServiceArea:
    # A fixture area only.
    area = ServiceArea(
        region="Test Region", city="Testville", state="ZZ", zip_code=uuid.uuid4().hex[:5]
    )
    session.add(area)
    await session.flush()
    return area


async def test_pro_category_pair_unique(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)
    category = await make_category(db_session)
    db_session.add(ProCategory(pro_id=pro.id, category_id=category.id))
    await db_session.flush()

    await assert_rejected(db_session, ProCategory(pro_id=pro.id, category_id=category.id))


async def test_pro_service_area_pair_unique(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)
    area = await make_area(db_session)
    db_session.add(ProServiceArea(pro_id=pro.id, service_area_id=area.id))
    await db_session.flush()

    await assert_rejected(db_session, ProServiceArea(pro_id=pro.id, service_area_id=area.id))


async def test_the_same_category_for_two_pros_is_fine(db_session: AsyncSession) -> None:
    category = await make_category(db_session)
    for _ in range(2):
        pro = await make_pro(db_session)
        db_session.add(ProCategory(pro_id=pro.id, category_id=category.id))
    await db_session.flush()


async def test_foreign_keys_must_exist(db_session: AsyncSession) -> None:
    pro = await make_pro(db_session)
    category = await make_category(db_session)
    area = await make_area(db_session)

    await assert_rejected(db_session, ProCategory(pro_id=uuid.uuid4(), category_id=category.id))
    await assert_rejected(db_session, ProCategory(pro_id=pro.id, category_id=uuid.uuid4()))
    await assert_rejected(db_session, ProServiceArea(pro_id=uuid.uuid4(), service_area_id=area.id))
    await assert_rejected(db_session, ProServiceArea(pro_id=pro.id, service_area_id=uuid.uuid4()))


@pytest.mark.parametrize("years", [-1, 81])
async def test_years_of_experience_check(db_session: AsyncSession, years: int) -> None:
    user = User(email=f"pro-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
    db_session.add(user)
    await db_session.flush()

    await assert_rejected(db_session, ProProfile(user_id=user.id, years_of_experience=years))


@pytest.mark.parametrize("years", [None, 0, 80])
async def test_years_of_experience_bounds_accepted(
    db_session: AsyncSession, years: int | None
) -> None:
    user = User(email=f"pro-{uuid.uuid4().hex[:8]}@x.com", password_hash="x", role=UserRole.PRO)
    db_session.add(user)
    await db_session.flush()
    db_session.add(ProProfile(user_id=user.id, years_of_experience=years))
    await db_session.flush()
