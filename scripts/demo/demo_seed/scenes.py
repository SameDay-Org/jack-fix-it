"""What the seed builds, in order: the people, the history, then the scenes the video needs.

The scenes (handoffs of the demo kit, docs/demo-video.md):

- staff: an admin and an agent, locale en (the panel follows the account);
- Dan, approved with payouts enabled, and three more approved pros for the other categories;
  Maria, waiting for approval with two image documents, the only pro of Moving & Assembly;
- Jamie, the customer, with a home address, a photo and (on Stripe TEST) a saved card;
- one job of Jamie's done by Dan, confirmed, reviewed by both;
- one job of Jamie's with a problem reported, photos and Dan's reply, waiting for an admin,
  paid through the TEST gateway when a TEST key is set, so the panel's partial refund works;
- a request of Jamie's with two quotes to compare;
- the queue: fresh requests nobody holds, urgent ones, one waiting on its customer, one
  waiting on pros, two jobs scheduled today, one request held by the agent;
- support tickets, open.

A marker row in `settings` records that the seed finished (and what it made), so a second
run changes nothing.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Final

from pydantic import JsonValue
from sqlalchemy import text

from app.integrations.stripe_connect import AccountReader
from app.integrations.stripe_payments import PaymentIntentFacts
from app.modules.settings.models import Setting
from app.modules.users.service import UserService
from app.modules.users.types import UserRole
from demo_seed import cast, flows, history
from demo_seed.cast import Person, Place, ProSetup
from demo_seed.flows import Catalog, Checkout
from demo_seed.history import Case, CaseRun, Closing, Ending, Lived, People
from demo_seed.stripe_standins import stand_in_id
from demo_seed.stripe_test import CardCheckout
from demo_seed.timeline import Timeline
from demo_seed.world import Actor, Gateways, SeedError, World

MARKER_KEY: Final = "demo_seed"
MARKER_VERSION: Final = 1
# A document's validity, from the day the seed runs.
_DOCUMENT_VALID_FOR: Final = timedelta(days=540)
_MONTH: Final = timedelta(days=30)
# Positions in cast.PROS' categories: Dan is the first pro of handyman and painting.
_DAN: Final = 0
# A job "scheduled today" starts this long from now, never past the day's end.
_TODAY_LEAD: Final = timedelta(hours=3)
_BEFORE_MIDNIGHT: Final = timedelta(minutes=20)
# The admin's follow-ups: the overdue one was set yesterday, due this long after; the one due
# today is never due sooner than this (in the day's last minutes).
_FOLLOWUP_YESTERDAY: Final = timedelta(days=1)
_OVERDUE_LEAD: Final = timedelta(hours=3)
_TODAY_MIN_LEAD: Final = timedelta(minutes=5)
# The requests the queue's "New" tab opens with.
_FRESH_CATEGORY: Final = cast.MARIA_CATEGORIES[0]


@dataclass(frozen=True)
class Options:
    seed: int
    days: int
    password: str
    # Dan's real TEST connected account (acct_...), when the recording should also show his
    # payouts screen and a real transfer; None: a stand-in id.
    pro_account: str | None = None


@dataclass(frozen=True)
class Stripe:
    """The stand-ins, always; the TEST gateway and its checkout when a TEST key is set."""

    stand_ins: Gateways
    stand_in_checkout: Checkout
    accounts: AccountReader
    test: Gateways | None = None
    test_checkout: CardCheckout | None = None
    test_accounts: AccountReader | None = None


@dataclass
class Summary:
    """What the seed made, for the printed summary and the marker. No secret in it."""

    stripe: str
    requests: int = 0
    dispute_code: str = ""
    confirmed_code: str = ""
    quotes_code: str = ""
    fresh_codes: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def marker(self, options: Options) -> dict[str, JsonValue]:
        return {
            "version": MARKER_VERSION,
            "seed": options.seed,
            "days": options.days,
            "stripe": self.stripe,
            "requests": self.requests,
            "dispute_code": self.dispute_code,
            "confirmed_code": self.confirmed_code,
            "quotes_code": self.quotes_code,
            "fresh_codes": list(self.fresh_codes),
            "notes": list(self.notes),
        }


async def read_marker(world: World) -> dict[str, JsonValue] | None:
    """The finished seed's marker, or None."""
    async with world.session() as session:
        row = await session.get(Setting, MARKER_KEY)
    return row.value if row is not None and isinstance(row.value, dict) else None


async def has_accounts(world: World) -> bool:
    async with world.session() as session:
        return bool((await session.execute(text("SELECT count(*) FROM users"))).scalar_one())


async def build(world: World, options: Options, stripe: Stripe) -> Summary:
    """Everything, on an empty migrated database with the catalog seeded."""
    summary = Summary(stripe="test" if stripe.test is not None else "stand_in")
    catalog = await flows.read_catalog(world)
    _check_places(catalog)
    now = datetime.now(UTC)
    admin = await flows.create_staff(
        world, cast.ADMIN_EMAIL, UserRole.ADMIN, cast.ADMIN_NAME, options.password
    )
    agent = await flows.create_staff(
        world, cast.AGENT_EMAIL, UserRole.AGENT, cast.AGENT_NAME, options.password
    )
    pros = await _pros(world, catalog, admin, options, stripe, now)
    await _onboard(world, catalog, cast.MARIA_SETUP, options.password, now)
    customers = await _customers(world, options, now)
    people = People(customers=customers, pros=pros, admin=admin)

    world.use(stripe.stand_ins)
    today = await history.business_today(world)
    planned = history.plan(options.seed, options.days, today, len(customers))
    moments = await history.local_times(
        world, [item.created_local for item in planned] + [item.start_local for item in planned]
    )
    runner = CaseRun(world, people, catalog, stripe.stand_in_checkout)
    for index, item in enumerate(planned):
        await runner.run(item.case, moments[index], moments[len(planned) + index])
    summary.requests = len(planned)

    jamie = await _jamie(world, options, stripe)
    jamies = People(customers=[(jamie, cast.JAMIE, cast.JAMIE_HOME)], pros=pros, admin=admin)
    confirmed, problem = await _jamies_jobs(world, catalog, jamies, stripe, summary, now)
    waiting_customer = await _queue(world, catalog, people, jamies, stripe, agent, summary, now)
    await _bdc_work(world, admin, waiting_customer.request)
    await _tickets(world, jamie, pros["handyman"][_DAN], customers[0][0], confirmed)
    if problem.job_id is None or confirmed.job_id is None:
        raise SeedError("the video's jobs were not booked")
    await _write_marker(world, options, summary)
    return summary


def _check_places(catalog: Catalog) -> None:
    """Every address the seed uses is in a served ZIP: a request elsewhere would not dispatch."""
    for place in (cast.JAMIE_HOME, *cast.PLACES):
        if place.zip_code not in catalog.zips:
            raise SeedError(f"ZIP {place.zip_code} is not a served area: seed the service areas")


def _areas(world: World, catalog: Catalog) -> list[str]:
    """The service areas every seeded pro covers: the ZIPs of the served cities, the
    addresses' own first, up to the API's cap."""
    wanted = [place.zip_code for place in (cast.JAMIE_HOME, *cast.PLACES)]
    for city in cast.SERVED_CITIES:
        wanted += catalog.zips_by_city.get(city, [])
    unique = list(dict.fromkeys(wanted))[: world.settings.pro_max_service_areas]
    return [str(catalog.zips[zip_code]) for zip_code in unique]


async def _onboard(
    world: World, catalog: Catalog, setup: ProSetup, password: str, now: datetime
) -> Actor:
    """A pro signs up, fills the profile and sends the two documents: waiting for approval."""
    pro = await flows.register(world, setup.person, password)
    await flows.set_pro_profile(
        world,
        pro,
        setup.person,
        bio=setup.bio,
        years=setup.years,
        category_ids=[catalog.category(slug) for slug in setup.categories],
        area_ids=_areas(world, catalog),
    )
    valid_until = (now + _DOCUMENT_VALID_FOR).date().isoformat()
    await flows.submit_documents(world, pro, setup.person, valid_until)
    return pro


async def _pros(
    world: World, catalog: Catalog, admin: Actor, options: Options, stripe: Stripe, now: datetime
) -> dict[str, list[Actor]]:
    """The approved pros, payouts enabled, by category, in cast.PROS' order."""
    by_category: dict[str, list[Actor]] = {}
    for setup in cast.PROS:
        pro = await _onboard(world, catalog, setup, options.password, now)
        await flows.approve_pro(world, admin, pro)
        own = options.pro_account if setup.person is cast.DAN else None
        if own is not None and stripe.test_accounts is not None:
            await flows.enable_payouts(world, pro, own, stripe.test_accounts)
        else:
            account_id = stand_in_id("acct", setup.person.email)
            await flows.enable_payouts(world, pro, account_id, stripe.accounts)
        await world.drain()
        await _joined(world, pro, now - setup.joined_months_ago * _MONTH)
        for slug in setup.categories:
            by_category.setdefault(slug, []).append(pro)
    return by_category


async def _customers(
    world: World, options: Options, now: datetime
) -> list[tuple[Actor, Person, Place]]:
    """The history's customers, each at one of the addresses, joined before the history."""
    customers = []
    for index, person in enumerate(cast.CUSTOMERS):
        actor = await flows.register(world, person, options.password)
        joined = now - timedelta(days=options.days + 3 + index * 4)
        await _joined(world, actor, joined)
        customers.append((actor, person, cast.PLACES[index % len(cast.PLACES)]))
    return customers


async def _joined(world: World, account: Actor, at: datetime) -> None:
    """Dates an account's sign-up (and a pro's profile, documents and approval): time columns
    only, as timeline.py does for requests."""
    reviewed = at + timedelta(days=2)
    statements: tuple[tuple[str, dict[str, datetime]], ...] = (
        ("UPDATE users SET created_at = :at, updated_at = :at WHERE id = :user", {}),
        (
            "UPDATE pro_profiles SET created_at = :at, updated_at = :reviewed, "
            "reviewed_at = :reviewed WHERE user_id = :user AND reviewed_at IS NOT NULL",
            {"reviewed": reviewed},
        ),
        (
            "UPDATE pro_documents SET created_at = :at, updated_at = :reviewed, "
            "reviewed_at = :reviewed WHERE reviewed_at IS NOT NULL AND pro_id IN "
            "(SELECT id FROM pro_profiles WHERE user_id = :user)",
            {"reviewed": reviewed},
        ),
    )
    async with world.session() as session:
        for statement, extra in statements:
            await session.execute(text(statement), {"at": at, "user": account.user_id, **extra})
        await session.commit()


async def _jamie(world: World, options: Options, stripe: Stripe) -> Actor:
    jamie = await flows.register(world, cast.JAMIE, options.password)
    await flows.set_account_photo(world, jamie, cast.JAMIE, cast.JAMIE_HOME)
    await flows.save_address(world, jamie, cast.JAMIE_HOME, "Home")
    await _joined(world, jamie, datetime.now(UTC) - timedelta(days=41))
    if stripe.test is not None and stripe.test_checkout is not None:
        # The wallet's own flow: a SetupIntent, confirmed with Stripe's test Visa.
        world.use(stripe.test)
        world.app.state.stripe_payment_methods = None
        intent = await world.call(
            jamie, "POST", "/v1/me/payment-methods/setup-intent", what="card setup"
        )
        await stripe.test_checkout.save_card(intent["client_secret"])
        await flows.make_first_card_default(world, jamie)
    return jamie


async def _jamies_jobs(
    world: World,
    catalog: Catalog,
    jamies: People,
    stripe: Stripe,
    summary: Summary,
    now: datetime,
) -> tuple[Lived, Lived]:
    """Jamie's two jobs with Dan: one confirmed and reviewed, one with a problem open. Paid
    through the TEST gateway when there is one; the transfer to Dan stays a stand-in unless
    Dan has a real TEST account (Options.pro_account)."""
    checkout: Checkout = stripe.stand_in_checkout
    if stripe.test is not None and stripe.test_checkout is not None:
        transfers = stripe.test.transfers if stripe.test_accounts else stripe.stand_ins.transfers
        world.use(Gateways(stripe.test.payments, transfers, stripe.test.refunds))
        checkout = stripe.test_checkout
    else:
        summary.notes.append(
            "Stripe stand-ins only: the open dispute's payment is not a Stripe one, so the "
            "panel cannot refund it. Set STRIPE_SECRET_KEY (sk_test_...), drop "
            "--stand-in-stripe and run --reset."
        )
    runner = CaseRun(world, jamies, catalog, checkout)
    done = now - timedelta(days=1, hours=5)
    cabinet = Case(
        name="jamie-confirmed",
        customer=0,
        pro=_DAN,
        category="handyman",
        work=0,
        amount_cents=12500,
        ending=Ending.BOOKED,
        contact_after=timedelta(minutes=3),
        quote_after=timedelta(minutes=35),
        confirm_after=timedelta(minutes=40),
        customer_review=0,
        pro_review=0,
    )
    confirmed = await runner.run(
        cabinet, done - timedelta(days=2, hours=3), done - timedelta(hours=1)
    )
    summary.confirmed_code = confirmed.request.public_code
    finished = now - timedelta(hours=3)
    bedroom = Case(
        name="jamie-problem",
        customer=0,
        pro=_DAN,
        category="painting",
        work=0,
        amount_cents=42000,
        ending=Ending.BOOKED,
        closing=Closing.PROBLEM_OPEN,
        contact_after=timedelta(minutes=4),
        quote_after=timedelta(minutes=50),
        problem_after=timedelta(hours=2),
        reply_after=timedelta(minutes=25),
        dispute=1,
    )
    started = finished - timedelta(hours=6)
    problem = await runner.run(bedroom, started - timedelta(days=2), started)
    summary.dispute_code = problem.request.public_code
    world.use(stripe.stand_ins)
    return confirmed, problem


async def _queue(
    world: World,
    catalog: Catalog,
    people: People,
    jamies: People,
    stripe: Stripe,
    agent: Actor,
    summary: Summary,
    now: datetime,
) -> Lived:
    """The requests that make each tab of the operations queue worth opening. Returns the
    one waiting on its customer, for the BDC's notes and follow-ups."""
    start_today = await _later_today(world, now)
    runner = CaseRun(world, people, catalog, stripe.stand_in_checkout)
    # Scheduled today: two paid jobs whose visit is still ahead.
    for index, (category, pro) in enumerate((("handyman", _DAN), ("house-cleaning", 0))):
        booked = Case(
            name=f"queue-today-{index}",
            customer=index + 2,
            pro=pro,
            category=category,
            work=1,
            amount_cents=cast.WORK[category][1].amount_cents[0],
            ending=Ending.BOOKED,
            contact_after=timedelta(minutes=2),
            quote_after=timedelta(hours=1),
        )
        await runner.run(booked, now - timedelta(days=2, hours=index), start_today)
    # Waiting on pros: sent to them, no quote yet.
    waiting = Case(
        name="queue-waiting-pro",
        customer=5,
        pro=0,
        category="lawn-landscaping",
        work=0,
        amount_cents=0,
        ending=Ending.BOOKED,
        contact_after=timedelta(minutes=3),
        quote_after=timedelta(hours=8),
    )
    await runner.run(waiting, now - timedelta(minutes=40), now + timedelta(days=2))
    # Waiting on its customer: unclassified, the BDC asked for more.
    asked = Case(
        name="queue-waiting-customer",
        customer=6,
        pro=0,
        category=None,
        work=0,
        amount_cents=0,
        ending=Ending.NO_QUOTE,
        contact_after=timedelta(minutes=4),
    )
    waiting_customer = await runner.run(asked, now - timedelta(hours=5), now + timedelta(days=3))
    # Urgent: past the first-contact time and never contacted. The agent holds one.
    late = now - timedelta(minutes=world.settings.ops_first_contact_sla_minutes * 9)
    unsorted = Case(
        name="queue-urgent-unsorted",
        customer=7,
        pro=0,
        category=None,
        work=1,
        amount_cents=0,
        ending=Ending.NO_QUOTE,
    )
    held = await runner.run(unsorted, late - timedelta(hours=2), now + timedelta(days=2))
    await flows.claim(world, agent, held.request)
    overdue = Case(
        name="queue-urgent",
        customer=8,
        pro=0,
        category=_FRESH_CATEGORY,
        work=1,
        amount_cents=0,
        ending=Ending.NO_QUOTE,
    )
    await runner.run(overdue, late, now + timedelta(days=2))
    # Jamie's request with two quotes to compare (Dan's and Sam's).
    compare = Case(
        name="jamie-quotes",
        customer=0,
        pro=_DAN,
        category="handyman",
        work=2,
        amount_cents=13500,
        ending=Ending.QUOTE_IGNORED,
        contact_after=timedelta(minutes=2),
        quote_after=timedelta(minutes=40),
        second_quote_after=timedelta(minutes=30),
    )
    quotes = await CaseRun(world, jamies, catalog, stripe.stand_in_checkout).run(
        compare, now - timedelta(hours=3), now + timedelta(days=2)
    )
    summary.quotes_code = quotes.request.public_code
    # New: just in, nobody holds them. Only Maria offers the category, so they wait for her.
    for index in (9, 10):
        summary.fresh_codes.append(
            await fresh_request(world, catalog, people, index, f"queue-new-{index}")
        )
    return waiting_customer


async def _bdc_work(world: World, admin: Actor, request: flows.RequestRef) -> None:
    """The admin's work on the request waiting on its customer, through the API (the holder
    rule, the follow-up's range and the audit apply): yesterday a note and a follow-up due a
    few hours later, so overdue now; today a note and a follow-up due later today. The
    follow-ups page lists both and its badge counts both (due by the end of today, overdue
    included). Yesterday's are lived now and dated back, as the history is (timeline); the
    audit rows keep the day the seed ran."""
    yesterday_note, today_note = cast.BDC_NOTES
    line = Timeline(world.sessions, request.id)
    await line.start()
    yesterday = datetime.now(UTC) - _FOLLOWUP_YESTERDAY
    await flows.add_note(world, admin, request, yesterday_note)
    await flows.schedule_followup(
        world, admin, request, line.ahead(_OVERDUE_LEAD), cast.FOLLOWUP_OVERDUE
    )
    await line.mark(yesterday)
    await line.flush()
    await flows.add_note(world, admin, request, today_note)
    now = datetime.now(UTC)
    due = max(await _later_today(world, now), now + _TODAY_MIN_LEAD)
    await flows.schedule_followup(world, admin, request, due, cast.FOLLOWUP_TODAY)


async def fresh_request(
    world: World, catalog: Catalog, people: People, customer: int, name: str
) -> str:
    """One more request for the queue's New tab, made now; its public code."""
    fresh = Case(
        name=name,
        customer=customer % len(people.customers),
        pro=0,
        category=_FRESH_CATEGORY,
        work=0,
        amount_cents=0,
        ending=Ending.NO_QUOTE,
    )
    runner = CaseRun(world, people, catalog, _NoCheckout())
    now = datetime.now(UTC)
    return (await runner.run(fresh, now, now + timedelta(days=2))).request.public_code


class _NoCheckout:
    """flows.Checkout for runs that never pay."""

    async def charge(self, payment_intent_id: str) -> PaymentIntentFacts:
        raise SeedError("this run does not pay")


async def _later_today(world: World, now: datetime) -> datetime:
    """A start today in the business time zone: three hours from now, or twenty minutes
    before its midnight when the day is nearly over (in its last minutes that is a visit
    already due: still today's). The quote that proposes it is dated two days back, so the
    start itself need not be ahead of the clock."""
    statement = text(
        "SELECT timezone(:zone, date_trunc('day', timezone(:zone, now())) + interval '1 day')"
    )
    async with world.session() as session:
        midnight: datetime = (
            await session.execute(statement, {"zone": world.settings.business_time_zone})
        ).scalar_one()
    return min(now + _TODAY_LEAD, midnight - _BEFORE_MIDNIGHT)


async def _tickets(
    world: World, jamie: Actor, dan: Actor, customer: Actor, confirmed: Lived
) -> None:
    """Open support tickets: Jamie's about her finished job, Dan's and another customer's."""
    (topic, message), second, third = cast.TICKETS
    await flows.open_ticket(
        world, jamie, name="jamie", topic=topic, message=message, job_id=confirmed.job_id
    )
    await flows.open_ticket(world, dan, name="dan", topic=second[0], message=second[1], job_id=None)
    await flows.open_ticket(
        world, customer, name="customer", topic=third[0], message=third[1], job_id=None
    )


async def _write_marker(world: World, options: Options, summary: Summary) -> None:
    async with world.session() as session:
        session.add(Setting(key=MARKER_KEY, value=summary.marker(options)))
        await session.commit()


async def people_of(world: World) -> People:
    """The seeded customers, pros and admin, read back by email: for a run on a database
    that is seeded already (`--fresh`)."""
    customers: list[tuple[Actor, Person, Place]] = []
    pros: dict[str, list[Actor]] = {}
    async with world.session() as session:
        users = UserService(session)
        for setup in cast.PROS:
            account = await users.get_by_email(setup.person.email)
            if account is None:
                raise SeedError(f"{setup.person.email} is missing: run --reset")
            for slug in setup.categories:
                pros.setdefault(slug, []).append(
                    world.actor(account.id, UserRole.PRO, setup.person.email)
                )
        for index, person in enumerate(cast.CUSTOMERS):
            account = await users.get_by_email(person.email)
            if account is None:
                raise SeedError(f"{person.email} is missing: run --reset")
            actor = world.actor(account.id, UserRole.CUSTOMER, person.email)
            customers.append((actor, person, cast.PLACES[index % len(cast.PLACES)]))
        admin = await users.get_by_email(cast.ADMIN_EMAIL)
    if admin is None:
        raise SeedError("the demo admin is missing: run --reset")
    return People(
        customers=customers,
        pros=pros,
        admin=world.actor(admin.id, UserRole.ADMIN, cast.ADMIN_EMAIL),
    )


def fresh_name(now: datetime) -> str:
    """A new Idempotency-Key name per call: `--fresh` adds a request each time."""
    return f"fresh-{now.isoformat()}-{uuid.uuid4().hex[:6]}"
