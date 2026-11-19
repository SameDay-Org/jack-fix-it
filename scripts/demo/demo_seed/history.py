"""Thirty days of plausible business, so the KPIs, the earnings and the lists look alive.

`plan` is pure and deterministic: the same seed, days and "today" give the same requests, at
the same local times, with the same endings. `CaseRun.run` then lives one request through the
real endpoints (flows.py), dating each step as it goes (timeline.py). A step whose planned
time has not come yet is not taken, so the most recent days end where a real pipeline would
be: a quote waiting, a job scheduled, a job done and not yet confirmed. The scenes the video
needs (scenes.py) are cases too, written by hand.

Shape (of 100 requests, roughly): 62 are booked and paid, 18 get a quote nobody accepts (it
expires, then the request does), 12 are cancelled by the customer before a quote, 8 never get
one. Of the completed jobs about 80% are confirmed by the customer, 12% by the 48 h
auto-confirm, and the rest have a problem reported that an admin then resolves: a few
percent of disputes, as docs/kpis.md expects, and none left open (the video's own dispute is
the open one). Most requests get a first contact within the SLA.

Two endings have no endpoint yet and go through the state machine itself, the one writer of
a request's status: the customer's cancel before paying and the system's expiry (the BDC
actions and the request deadline are #82 and #51). The first contact has no endpoint either
(#82): it is a time noted on the request's own row (Timeline.put).
"""

import random
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum
from typing import Final

from sqlalchemy import text

from app.modules.jobs.service import SYSTEM
from app.modules.jobs.tasks import auto_confirm_jobs
from app.modules.quotes.tasks import expire_quotes
from app.modules.requests.state_machine import RequestStateMachine, RequestStatus
from app.modules.users.service import UserService
from demo_seed import flows, pictures
from demo_seed.cast import (
    CUSTOMER_REVIEWS,
    DISPUTE_TEXT,
    PRO_REVIEWS,
    UNSORTED,
    WORK,
    Person,
    Place,
    Work,
)
from demo_seed.flows import Catalog, Checkout, QuoteTerms, RequestRef
from demo_seed.timeline import Timeline
from demo_seed.world import Actor, SeedError, World

# A step planned later than this before now is left for "later": it has not happened yet.
NOT_YET: Final = timedelta(minutes=10)
# How long after its last quote expired (or after it was sent to pros, with no quote) a
# request with nothing pending is closed by the system.
REQUEST_GIVES_UP_AFTER: Final = timedelta(hours=72)
# The earliest start a pro proposes after quoting.
MIN_LEAD: Final = timedelta(hours=3)
# The least time between the last quote and the payment, and between the payment and the start.
PAY_GAP: Final = timedelta(hours=1)
NO_WAIT: Final = timedelta(0)
# What a second pro asks on top of the first quote.
SECOND_QUOTE_EXTRA_CENTS: Final = 2500
# How long before the visit the pro sets off.
ON_THE_WAY_BEFORE: Final = timedelta(minutes=24)
CUSTOMER_REVIEWS_AFTER: Final = timedelta(minutes=35)
PRO_REVIEWS_AFTER: Final = timedelta(hours=3)
_WEEKDAY_REQUESTS: Final = (2, 3, 3, 4, 4, 5)
_WEEKEND_REQUESTS: Final = (1, 2, 2, 3)
# The categories the approved pros cover, weighted by how often people ask.
_CATEGORY_WEIGHTS: Final = (
    ("handyman", 34),
    ("house-cleaning", 28),
    ("lawn-landscaping", 22),
    ("painting", 16),
)
_START_HOURS: Final = (9, 10, 11, 13, 14, 15)
_BEFORE: Final = (150, 142, 128)
_AFTER: Final = (98, 150, 120)
_PROBLEM: Final = (176, 120, 96)


class Ending(StrEnum):
    BOOKED = "booked"
    QUOTE_IGNORED = "quote_ignored"
    CANCELLED = "cancelled"
    NO_QUOTE = "no_quote"


class Closing(StrEnum):
    """How a completed job ends: confirmed, or a problem an admin resolves (the decision)."""

    CONFIRMED = "confirmed"
    AUTO_CONFIRMED = "auto_confirmed"
    # A problem reported and answered, waiting for an admin: the video's own dispute only.
    PROBLEM_OPEN = "problem_open"
    RELEASED = "release"
    PARTIAL = "partial"
    REFUNDED = "refund"


_RESOLVED: Final = frozenset({Closing.RELEASED, Closing.PARTIAL, Closing.REFUNDED})


@dataclass(frozen=True)
class Case:
    """One request's story: who, what, how it ends, and how long each step waits for the one
    before. `customer`, `pro` and `work` are positions in the people and the texts given to
    the run (`pro` wraps around the category's pros); `category` None is a request its
    customer could not classify (the BDC reviews it)."""

    name: str
    customer: int
    pro: int
    category: str | None
    work: int
    amount_cents: int
    ending: Ending
    closing: Closing = Closing.CONFIRMED
    contact_after: timedelta | None = None
    quote_after: timedelta = timedelta(minutes=45)
    # A second pro's quote, this long after the first, when the category has another pro.
    second_quote_after: timedelta | None = None
    pay_after: timedelta = timedelta(hours=2)
    overrun_percent: int = 100
    confirm_after: timedelta = timedelta(hours=1)
    problem_after: timedelta = timedelta(hours=2)
    reply_after: timedelta = timedelta(hours=2)
    resolve_after: timedelta = timedelta(hours=24)
    cancel_after: timedelta = timedelta(hours=1)
    customer_review: int | None = None
    pro_review: int | None = None
    dispute: int = 0


@dataclass(frozen=True)
class Planned:
    """A case of the history and when it happens: naive times, local to the business zone."""

    case: Case
    created_local: datetime
    start_local: datetime


@dataclass(frozen=True)
class Lived:
    """What a run left: the request, and its job when one was booked."""

    request: RequestRef
    job_id: uuid.UUID | None


@dataclass(frozen=True)
class People:
    """Who a run uses: the customers with their home addresses, the approved pros of each
    category, and the admin who resolves disputes."""

    customers: list[tuple[Actor, Person, Place]]
    pros: dict[str, list[Actor]]
    admin: Actor


def plan(seed: int, days: int, today: date, customers: int) -> list[Planned]:
    """The requests of the `days` days before `today`, oldest first."""
    rng = random.Random(seed)  # noqa: S311 - a fixed seed on purpose: the same demo every run
    # The first few customers come back more often: the repeat rate needs repeat customers.
    regulars = [3 if index < max(2, customers // 6) else 1 for index in range(customers)]
    cases: list[Planned] = []
    for offset in range(days, 0, -1):
        day = today - timedelta(days=offset)
        counts = _WEEKEND_REQUESTS if day.weekday() >= 5 else _WEEKDAY_REQUESTS
        # A little more demand in the latest third: the chart climbs gently.
        count = rng.choice(counts) + (1 if offset * 3 <= days and rng.random() < 0.5 else 0)
        for minute in sorted(rng.randrange(8 * 60, 20 * 60) for _ in range(count)):
            name = f"history-{len(cases) + 1:03d}"
            cases.append(_planned(rng, name, day, minute, regulars))
    return cases


def _planned(rng: random.Random, name: str, day: date, minute: int, regulars: list[int]) -> Planned:
    slugs = [slug for slug, _ in _CATEGORY_WEIGHTS]
    category = rng.choices(slugs, [weight for _, weight in _CATEGORY_WEIGHTS])[0]
    work = rng.randrange(len(WORK[category]))
    low, high = WORK[category][work].amount_cents
    start_day = day + timedelta(days=rng.randint(1, 4))
    roll = rng.random()
    ending = (
        Ending.BOOKED
        if roll < 0.62
        else Ending.QUOTE_IGNORED
        if roll < 0.80
        else Ending.CANCELLED
        if roll < 0.92
        else Ending.NO_QUOTE
    )
    roll = rng.random()
    closing = (
        Closing.CONFIRMED
        if roll < 0.80
        else Closing.AUTO_CONFIRMED
        if roll < 0.92
        else rng.choice((Closing.RELEASED, Closing.PARTIAL, Closing.REFUNDED))
    )
    roll = rng.random()
    contact_after = (
        timedelta(seconds=rng.randint(70, 280))
        if roll < 0.80
        else timedelta(minutes=rng.randint(6, 40))
        if roll < 0.92
        else None
    )
    case = Case(
        name=name,
        customer=rng.choices(range(len(regulars)), regulars)[0],
        pro=rng.randrange(12),
        category=category,
        work=work,
        amount_cents=rng.randrange(low, high + 1, 500),
        ending=ending,
        closing=closing,
        contact_after=contact_after,
        quote_after=timedelta(minutes=rng.randint(15, 240)),
        second_quote_after=timedelta(minutes=rng.randint(10, 90)) if rng.random() < 0.3 else None,
        pay_after=timedelta(minutes=rng.randint(100, 600)),
        overrun_percent=rng.randint(80, 130),
        confirm_after=timedelta(minutes=rng.randint(20, 1500)),
        problem_after=timedelta(minutes=rng.randint(60, 900)),
        reply_after=timedelta(minutes=rng.randint(30, 300)),
        resolve_after=timedelta(hours=rng.randint(18, 60)),
        cancel_after=timedelta(minutes=rng.randint(5, 300)),
        customer_review=_review(rng, len(CUSTOMER_REVIEWS)) if rng.random() < 0.75 else None,
        pro_review=_review(rng, len(PRO_REVIEWS)) if rng.random() < 0.6 else None,
        dispute=rng.randrange(len(DISPUTE_TEXT)),
    )
    return Planned(
        case=case,
        created_local=datetime.combine(day, time()) + timedelta(minutes=minute),
        start_local=datetime.combine(start_day, time(hour=rng.choice(_START_HOURS))),
    )


def _review(rng: random.Random, texts: int) -> int:
    """An index into the review texts, the best ones (listed first) drawn most."""
    return min(rng.randrange(texts), rng.randrange(texts))


async def local_times(world: World, naive: list[datetime]) -> list[datetime]:
    """Each naive time read in the business time zone, by Postgres (its own tz database, as
    the queue and the metrics read "today"): this machine may have none."""
    statement = text(
        "SELECT timezone(:zone, moment) FROM unnest(CAST(:moments AS timestamp[])) "
        "WITH ORDINALITY AS listed(moment, position) ORDER BY position"
    )
    zone = world.settings.business_time_zone
    async with world.session() as session:
        found = await session.execute(statement, {"zone": zone, "moments": naive})
        return [row[0] for row in found.all()]


async def business_today(world: World) -> date:
    """Today's date in the business time zone, by Postgres."""
    statement = text("SELECT CAST(timezone(:zone, now()) AS date)")
    async with world.session() as session:
        today: date = (
            await session.execute(statement, {"zone": world.settings.business_time_zone})
        ).scalar_one()
    return today


class CaseRun:
    """Requests lived through the API, each step dated to its planned time."""

    def __init__(self, world: World, people: People, catalog: Catalog, checkout: Checkout) -> None:
        self._world = world
        self._people = people
        self._catalog = catalog
        self._checkout = checkout
        self._now = datetime.now(UTC)

    def _due(self, at: datetime) -> bool:
        return at <= self._now - NOT_YET

    async def run(self, case: Case, created: datetime, start: datetime) -> Lived:
        """Lives `case`, created at `created`, its job (if one is booked) starting at `start`
        or a few hours after its quote, whichever is later."""
        customer, _, place = self._people.customers[case.customer]
        work = (UNSORTED if case.category is None else WORK[case.category])[case.work]
        request = await flows.create_request(
            self._world,
            customer,
            name=case.name,
            category_id=None if case.category is None else self._catalog.category(case.category),
            place=place,
            description=work.description,
            answers=work.answers,
            preferred_date=(datetime.now(UTC) + (start - created)).date().isoformat(),
        )
        line = Timeline(self._world.sessions, request.id)
        await line.mark(created)
        if case.contact_after is not None and self._due(created + case.contact_after):
            line.put("first_contact_at", created + case.contact_after)
        try:
            job_id = await self._live(line, case, work, customer, request, created, start)
        finally:
            await line.flush()
        return Lived(request, job_id)

    async def _live(
        self,
        line: Timeline,
        case: Case,
        work: Work,
        customer: Actor,
        request: RequestRef,
        created: datetime,
        start: datetime,
    ) -> uuid.UUID | None:
        """The story after the request is made; the job's id once one is booked."""
        if case.ending is Ending.CANCELLED:
            await self._close(line, request, customer, created + case.cancel_after)
            return None
        if case.ending is Ending.NO_QUOTE or case.category is None:
            await self._close(line, request, None, created + REQUEST_GIVES_UP_AFTER)
            return None
        quoted = created + case.quote_after
        if not self._due(quoted):
            return None
        pros = self._people.pros[case.category]
        pro = pros[case.pro % len(pros)]
        # A start at least a few hours after the quote, as the pro would propose it.
        lead = max(start - quoted, MIN_LEAD)
        start = quoted + lead
        terms = QuoteTerms(
            amount_cents=case.amount_cents,
            scope=work.scope,
            approach=work.approach,
            duration_minutes=work.duration_minutes,
            start_at=line.ahead(lead),
        )
        dispatch = await self._dispatch(case, pro, request)
        quote_id = await flows.send_quote(self._world, pro, dispatch, terms)
        await line.mark(quoted)
        last_quote = quoted
        other = pros[(case.pro + 1) % len(pros)]
        if case.second_quote_after is not None and other is not pro:
            last_quote = quoted + case.second_quote_after
            if self._due(last_quote):
                # Another pro answers too: a little dearer, a day later.
                rival = QuoteTerms(
                    amount_cents=case.amount_cents + SECOND_QUOTE_EXTRA_CENTS,
                    scope=work.scope,
                    approach=work.approach,
                    duration_minutes=work.duration_minutes,
                    start_at=line.ahead(lead + timedelta(days=1) - case.second_quote_after),
                )
                dispatch = await self._dispatch(case, other, request)
                await flows.send_quote(self._world, other, dispatch, rival)
                await line.mark(last_quote)
        if case.ending is Ending.QUOTE_IGNORED:
            await self._let_quote_expire(line, request)
            return None
        paid = min(max(quoted + case.pay_after, last_quote + PAY_GAP), start - PAY_GAP)
        if not self._due(paid):
            return None
        await flows.accept_quote(self._world, customer, request, quote_id)
        job_id = await flows.pay(self._world, customer, request, quote_id, self._checkout)
        await line.mark(paid)
        minutes = work.duration_minutes * case.overrun_percent // 100
        done = start + timedelta(minutes=minutes)
        if await self._work(line, customer, pro, request, job_id, start, done):
            await self._close_job(line, case, customer, pro, request, job_id, done)
        return job_id

    async def _dispatch(self, case: Case, pro: Actor, request: RequestRef) -> str:
        dispatch = await flows.dispatch_of(self._world, pro, request)
        if dispatch is None:
            raise SeedError(f"{case.name}: the request did not reach {pro.email}")
        return dispatch

    async def _work(
        self,
        line: Timeline,
        customer: Actor,
        pro: Actor,
        request: RequestRef,
        job_id: uuid.UUID,
        start: datetime,
        done: datetime,
    ) -> bool:
        """On my way to Job's done, as far as the job's day has come: a visit under way now
        is left on the way or working. True once the job is completed."""
        if not self._due(start - ON_THE_WAY_BEFORE):
            return False
        await flows.on_the_way(self._world, pro, job_id)
        await line.mark(start - ON_THE_WAY_BEFORE)
        if not self._due(start):
            return False
        await flows.check_in(self._world, customer, pro, request, job_id)
        await line.mark(start - timedelta(minutes=3))
        await flows.start_work(self._world, pro, job_id)
        await line.mark(start)
        caption = f"{request.public_code} before"
        await flows.add_photo(self._world, pro, job_id, "before", pictures.photo(caption, _BEFORE))
        await line.mark(start + timedelta(minutes=2))
        if not self._due(done):
            return False
        caption = f"{request.public_code} after"
        await flows.add_photo(self._world, pro, job_id, "after", pictures.photo(caption, _AFTER))
        await line.mark(done - timedelta(minutes=2))
        await flows.complete(self._world, pro, job_id)
        await line.mark(done)
        return True

    async def _close_job(
        self,
        line: Timeline,
        case: Case,
        customer: Actor,
        pro: Actor,
        request: RequestRef,
        job_id: uuid.UUID,
        done: datetime,
    ) -> None:
        hours = self._world.settings.job_auto_confirm_after_hours
        closing = case.closing
        reported = done + case.problem_after
        resolved = reported + case.resolve_after
        if closing in _RESOLVED and not self._due(resolved):
            # A problem still open would compete with the video's own dispute.
            closing = Closing.CONFIRMED
        if closing is Closing.CONFIRMED:
            confirmed = done + min(case.confirm_after, timedelta(hours=hours - 1))
            if not self._due(confirmed):
                return
            await flows.confirm(self._world, customer, request)
        elif closing is Closing.AUTO_CONFIRMED:
            confirmed = done + timedelta(hours=hours, minutes=7)
            if not self._due(confirmed):
                return
            # The 48 h auto-confirm itself: the job's dates written first, then the worker's
            # cron, run here.
            await line.flush()
            await self._world.run(auto_confirm_jobs)
            await self._world.drain()
        else:
            if self._due(reported):
                await self._report(line, case, customer, pro, job_id, reported)
                if closing in _RESOLVED:
                    await self._resolve(line, closing, job_id, resolved)
            return
        await line.mark(confirmed)
        if case.customer_review is not None and self._due(confirmed + CUSTOMER_REVIEWS_AFTER):
            overall, comment = CUSTOMER_REVIEWS[case.customer_review]
            await flows.review(self._world, customer, job_id, overall, comment)
            await line.mark(confirmed + CUSTOMER_REVIEWS_AFTER)
        if case.pro_review is not None and self._due(confirmed + PRO_REVIEWS_AFTER):
            overall, comment = PRO_REVIEWS[case.pro_review]
            await flows.review(self._world, pro, job_id, overall, comment)
            await line.mark(confirmed + PRO_REVIEWS_AFTER)

    async def _report(
        self,
        line: Timeline,
        case: Case,
        customer: Actor,
        pro: Actor,
        job_id: uuid.UUID,
        reported: datetime,
    ) -> None:
        """The customer reports a problem with photos; the pro answers."""
        reason, problem, reply = DISPUTE_TEXT[case.dispute]
        await flows.report_problem(
            self._world,
            customer,
            job_id,
            reason=reason,
            description=problem,
            photos=[
                pictures.photo("What I see now", _PROBLEM),
                pictures.photo("A closer look", _PROBLEM),
            ],
        )
        await line.mark(reported)
        if self._due(reported + case.reply_after):
            await flows.reply_to_problem(self._world, pro, job_id, reply)
            await line.mark(reported + case.reply_after)

    async def _resolve(
        self, line: Timeline, closing: Closing, job_id: uuid.UUID, resolved: datetime
    ) -> None:
        """An admin decides the dispute, as the panel does."""
        dispute = await flows.dispute_of(self._world, self._people.admin, job_id)
        await flows.resolve_dispute(
            self._world,
            self._people.admin,
            dispute.id,
            decision=closing.value,
            note="Reviewed the photos and both messages.",
            # A partial: half of the pro's payout, in whole dollars.
            pro_release_cents=(
                dispute.pro_payout_cents // 200 * 100 if closing is Closing.PARTIAL else None
            ),
        )
        await line.mark(resolved)

    async def _let_quote_expire(self, line: Timeline, request: RequestRef) -> None:
        """Nobody accepted: once the quotes' time is up the worker's sweep expires them, and
        later the system closes the request."""
        await line.flush()
        async with self._world.session() as session:
            expires: datetime = (
                await session.execute(
                    text("SELECT max(expires_at) FROM quotes WHERE request_id = :request"),
                    {"request": request.id},
                )
            ).scalar_one()
        if not self._due(expires):
            return
        await self._world.run(expire_quotes)
        await line.mark(expires + timedelta(minutes=3))
        await self._close(line, request, None, expires + REQUEST_GIVES_UP_AFTER)

    async def _close(
        self, line: Timeline, request: RequestRef, by: Actor | None, at: datetime
    ) -> None:
        """The request's end with no job: cancelled by its customer (`by`), or expired by the
        system (`by` None). Through RequestStateMachine: no endpoint moves these yet."""
        if not self._due(at):
            return
        async with self._world.session() as session:
            machine = RequestStateMachine(session)
            if by is None:
                await machine.transition(request.id, RequestStatus.EXPIRED, SYSTEM)
            else:
                customer = await UserService(session).get_by_id(by.user_id)
                if customer is None:
                    raise SeedError(f"{request.public_code}: its customer is gone")
                await machine.transition(request.id, RequestStatus.CANCELLED, customer)
            await session.commit()
        await line.mark(at)
