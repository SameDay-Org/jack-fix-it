"""The demo seed (scripts/demo, docs/demo-video.md): where it may run, its deterministic plan,
how it dates what the services write, one whole run on a throwaway `jackdemo` database, and
every ending a request can have.

The runs use the API exactly as the seed does (in process, the worker's tasks inline), with the
storage in memory and Stripe's stand-ins: no network. They are the seed's contract test too:
an endpoint the seed drives that changes shape fails here, not on recording day. What the whole
run meets depends on the day and the hour (a step whose time has not come is not taken), so
the endings are also lived one by one, with dates old enough to be due at any hour.
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
from tests.conftest import make_settings
from tests.test_media_copies import MemoryStorage

DEMO_DIR = Path(__file__).resolve().parents[3] / "scripts" / "demo"
# The demo scripts live outside apps/api (they are tooling, not the product): run as scripts,
# their folder is the import root.
sys.path.insert(0, str(DEMO_DIR))

import demo_api  # noqa: E402
import seed_demo  # noqa: E402
from demo_seed import cast, flows, guard, history, scenes, timeline  # noqa: E402
from demo_seed.history import Case, CaseRun, Closing, Ending  # noqa: E402
from demo_seed.world import SeedError, World, open_world  # noqa: E402

DAYS = 3
SEED = 7
LOCAL = "postgresql://jack:jack@localhost:5432/jackdemo"


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
        "postgresql://jack:jack@localhost:5432/",
        "postgresql:///jackdemo",
        # Two hosts: the driver may connect to either.
        "postgresql://jack:jack@localhost,db.internal:5432/jackdemo",
        # A query string overrides the host and the database SQLAlchemy connects to.
        "postgresql://jack:jack@localhost:5432/jackdemo?host=db.internal",
        "postgresql://jack:jack@localhost:5432/jackdemo?database=jack",
        "postgresql://jack:jack@localhost:5432/jackdemo?host=db.internal&database=jack",
        "postgresql+asyncpg://jack:jack@127.0.0.1:5432/jackdemo?dsn=postgresql://db.internal/jack",
        "postgresql://jack:jack@localhost:5432/jackdemo?ssl=require",
        "not a url",
    ],
)
def test_the_guard_refuses_anything_but_a_local_jackdemo_database(database_url: str) -> None:
    with pytest.raises(guard.DemoGuardError):
        guard.demo_database_url(database_url)


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1"])
def test_the_guard_accepts_a_local_jackdemo_database(host: str) -> None:
    url = guard.demo_database_url(f"postgresql+asyncpg://jack:jack@{host}:5432/jackdemo_video")
    assert url.database == "jackdemo_video"


@pytest.mark.parametrize(
    "key", ["sk_live_fixture-not-a-real-key", "rk_live_fixture-not-a-real-key", "anything"]
)
def test_the_guard_refuses_a_stripe_key_that_is_not_a_test_key(key: str) -> None:
    """Settings refuse a live key in development themselves; the guard does not rely on it."""
    keyed = make_settings(database_url=LOCAL).model_copy(
        update={"stripe_secret_key": SecretStr(key)}
    )
    with pytest.raises(guard.DemoGuardError, match="TEST key"):
        guard.check_settings(keyed)


def test_the_guard_accepts_a_test_key_and_no_key() -> None:
    settings = make_settings(database_url=LOCAL)
    keyed = settings.model_copy(update={"stripe_secret_key": SecretStr("sk_test_fixture")})
    assert guard.check_settings(settings).database == "jackdemo"
    assert guard.check_settings(keyed).database == "jackdemo"


def test_the_guard_refuses_a_deployed_environment() -> None:
    """Staging and production settings need their secrets to load at all; the guard's own
    check is on the environment's name."""
    settings = make_settings(database_url=LOCAL)
    for environment in ("staging", "production"):
        deployed = settings.model_copy(update={"app_env": environment})
        with pytest.raises(guard.DemoGuardError, match=environment):
            guard.check_settings(deployed)


def test_the_guard_refuses_a_storage_that_is_not_on_this_machine() -> None:
    """The seed uploads a few hundred files: never to a shared or deployed bucket."""
    remote = make_settings(database_url=LOCAL, s3_endpoint_url="https://storage.example.invalid")
    with pytest.raises(guard.DemoGuardError, match="S3_ENDPOINT_URL"):
        guard.check_settings(remote)
    local = make_settings(database_url=LOCAL, s3_endpoint_url="http://127.0.0.1:9000")
    assert guard.check_settings(local).database == "jackdemo"


async def test_nothing_opens_or_drops_a_database_the_guard_refuses() -> None:
    """recreate, drop, migrate, the seed and its in-process app never trust their caller: each
    checks again, before anything connects."""
    url = make_url("postgresql+asyncpg://jack:jack@localhost:5432/jack")
    redirected = make_url("postgresql+asyncpg://jack:jack@localhost:5432/jackdemo?host=db.internal")
    for refused in (url, redirected):
        with pytest.raises(guard.DemoGuardError):
            await guard.drop_database(refused)
        with pytest.raises(guard.DemoGuardError):
            await guard.recreate_database(refused, drop=True)
        with pytest.raises(guard.DemoGuardError):
            guard.migrate(refused)
        settings = make_settings(database_url=refused.render_as_string(hide_password=False))
        stripe = seed_demo.stripe_for(settings, stand_ins_only=True, pro_account=None)
        with pytest.raises(guard.DemoGuardError):
            async with open_world(settings, DemoStorage(), stripe.stand_ins):
                pytest.fail("the world opened on a refused database")
        run = seed_demo.Run(seed=SEED, days=DAYS, fresh=False, password_file=Path("unused"))
        with pytest.raises(guard.DemoGuardError):
            await seed_demo.seed(settings, DemoStorage(), stripe, run)


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
    booked = [case for case in planned if case.ending is Ending.BOOKED]
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


def test_a_value_never_moves_forward() -> None:
    """A request made "now" on a database whose clock is behind this process keeps the
    database's own stamp: nothing is dated after the database's present."""
    began = datetime(2026, 11, 19, 15, 0, tzinfo=UTC)
    stamped = began - timedelta(seconds=3)
    assert timeline.moved(stamped, began, began) == stamped


def test_every_table_hanging_from_a_request_or_a_job_is_dated_or_named() -> None:
    """A new table with a foreign key to service_requests or jobs holds times of a request's
    life: the timeline dates it, or it is listed here with the reason it is not."""
    import_models()
    # Not written by the seed: the chat (no seeded message) and its flags, the tips (#273:
    # no scene tips, so no tip or keyed tip choice is seeded), the contacts of web
    # requests (#86: the seed makes no request without an account), and the Live Activity
    # tokens (#596: an iPhone sends one when it starts an activity; the seed starts none).
    not_seeded = {
        "job_chat_reads",
        "job_messages",
        "chat_offender_flags",
        "tips",
        "tip_requests",
        "web_request_contacts",
        "live_activity_tokens",
    }
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
    assert "created_at" in columns["addresses"]


# ---- One whole run, and every ending ----


@dataclass(frozen=True)
class Seeded:
    settings: Settings
    storage: DemoStorage
    run: seed_demo.Run
    lines: list[str]

    def stripe(self) -> scenes.Stripe:
        """Fresh stand-ins: what a new process of the seed starts with."""
        return seed_demo.stripe_for(self.settings, stand_ins_only=True, pro_account=None)


@pytest.fixture(scope="module")
def seeded(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Seeded]:
    """A migrated demo database, seeded once for this module, dropped afterwards. It sits next
    to DATABASE_URL's database and carries its name, as conftest's `<name>_test` does: two
    checkouts testing on one Postgres never share it. Sync on purpose: alembic's env runs its
    own event loop."""
    base: URL = make_url(Settings().database_url)
    url = base.set(database=f"{guard.DATABASE_PREFIX}_pytest_{base.database}", query={})
    asyncio.run(guard.recreate_database(url, drop=True))
    try:
        guard.migrate(url)
        settings = make_settings(database_url=url.render_as_string(hide_password=False))
        storage = DemoStorage()
        password_file = tmp_path_factory.mktemp("demo") / "password"
        run = seed_demo.Run(seed=SEED, days=DAYS, fresh=False, password_file=password_file)
        stripe = seed_demo.stripe_for(settings, stand_ins_only=True, pro_account=None)
        lines = asyncio.run(seed_demo.seed(settings, storage, stripe, run))
        yield Seeded(settings, storage, run, lines)
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


async def _nothing_in_the_future(world: World) -> bool:
    return (
        await _scalar(
            world,
            "SELECT (SELECT count(*) FROM service_requests WHERE created_at > now())"
            " + (SELECT count(*) FROM job_events WHERE created_at > now())"
            " + (SELECT count(*) FROM jobs WHERE completed_at > now() OR created_at > now())"
            " + (SELECT count(*) FROM disputes WHERE created_at > now() OR resolved_at > now())"
            " + (SELECT count(*) FROM reviews WHERE created_at > now())",
        )
        == 0
    )


async def test_a_whole_run_makes_the_scenes(seeded: Seeded) -> None:
    lines, storage = seeded.lines, seeded.storage
    assert "Demo database ready." in lines
    # The password is made with the accounts, kept in its file, and shown that once.
    password = seeded.run.password_file.read_text(encoding="utf-8").strip()
    assert any(line.endswith(password) and "shown once" in line for line in lines)
    async with open_world(seeded.settings, storage, seeded.stripe().stand_ins) as world:
        marker = await scenes.read_marker(world)
        assert marker is not None
        admin = (await scenes.people_of(world)).admin
        today = await history.business_today(world)

        # Every tab of the queue has something to show.
        queue = await world.call(admin, "GET", "/v1/admin/requests/summary", what="queue")
        assert queue["new"] >= 2
        assert queue["urgent"] >= 2
        assert queue["waiting_customer"] >= 1
        assert queue["waiting_pro"] >= 1
        assert queue["quote_ready"] >= 1
        assert queue["problems"] >= 2
        if await history.business_today(world) == today:  # not across the business midnight
            assert queue["scheduled_today"] >= 2
        new = await world.call(
            admin, "GET", "/v1/admin/requests", params={"bucket": "new"}, what="new"
        )
        fresh = marker["fresh_codes"]
        assert isinstance(fresh, list)
        assert {item["public_code"] for item in new["items"]} >= set(fresh)
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

        # The admin's follow-ups, on the request waiting on its customer: the overdue one first
        # (set four hours ago, due two hours later), then the one due later today.
        followups = await world.call(admin, "GET", "/v1/admin/followups", what="follow-ups")
        overdue, later = followups["items"]
        assert (overdue["note"], later["note"]) == (cast.FOLLOWUP_OVERDUE, cast.FOLLOWUP_TODAY)
        assert overdue["request_id"] == later["request_id"]
        assert overdue["assigned_to"]["id"] == later["assigned_to"]["id"] == str(admin.user_id)
        now = datetime.now(UTC)
        assert datetime.fromisoformat(overdue["due_at"]) < now - timedelta(hours=1)
        if await history.business_today(world) == today:  # not across the business midnight
            assert datetime.fromisoformat(later["due_at"]) > now
            badge = await world.call(admin, "GET", "/v1/admin/followups/summary", what="badge")
            assert badge["due_today"] == 2
        waiting = await world.call(
            admin, "GET", f"/v1/admin/requests/{overdue['request_id']}", what="waiting request"
        )
        assert (waiting["status"], waiting["category"]) == ("reviewing", None)
        # The agent's two internal notes, oldest first, on the urgent request they hold (the
        # only request with notes).
        agent_id = str(
            await _scalar(
                world, "SELECT id FROM users WHERE email = :email", email=cast.AGENT_EMAIL
            )
        )
        noted_id = await _scalar(world, "SELECT DISTINCT request_id FROM request_notes")
        noted = await world.call(admin, "GET", f"/v1/admin/requests/{noted_id}", what="noted")
        assert noted["assigned_agent"]["id"] == agent_id
        assert [note["body"] for note in noted["notes"]] == list(cast.BDC_NOTES)
        assert {note["author"]["id"] for note in noted["notes"]} == {agent_id}
        # Each made after its request; the earlier ones dated back; each action audited.
        after_request = (
            "SELECT bool_and(made.created_at > r.created_at) FROM (SELECT request_id, created_at"
            " FROM request_notes UNION ALL SELECT request_id, created_at FROM request_followups)"
            " made JOIN service_requests r ON r.id = made.request_id"
        )
        assert await _scalar(world, after_request)
        dated = (
            "SELECT (SELECT created_at FROM request_notes WHERE body = :note) < now() - "
            "interval '30 minutes' AND (SELECT created_at FROM request_followups WHERE note = "
            ":followup) < now() - interval '3 hours'"
        )
        assert await _scalar(world, dated, note=cast.BDC_NOTES[0], followup=cast.FOLLOWUP_OVERDUE)
        audited = "SELECT count(*) FROM audit_log WHERE action = :action AND actor_user_id = :actor"
        add_note, schedule = "service_request.add_note", "service_request.schedule_followup"
        assert (
            await _scalar(world, audited, action=add_note, actor=noted["assigned_agent"]["id"]) == 2
        )
        assert await _scalar(world, audited, action=schedule, actor=str(admin.user_id)) == 2

        metrics = await world.call(admin, "GET", "/v1/admin/metrics", what="metrics")
        assert metrics["metrics"]["contact_rate"]["numerator"] > 0
        assert metrics["metrics"]["lead_to_job"]["numerator"] > 0
        assert sum(point["requests_created"] for point in metrics["series"]) > DAYS

        # Staff read the panel in English; Jamie's finished job has both reviews.
        staff = "SELECT count(*) FROM users WHERE role IN ('admin', 'agent') AND locale = 'en'"
        assert await _scalar(world, staff) == 2
        reviews = (
            "SELECT count(*) FROM reviews WHERE job_id IN (SELECT j.id FROM jobs j JOIN "
            "service_requests r ON r.id = j.request_id WHERE r.public_code = :code)"
        )
        assert await _scalar(world, reviews, code=marker["confirmed_code"]) == 2
        # The history is dated across its days, each request with its address, and nothing
        # happened in the future.
        oldest = "SELECT min(created_at) < now() - interval '2 days' FROM service_requests"
        assert await _scalar(world, oldest)
        apart = (
            "SELECT count(*) FROM service_requests r JOIN addresses a ON a.id = r.address_id "
            "WHERE a.created_at <> r.created_at"
        )
        assert await _scalar(world, apart) == 0
        assert await _nothing_in_the_future(world)


async def test_the_demo_api_s_stand_in_verifier_takes_its_code_only() -> None:
    """Relay's N3 (#568): the demo's API sends no SMS, and only its code verifies a phone."""
    verifier = demo_api.StandInVerifier("246810")

    await verifier.start("+13055550123", "en")  # nothing sent, nothing raised

    assert await verifier.check("+13055550123", "246810")
    assert not await verifier.check("+13055550123", "123456")
    assert not await verifier.check("+13055550123", "")
    assert "246810" not in repr(verifier)


def test_the_demo_api_refuses_before_it_builds_the_app(monkeypatch: pytest.MonkeyPatch) -> None:
    """#572 r1: main() runs the seed's guard first. On a database that is not a local jackdemo
    it raises DemoGuardError, and the app (with its fixed SMS code) is never built or served."""
    refused = make_settings(database_url="postgresql://jack:jack@db.example.com:5432/jack")
    built: list[object] = []

    def build(*args: object, **kwargs: object) -> object:
        built.append(args)
        raise AssertionError("the app was built before the guard refused")

    monkeypatch.setattr(demo_api, "get_settings", lambda: refused)
    monkeypatch.setattr(demo_api, "create_app", build)

    with pytest.raises(guard.DemoGuardError):
        demo_api.main()

    assert built == []


def test_the_demo_api_runs_only_where_the_seed_may() -> None:
    """The guard the seed runs refuses the demo API a database that is not a local jackdemo."""
    settings = make_settings(database_url="postgresql://jack:jack@db.example.com:5432/jack")
    with pytest.raises(guard.DemoGuardError):
        guard.check_settings(settings)


async def test_a_visit_proposed_days_ahead_starts_in_the_day(seeded: Seeded) -> None:
    """Relay's N9: seeded in the evening, a quote must not propose a visit at night. A start
    outside the day's hours in the business time zone (America/New_York in the tests) moves to
    the morning of that day; one in the day stays."""
    async with open_world(seeded.settings, seeded.storage, seeded.stripe().stand_ins) as world:
        assert world.settings.business_time_zone == "America/New_York"
        night = datetime(2030, 3, 4, 2, 0, tzinfo=UTC)  # 21:00 EST on March 3
        afternoon = datetime(2030, 3, 4, 18, 0, tzinfo=UTC)  # 13:00 EST on March 4
        assert await scenes._in_the_day(world, night) == datetime(2030, 3, 3, 15, 0, tzinfo=UTC)
        assert await scenes._in_the_day(world, afternoon) == afternoon


async def test_a_second_run_changes_nothing_and_fresh_adds_one_request(seeded: Seeded) -> None:
    settings, storage, run = seeded.settings, seeded.storage, seeded.run
    async with open_world(settings, storage, seeded.stripe().stand_ins) as world:
        before = await _counts(world)

    again = await seed_demo.seed(settings, storage, seeded.stripe(), run)

    assert again[0].startswith("Already seeded")
    password = run.password_file.read_text(encoding="utf-8").strip()
    assert not any(password in line for line in again)
    async with open_world(settings, storage, seeded.stripe().stand_ins) as world:
        assert await _counts(world) == before

    # A lost password file is not replaced by a password no account has.
    elsewhere = replace(run, password_file=run.password_file.with_name("lost"))
    lost = await seed_demo.seed(settings, storage, seeded.stripe(), elsewhere)
    assert any("is missing" in line for line in lost)
    assert not elsewhere.password_file.exists()

    fresh = await seed_demo.seed(settings, storage, seeded.stripe(), replace(run, fresh=True))
    assert fresh[0].startswith("New request JF-")
    async with open_world(settings, storage, seeded.stripe().stand_ins) as world:
        after = await _counts(world)
    assert after["service_requests"] == before["service_requests"] + 1
    assert after["users"] == before["users"]


async def test_every_ending_of_a_request_is_lived_through_the_api(seeded: Seeded) -> None:
    """The auto-confirm, each decision of a dispute, the quotes' expiry, a cancel and a request
    nobody quoted: each lived three weeks back, so every step is due at any hour of any day."""
    stripe = seeded.stripe()
    now = datetime.now(UTC)
    created, start = now - timedelta(days=21), now - timedelta(days=19)

    def case(name: str, ending: Ending, closing: Closing = Closing.CONFIRMED) -> Case:
        return Case(
            name=f"ending-{name}",
            customer=11,
            pro=0,
            category="handyman",
            work=0,
            amount_cents=12000,
            ending=ending,
            closing=closing,
            contact_after=timedelta(minutes=3),
            second_quote_after=timedelta(minutes=20),
            customer_review=0,
            pro_review=0,
        )

    async with open_world(seeded.settings, seeded.storage, stripe.stand_ins) as world:
        people = await scenes.people_of(world)
        runner = CaseRun(world, people, await flows.read_catalog(world), stripe.stand_in_checkout)

        jobs: dict[str, object] = {}

        async def booked(name: str, closing: Closing) -> object:
            """Lives a paid job to `closing`; the job's status at the end."""
            lived = await runner.run(case(name, Ending.BOOKED, closing), created, start)
            assert lived.job_id is not None
            jobs[name] = lived.job_id
            return await _scalar(world, "SELECT status FROM jobs WHERE id = :job", job=lived.job_id)

        async def live(item: Case) -> tuple[object, object]:
            """Lives a request that books no job; its status, and how many jobs it has."""
            lived = await runner.run(item, created, start)
            assert lived.job_id is None
            request = lived.request.id
            return (
                await _scalar(
                    world, "SELECT status FROM service_requests WHERE id = :id", id=request
                ),
                await _scalar(
                    world, "SELECT count(*) FROM jobs WHERE request_id = :id", id=request
                ),
            )

        async def dispute(name: str) -> tuple[object, ...]:
            statement = (
                "SELECT d.status, d.resolution, d.pro_release_cents, d.customer_refund_cents, "
                "j.pro_payout_cents, d.resolved_at > d.created_at FROM disputes d JOIN jobs j "
                "ON j.id = d.job_id WHERE d.job_id = :job"
            )
            async with world.session() as session:
                row = (await session.execute(text(statement), {"job": jobs[name]})).one()
            return tuple(row)

        # Confirmed by the 48 h auto-confirm (the worker's cron), as the system, then paid out.
        assert await booked("auto", Closing.AUTO_CONFIRMED) == "paid_out"
        system = (
            "SELECT count(*) FROM job_events WHERE job_id = :job AND to_status = 'confirmed' "
            "AND actor_id IS NULL"
        )
        assert await _scalar(world, system, job=jobs["auto"]) == 1
        waited = "SELECT confirmed_at - completed_at FROM jobs WHERE id = :job"
        assert await _scalar(world, waited, job=jobs["auto"]) == timedelta(
            hours=seeded.settings.job_auto_confirm_after_hours, minutes=7
        )

        # Each decision an admin can take on a dispute.
        assert await booked("release", Closing.RELEASED) == "paid_out"
        assert (await dispute("release"))[:2] == ("resolved", "released")
        assert await booked("refund", Closing.REFUNDED) == "refunded"
        assert (await dispute("refund"))[:2] == ("resolved", "refunded")
        assert await booked("partial", Closing.PARTIAL) == "paid_out"
        status, resolution, released, refunded, payout, dated = await dispute("partial")
        assert (status, resolution, dated) == ("resolved", "partial_release", True)
        assert isinstance(payout, int)
        assert released == payout // 200 * 100
        assert isinstance(refunded, int)
        assert refunded > 0

        # No job: both quotes expire and the request with them; a cancel; nobody quotes.
        assert await live(case("ignored", Ending.QUOTE_IGNORED)) == ("expired", 0)
        assert await live(case("cancelled", Ending.CANCELLED)) == ("cancelled", 0)
        assert await live(case("no-quote", Ending.NO_QUOTE)) == ("expired", 0)
        expired = (
            "SELECT count(*) FROM quotes WHERE status = 'expired' AND created_at < :before AND "
            "request_id IN (SELECT id FROM service_requests WHERE created_at = :created)"
        )
        assert await _scalar(world, expired, before=start, created=created) == 2
        # Dated where they belong: three weeks back, the first contact three minutes in.
        contacted = (
            "SELECT count(*) FROM service_requests WHERE created_at = :created AND "
            "first_contact_at = :contacted"
        )
        assert (
            await _scalar(
                world, contacted, created=created, contacted=created + timedelta(minutes=3)
            )
            == 7
        )
        assert await _nothing_in_the_future(world)
