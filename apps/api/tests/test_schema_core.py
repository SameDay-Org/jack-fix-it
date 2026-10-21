"""Schema of users, pro_profiles, categories and addresses (D4.1 part 1, ADR 0007)."""

import uuid

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import BigInteger, Connection, Float, Integer, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import Base, import_models
from app.modules.addresses.models import Address
from app.modules.categories.models import Category
from app.modules.pros.models import ProProfile, ProVerificationStatus
from app.modules.users.models import User, UserRole, UserStatus

import_models()

FAKE_HASH = "not-a-real-hash"


def make_user(email: str = "user@example.com", phone: str | None = None) -> User:
    return User(email=email, phone=phone, password_hash=FAKE_HASH, role=UserRole.CUSTOMER)


def make_category(slug: str = "painting", **overrides: object) -> Category:
    values: dict[str, object] = {"slug": slug, "names": {"en": "Painting", "es": "Pintura"}}
    values.update(overrides)
    return Category(**values)


async def assert_rejected(session: AsyncSession, *rows: object) -> None:
    """The flush of these rows violates a constraint; the session stays usable."""
    savepoint = await session.begin_nested()
    session.add_all(rows)
    with pytest.raises(IntegrityError):
        await session.flush()
    await savepoint.rollback()


async def test_migration_matches_models(db_session: AsyncSession) -> None:
    def diff(connection: Connection) -> list[object]:
        return list(compare_metadata(MigrationContext.configure(connection), Base.metadata))

    connection = await db_session.connection()
    assert await connection.run_sync(diff) == []


async def test_constraint_and_index_names_match_models(db_session: AsyncSession) -> None:
    # Autogenerate ignores CHECK constraints, so compare every name the database has.
    def database_names(connection: Connection) -> set[str]:
        inspector = inspect(connection)
        names: set[str] = set()
        for table in Base.metadata.tables:
            names.add(str(inspector.get_pk_constraint(table)["name"]))
            names.update(str(c["name"]) for c in inspector.get_unique_constraints(table))
            names.update(str(c["name"]) for c in inspector.get_check_constraints(table))
            names.update(str(c["name"]) for c in inspector.get_foreign_keys(table))
            names.update(str(i["name"]) for i in inspector.get_indexes(table))
        return names

    tables = Base.metadata.tables.values()
    model_names = {str(c.name) for table in tables for c in table.constraints}
    model_names |= {str(i.name) for table in tables for i in table.indexes}
    connection = await db_session.connection()
    assert await connection.run_sync(database_names) == model_names


async def test_user_email_must_be_lowercase(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, make_user(email="A@x.com"))


async def test_user_email_unique(db_session: AsyncSession) -> None:
    db_session.add(make_user(email="a@x.com"))
    await db_session.flush()
    await assert_rejected(db_session, make_user(email="a@x.com"))


async def test_user_phone_unique_when_set(db_session: AsyncSession) -> None:
    db_session.add_all([make_user(email="a@x.com"), make_user(email="b@x.com")])
    db_session.add(make_user(email="c@x.com", phone="+15555550100"))
    await db_session.flush()
    await assert_rejected(db_session, make_user(email="d@x.com", phone="+15555550100"))


@pytest.mark.parametrize(("role", "status"), [("superuser", "active"), ("customer", "deleted")])
async def test_user_role_and_status_reject_unknown_values(
    db_session: AsyncSession, role: str, status: str
) -> None:
    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "INSERT INTO users (email, password_hash, role, status) "
                "VALUES ('raw@x.com', 'x', :role, :status)"
            ),
            {"role": role, "status": status},
        )


async def test_enum_checks_accept_every_value(db_session: AsyncSession) -> None:
    # The migration's enum CHECKs are written by hand; every StrEnum member must pass them.
    users = [
        User(email=f"{role}.{status}@x.com", password_hash=FAKE_HASH, role=role, status=status)
        for role in UserRole
        for status in UserStatus
    ]
    db_session.add_all(users)
    await db_session.flush()
    db_session.add_all(
        ProProfile(user_id=user.id, verification_status=verification)
        for user, verification in zip(users, ProVerificationStatus, strict=False)
    )
    await db_session.flush()


async def test_user_defaults(db_session: AsyncSession) -> None:
    user = make_user()
    db_session.add(user)
    await db_session.flush()
    await db_session.refresh(user)

    assert user.locale == "en"
    assert user.status is UserStatus.ACTIVE
    assert isinstance(user.id, uuid.UUID)
    assert user.created_at is not None
    assert user.updated_at is not None


async def test_pro_profile_defaults(db_session: AsyncSession) -> None:
    user = make_user()
    db_session.add(user)
    await db_session.flush()
    profile = ProProfile(user_id=user.id)
    db_session.add(profile)
    await db_session.flush()
    await db_session.refresh(profile)

    assert profile.verification_status is ProVerificationStatus.PENDING
    assert profile.payouts_enabled is False
    assert profile.jobs_count == 0
    assert profile.rating_avg is None


async def test_pro_profile_one_per_user(db_session: AsyncSession) -> None:
    user = make_user()
    db_session.add(user)
    await db_session.flush()
    db_session.add(ProProfile(user_id=user.id))
    await db_session.flush()
    await assert_rejected(db_session, ProProfile(user_id=user.id))


async def test_category_names_require_en_and_es(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, make_category("no-es", names={"en": "Painting"}))

    db_session.add(make_category("en-es", names={"en": "Painting", "es": "Pintura"}))
    db_session.add(
        make_category("en-es-pt", names={"en": "Painting", "es": "Pintura", "pt": "Pintura"})
    )
    await db_session.flush()
    slugs = await db_session.scalars(select(Category.slug).order_by(Category.slug))
    assert list(slugs) == ["en-es", "en-es-pt"]


async def test_category_slug_unique(db_session: AsyncSession) -> None:
    db_session.add(make_category("painting"))
    await db_session.flush()
    await assert_rejected(db_session, make_category("painting"))


async def test_category_reference_price_non_negative(db_session: AsyncSession) -> None:
    await assert_rejected(db_session, make_category("negative", reference_price_cents=-1))

    db_session.add(make_category("zero", reference_price_cents=0))
    db_session.add(make_category("unset", reference_price_cents=None))
    await db_session.flush()


async def test_address_requires_existing_user(db_session: AsyncSession) -> None:
    address = Address(
        user_id=uuid.uuid4(), line1="1 Main St", city="Springfield", state="MA", zip_code="01101"
    )
    await assert_rejected(db_session, address)


def test_money_columns_are_integer_cents() -> None:
    columns = [column for table in Base.metadata.tables.values() for column in table.columns]
    cents = [column for column in columns if column.name.endswith("_cents")]

    assert cents, "expected at least one *_cents column"
    for column in cents:
        assert isinstance(column.type, Integer | BigInteger), f"{column} must be integer cents"
    for column in columns:
        assert not isinstance(column.type, Float), f"{column} must not be Float"
