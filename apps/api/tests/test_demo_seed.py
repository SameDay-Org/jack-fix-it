"""The demo seed (scripts/demo, docs/demo-video.md): where it may run, its deterministic plan,
how it dates what the services write, and one whole run on a throwaway `jackdemo` database.

The whole run uses the API exactly as the seed does (in process, the worker's tasks inline),
with the storage in memory and Stripe's stand-ins: no network. It is the seed's own contract
test too: an endpoint the seed drives that changes shape fails here, not on recording day.
"""

import asyncio
import sys
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import SecretStr
from sqlalchemy import URL, make_url, text

from app.config import Settings
from app.db import Base, import_models
from app.integrations.storage import PresignedUpload
from tests.conftest import TEST_STORAGE_SETTINGS, make_settings
from tests.test_media_copies import MemoryStorage

DEMO_DIR = Path(__file__).resolve().parents[3] / "scripts" / "demo"
# The demo scripts live outside apps/api (they are tooling, not the product): run as scripts,
# their folder is the import root.
sys.path.insert(0, str(DEMO_DIR))

import seed_demo  # noqa: E402
from demo_seed import cast, guard, history, scenes, timeline  # noqa: E402
from demo_seed.world import SeedError, World, open_world  # noqa: E402

DEMO_DATABASE = "jackdemo_pytest"
# Fixture value only: the seeded accounts' password in the throwaway database.
PASSWORD = "Demo-Seed-Test-1!"
DAYS = 3
SEED = 7


@dataclass
class DemoStorage(MemoryStorage):
    """The storage in memory, answering the API's presign calls too (nothing is fetched)."""

    def presign_put(
        self, key: str, content_type: str, content_length: int, expires_in: int
    ) -> PresignedUpload:
        return PresignedUpload(
            url=f"https://storage.example.invalid/{key}", headers={"Content-Type": content_type}
        )

    def presign_get(self, key: str, expires_in: int) -> str:
        return f"https://storage.example.invalid/{key}"


# ---- Where it may run ----


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql://jack:jack@db.internal:5432/jackdemo",
        "postgresql://jack:jack@10.0.0.7:5432/jackdemo_video",
        "postgresql://jack:jack@127.0.0.1:5432/jack",
        "postgresql://jack:jack@localhost:5432/jack_test",
        "postgresql://jack:jack@localhost:5432/demo_jackdemo",
        "postgresql://jack:jack@localhost:5432/railway",
    ],
)
def test_the_guard_refuses_anything_but_a_local_jackdemo_database(database_url: str) -> None:
    with pytest.raises(guard.DemoGuardError):
        guard.demo_database_url(database_url)


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1"])
def test_the_guard_accepts_a_local_jackdemo_database(host: str) -> None:
    url = guard.demo_database_url(f"postgresql://jack:jack@{host}:5432/jackdemo_video")
    assert url.database == "jackdemo_video"


@pytest.mark.parametrize(
    "key", ["sk_live_fixture-not-a-real-key", "rk_live_fixture-not-a-real-key", "anything"]
)
def test_the_guard_refuses_a_stripe_key_that_is_not_a_test_key(key: str) -> None:
    """Settings refuse a live key in development themselves; the guard does not rely on it."""
    settings = make_settings(database_url="postgresql://j:j@localhost:5432/jackdemo")
    keyed = settings.model_copy(update={"stripe_secret_key": SecretStr(key)})
    with pytest.raises(guard.DemoGuardError, match="TEST key"):
        guard.check_settings(keyed)


def test_the_guard_accepts_a_test_key_and_no_key() -> None:
    settings = make_settings(database_url="postgresql://j:j@localhost:5432/jackdemo")
    keyed = settings.model_copy(update={"stripe_secret_key": SecretStr("sk_test_fixture")})
    assert guard.check_settings(settings).database == "jackdemo"
    assert guard.check_settings(keyed).database == "jackdemo"


def test_the_guard_refuses_a_deployed_environment() -> None:
    """Staging and production settings need their secrets to load at all; the guard's own
    check is on the environment's name."""
    settings = make_settings(database_url="postgresql://j:j@localhost:5432/jackdemo")
    for environment in ("staging", "production"):
        deployed = settings.model_copy(update={"app_env": environment})
        with pytest.raises(guard.DemoGuardError, match=environment):
            guard.check_settings(deployed)


async def test_the_guard_checks_the_name_again_before_it_drops_a_database() -> None:
    """recreate and drop never trust their caller: a URL that is not a demo one is refused
    before anything connects."""
    url = make_url("postgresql+asyncpg://jack:jack@localhost:5432/jack")
    with pytest.raises(guard.DemoGuardError):
        await guard.drop_database(url)
    with pytest.raises(guard.DemoGuardError):
        await guard.recreate_database(url, drop=True)


def test_reset_and_fresh_do_not_go_together() -> None:
    with pytest.raises(SystemExit):
        seed_demo.parse_args(["--reset", "--fresh"])


def test_the_demo_password_is_generated_once_and_read_back(tmp_path: Path) -> None:
    path = tmp_path / "password"
    password, created = seed_demo.demo_password(path, 10)
    assert created
    assert len(password) >= 10
    assert seed_demo.demo_password(path, 10) == (password, False)
    with pytest.raises(SeedError):
        seed_demo.demo_password(path, len(password) + 1)


def test_no_demo_script_names_the_status_guard() -> None:
    """Statuses move through the state machines only (#163): the seed never sets the
    database guard's flag, not even for its history."""
    sources = [*DEMO_DIR.glob("*.py"), *(DEMO_DIR / "demo_seed").glob("*.py")]
    assert len(sources) > 5
    for source in sources:
        assert "status_writer" not in source.read_text(encoding="utf-8"), source.name


# ---- The plan ----


def test_the_plan_is_the_same_for_the_same_seed_and_day() -> None:
    today = date(2026, 11, 19)
    first = history.plan(SEED, 30, today, 30)
    assert first == history.plan(SEED, 30, today, 30)
    assert first != history.plan(SEED + 1, 30, today, 30)


def test_the_plan_covers_every_day_before_today_and_none_after() -> None:
    today = date(2026, 11, 19)
    planned = history.plan(SEED, 30, today, 30)
    days = {item.created_local.date() for item in planned}
    assert days == {today - timedelta(days=offset) for offset in range(1, 31)}
    assert [item.created_local for item in planned] == sorted(i.created_local for i in planned)
    for item in planned:
        assert item.start_local.date() > item.created_local.date()
        assert item.case.category in cast.WORK
        low, high = cast.WORK[item.case.category][item.case.work].amount_cents
        assert low <= item.case.amount_cents <= high


def test_the_plan_books_most_requests_and_disputes_few() -> None:
    planned = [item.case for item in history.plan(SEED, 90, date(2026, 11, 19), 30)]
    booked = [case for case in planned if case.ending is history.Ending.BOOKED]
    disputed = [case for case in booked if case.closing.value in ("release", "partial", "refund")]
    assert 0.5 < len(booked) / len(planned) < 0.75
    assert 0.02 < len(disputed) / len(booked) < 0.15


# ---- Dating what the services wrote ----


def test_a_value_written_now_moves_to_its_step_and_a_deadline_keeps_its_distance() -> None:
    began = datetime(2026, 11, 19, 15, 0, tzinfo=UTC)
    at = datetime(2026, 10, 30, 9, 30, tzinfo=UTC)
    assert timeline.moved(began + timedelta(milliseconds=40), at, began) == at
    deadline = began + timedelta(hours=48, milliseconds=12)
    assert timeline.moved(deadline, at, began) == at + timedelta(hours=48, milliseconds=12)
    assert timeline.moved(date(2026, 11, 21), at, began) == date(2026, 11, 1)


def test_every_table_hanging_from_a_request_or_a_job_is_dated_or_named() -> None:
    """A new table with a foreign key to service_requests or jobs holds times of a request's
    life: the timeline dates it, or it is listed here with the reason it is not."""
    import_models()
    # Not written by the seed: the chat (no seeded message) and its flags.
    not_seeded = {"job_chat_reads", "job_messages", "chat_offender_flags"}
    hanging = {
        table.name
        for table in Base.metadata.tables.values()
        for key in table.foreign_keys
        if key.column.table.name in ("service_requests", "jobs")
    }
    assert hanging - set(timeline.CASE_TABLES) - not_seeded == set()
    columns = timeline.case_columns()
    assert "first_contact_at" in columns["service_requests"]
    assert {"completed_at", "confirmed_at", "created_at"} <= set(columns["jobs"])


# ---- One whole run ----


@pytest.fixture(scope="module")
def demo_settings() -> Iterator[Settings]:
    """Settings on a migrated, empty `jackdemo_pytest` next to DATABASE_URL's database, dropped
    afterwards. Sync on purpose: alembic's env runs its own event loop."""
    url: URL = make_url(Settings().database_url).set(database=DEMO_DATABASE)
    asyncio.run(guard.recreate_database(url, drop=True))
    guard.migrate(url)
    try:
        yield make_settings(
            database_url=url.render_as_string(hide_password=False), **TEST_STORAGE_SETTINGS
        )
    finally:
        asyncio.run(guard.drop_database(url))


async def _counts(world: World) -> dict[str, int]:
    """Rows per table, every table."""
    import_models()
    async with world.session() as session:
        return {
            name: (await session.execute(text(f"SELECT count(*) FROM {name}"))).scalar_one()  # noqa: S608
            for name in sorted(Base.metadata.tables)
        }


async def _scalar(world: World, statement: str, **parameters: object) -> object:
    async with world.session() as session:
        return (await session.execute(text(statement), parameters)).scalar_one()


async def test_a_whole_run_makes_the_scenes_and_a_second_run_changes_nothing(
    demo_settings: Settings,
) -> None:
    storage = DemoStorage()
    run = seed_demo.Run(
        seed=SEED, days=DAYS, fresh=False, password=PASSWORD, password_file=Path("unused")
    )

    def stripe() -> scenes.Stripe:
        return seed_demo.stripe_for(demo_settings, stand_ins_only=True, pro_account=None)

    lines = await seed_demo.seed(demo_settings, storage, stripe(), run)

    assert "Demo database ready." in lines
    assert not any(PASSWORD in line for line in lines)  # shown only when just generated
    async with open_world(demo_settings, storage, stripe().stand_ins) as world:
        marker = await scenes.read_marker(world)
        assert marker is not None
        admin = (await scenes.people_of(world)).admin

        # Every tab of the queue has something to show.
        queue = await world.call(admin, "GET", "/v1/admin/requests/summary", what="queue")
        assert queue["new"] >= 2
        assert queue["urgent"] >= 2
        assert queue["waiting_customer"] >= 1
        assert queue["waiting_pro"] >= 1
        assert queue["quote_ready"] >= 1
        assert queue["scheduled_today"] >= 2
        assert queue["problems"] >= 2
        new = await world.call(
            admin, "GET", "/v1/admin/requests", params={"bucket": "new"}, what="new"
        )
        assert {item["public_code"] for item in new["items"]} >= set(marker["fresh_codes"])  # type: ignore[arg-type]
        assert all(item["assigned_agent"] is None for item in new["items"])

        # Maria waits for approval, her two documents are images, and nothing else blocks her.
        pending = await world.call(
            admin, "GET", "/v1/admin/pros", params={"status": "pending"}, what="pending pros"
        )
        [maria] = pending["items"]
        assert maria["name"].startswith(cast.MARIA.first)
        assert maria["documents"] == {"pending": 2, "approved": 0, "rejected": 0}
        detail = await world.call(admin, "GET", f"/v1/admin/pros/{maria['id']}", what="maria")
        assert detail["missing_types"] == []
        assert {document["doc_type"] for document in detail["documents"]} == {"id", "insurance"}
        documents = [content for key, content in storage.uploads if "/pro_document/" in key]
        assert documents
        assert set(documents) == {"image/jpeg"}

        # Dan and the other three are approved with payouts enabled.
        approved = await world.call(
            admin, "GET", "/v1/admin/pros", params={"status": "approved"}, what="approved pros"
        )
        assert len(approved["items"]) == len(cast.PROS)
        assert all(item["payouts_enabled"] for item in approved["items"])

        # One open problem: Jamie's, with photos and the pro's reply, waiting for an admin.
        disputes = await world.call(
            admin, "GET", "/v1/admin/disputes", params={"status": "open"}, what="disputes"
        )
        [problem] = disputes["disputes"]
        assert problem["public_code"] == marker["dispute_code"]
        dispute = await world.call(admin, "GET", f"/v1/admin/disputes/{problem['id']}", what="one")
        assert dispute["status"] == "open"
        assert dispute["pro_reply"]
        assert len(dispute["photos"]) + dispute["photos_pending"] == 2
        assert dispute["customer_total_cents"] > dispute["pro_payout_cents"] > 0

        tickets = await world.call(
            admin, "GET", "/v1/admin/support/tickets", params={"status": "open"}, what="tickets"
        )
        assert len(tickets["items"]) >= 3

        metrics = await world.call(admin, "GET", "/v1/admin/metrics", what="metrics")
        assert metrics["metrics"]["contact_rate"]["numerator"] > 0
        assert metrics["metrics"]["lead_to_job"]["numerator"] > 0
        assert sum(point["requests_created"] for point in metrics["series"]) > DAYS

        # Staff read the panel in English; Jamie's finished job has both reviews.
        assert (
            await _scalar(
                world,
                "SELECT count(*) FROM users WHERE role IN ('admin', 'agent') AND locale = 'en'",
            )
            == 2
        )
        assert (
            await _scalar(
                world,
                "SELECT count(*) FROM reviews WHERE job_id IN (SELECT j.id FROM jobs j JOIN "
                "service_requests r ON r.id = j.request_id WHERE r.public_code = :code)",
                code=marker["confirmed_code"],
            )
            == 2
        )
        # The history is dated across its days, and nothing happened in the future.
        assert await _scalar(
            world, "SELECT min(created_at) < now() - interval '2 days' FROM service_requests"
        )
        assert (
            await _scalar(
                world,
                "SELECT (SELECT count(*) FROM service_requests WHERE created_at > now())"
                " + (SELECT count(*) FROM job_events WHERE created_at > now())"
                " + (SELECT count(*) FROM jobs WHERE completed_at > now() OR created_at > now())"
                " + (SELECT count(*) FROM reviews WHERE created_at > now())",
            )
            == 0
        )
        before = await _counts(world)

    # Again: nothing changes.
    again = await seed_demo.seed(demo_settings, storage, stripe(), run)
    assert again[0].startswith("Already seeded")
    async with open_world(demo_settings, storage, stripe().stand_ins) as world:
        assert await _counts(world) == before

    # --fresh: one more request for the New tab.
    fresh = await seed_demo.seed(demo_settings, storage, stripe(), replace(run, fresh=True))
    assert fresh[0].startswith("New request JF-")
    async with open_world(demo_settings, storage, stripe().stand_ins) as world:
        after = await _counts(world)
    assert after["service_requests"] == before["service_requests"] + 1
    assert after["users"] == before["users"]
