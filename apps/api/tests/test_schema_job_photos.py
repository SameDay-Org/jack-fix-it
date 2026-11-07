"""Schema of the job photos (#298): the table, its constraints and the migration round trip."""

import importlib.util
import uuid
from pathlib import Path
from types import ModuleType

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.jobs.models import JobPhoto, JobPhotoKind, JobStatus
from app.modules.media.safe_status import MediaSafeStatus
from tests.job_world import build_world, make_job

MIGRATION = (
    Path(__file__).parents[1] / "alembic" / "versions" / "20261106_1f4aa780a8d2_job_photos.py"
)
TABLE = "job_photos"


def migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location("job_photos", MIGRATION)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def has_table(connection: Connection) -> bool:
    return inspect(connection).has_table(TABLE)


async def test_defaults_and_indexes(db_session: AsyncSession) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    photo = JobPhoto(
        job_id=job.id,
        kind=JobPhotoKind.BEFORE,
        file_key=f"u/{world.pro.id}/job_photo/{uuid.uuid4().hex}.jpg",
        uploaded_by=world.pro.id,
    )
    db_session.add(photo)
    await db_session.flush()
    await db_session.refresh(photo)

    assert photo.safe_status is MediaSafeStatus.PENDING
    assert (photo.safe_key, photo.safe_content_type) == (None, None)
    indexes = await (await db_session.connection()).run_sync(
        lambda c: {str(index["name"]) for index in inspect(c).get_indexes(TABLE)}
    )
    assert {"ix_job_photos_job_id", "ix_job_photos_uploaded_by"} <= indexes


@pytest.mark.parametrize(
    "fields",
    [
        {"kind": "during"},
        {"safe_status": "lost"},
        {"file_key": "taken"},
        {"safe_key": "m/taken.jpg"},
        {"job_id": uuid.uuid4()},
        {"uploaded_by": uuid.uuid4()},
    ],
    ids=["kind", "safe_status", "file_key", "safe_key", "job_id", "uploaded_by"],
)
async def test_the_constraints_refuse_bad_rows(
    db_session: AsyncSession, fields: dict[str, object]
) -> None:
    world = await build_world(db_session)
    job = await make_job(db_session, world, JobStatus.IN_PROGRESS)
    taken = JobPhoto(
        job_id=job.id,
        kind=JobPhotoKind.AFTER,
        file_key="taken",
        uploaded_by=world.pro.id,
        safe_key="m/taken.jpg",
    )
    db_session.add(taken)
    await db_session.flush()
    values: dict[str, object] = {
        "job_id": job.id,
        "kind": "after",
        "file_key": "fresh",
        "uploaded_by": world.pro.id,
        "safe_status": "pending",
        "safe_key": None,
        **fields,
    }

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO job_photos (job_id, kind, file_key, uploaded_by, safe_status, "
                    "safe_key) VALUES (:job_id, :kind, :file_key, :uploaded_by, :safe_status, "
                    ":safe_key)"
                ),
                values,
            )


async def test_downgrade_drops_the_table_and_upgrade_restores_it(
    db_session: AsyncSession,
) -> None:
    # On the test session's transaction, which is rolled back: Postgres DDL is transactional,
    # so the shared test database keeps its head.
    module = migration()

    def after(step: str, connection: Connection) -> bool:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(module, step)()
        return has_table(connection)

    connection = await db_session.connection()
    assert module.down_revision == "4b37f90005dc"
    assert await connection.run_sync(lambda c: after("downgrade", c)) is False
    assert await connection.run_sync(lambda c: after("upgrade", c)) is True
    assert await connection.run_sync(lambda c: after("downgrade", c)) is False
    assert await connection.run_sync(lambda c: after("upgrade", c)) is True
