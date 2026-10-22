"""Schema of service_areas (D6.1, #36, ADR 0007)."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.service_areas.models import ServiceArea
from tests.test_schema_core import assert_rejected


def area(zip_code: str, *, active: bool = True) -> ServiceArea:
    return ServiceArea(
        region="Test Region", city="Testville", state="ZZ", zip_code=zip_code, active=active
    )


async def test_zip_code_unique(db_session: AsyncSession) -> None:
    db_session.add(area("00001"))
    await db_session.flush()

    await assert_rejected(db_session, area("00001", active=False))


async def test_active_defaults_to_true(db_session: AsyncSession) -> None:
    row = ServiceArea(region="Test Region", city="Testville", state="ZZ", zip_code="00002")
    db_session.add(row)
    await db_session.flush()
    await db_session.refresh(row)

    assert row.active is True
