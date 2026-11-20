"""The demo's history happens today and is dated afterwards.

Every row of the 30-day history is written by the real services, which stamp it with the
current time (the database's `now()`, the state machines' clock). No service takes a date, so
a request "from three weeks ago" is lived now and then re-dated:

- after each step of a request's life, `Timeline.mark(at)` notes the time values that step
  wrote or changed, on the rows that hang from the request, and where they belong (`at`);
- `Timeline.flush()` writes the noted dates. Normally once, when the request's story is
  over: while it runs, the rows keep today's times, so every rule that reads the clock (a
  quote not yet expired when it is accepted, a problem reported inside its window) sees what
  it would in real life. A step that needs time to have passed (the 48 h auto-confirm, the
  quote expiry sweep) flushes first, then runs the worker's own cron.

Rules:

- Only time columns are written (timestamps and dates). A status is never touched: those move
  through the state machines only, and the database guard would refuse anything else.
- A value in a step's future keeps its distance: a quote made "three weeks ago" still expires
  48 hours after it, a start proposed two days out stays two days out. The distance is
  measured from when the step began (`Timeline.ahead` gives a step the real time that lands
  exactly where it wants).
- What a step wrote is found by comparing each row with what the previous step left, never
  by comparing clocks. A value only ever moves back: one the database stamped a moment
  before `at` (a request made "now", a database clock behind this process) stays as it is,
  so nothing is ever dated in the future. Only the deadline test reads this process's clock,
  with a minute of slack.
- audit_log is append-only (its trigger refuses updates): the audit rows of seeded staff
  actions keep the day the seed ran.
"""

import json
import uuid
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from typing import Final

from sqlalchemy import Date, DateTime, Table, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import Base, import_models

_OF_JOB: Final = "job_id IN (SELECT id FROM jobs WHERE request_id = :request)"
_REQUESTS: Final = "service_requests"
# The rows that belong to one request, by table: what a step of its life can write.
CASE_TABLES: Final[Mapping[str, str]] = {
    _REQUESTS: "id = :request",
    # Each request has its own address row.
    "addresses": "id IN (SELECT address_id FROM service_requests WHERE id = :request)",
    "request_media": "request_id = :request",
    "request_dispatches": "request_id = :request",
    "quotes": "request_id = :request",
    "payments": "request_id = :request",
    "jobs": "request_id = :request",
    "job_events": _OF_JOB,
    "job_photos": _OF_JOB,
    "job_messages": _OF_JOB,
    "reviews": _OF_JOB,
    "disputes": _OF_JOB,
    "transfers": _OF_JOB,
    "refunds": _OF_JOB,
    # A job cancelled by its customer or its pro (#69).
    "job_cancellations": _OF_JOB,
    "support_tickets": _OF_JOB,
    "dispute_photos": (
        "dispute_id IN (SELECT id FROM disputes WHERE job_id IN "
        "(SELECT id FROM jobs WHERE request_id = :request))"
    ),
}
# A timestamp further ahead than this was written as a deadline or a plan, not as "now".
FUTURE_SLACK: Final = timedelta(minutes=1)

Moment = datetime | date
Row = dict[str, Moment | None]
RowKey = tuple[str, uuid.UUID]


def _time_columns(table: Table) -> list[str]:
    """The table's timestamp and date columns. A case table is keyed by `id` alone."""
    if [column.name for column in table.primary_key.columns] != ["id"]:
        raise RuntimeError(f"{table.name}: the timeline needs a single id key")
    return [column.name for column in table.columns if isinstance(column.type, DateTime | Date)]


def case_columns() -> dict[str, list[str]]:
    """Each case table's time columns, from the models."""
    import_models()
    return {name: _time_columns(Base.metadata.tables[name]) for name in CASE_TABLES}


def _read_statement(columns: Mapping[str, list[str]]) -> str:
    """One statement for a request's rows: (table, id, {column: value}). Table and column
    names come from the models, never from input."""
    parts = []
    for name, predicate in CASE_TABLES.items():
        pairs = ", ".join(f"'{column}', {column}" for column in columns[name])
        parts.append(
            f"SELECT '{name}' AS table_name, id, jsonb_build_object({pairs}) AS moments "  # noqa: S608
            f"FROM {name} WHERE {predicate}"
        )
    return " UNION ALL ".join(parts)


def moved(value: Moment, at: datetime, began: datetime) -> Moment:
    """Where a value belongs when the step that wrote it, begun at `began`, happened at `at`."""
    if not isinstance(value, datetime):
        return at.date() + (value - began.date())
    if value > began + FUTURE_SLACK:
        return at + (value - began)
    return min(at, value)


class Timeline:
    """One request's rows, re-dated step by step."""

    _columns: dict[str, list[str]] | None = None
    _statement: str = ""

    def __init__(self, sessions: async_sessionmaker[AsyncSession], request_id: uuid.UUID) -> None:
        if Timeline._columns is None:
            Timeline._columns = case_columns()
            Timeline._statement = _read_statement(Timeline._columns)
        self._table_columns = Timeline._columns
        self._sessions = sessions
        self._request_id = request_id
        # Each row as the database holds it, and the dates noted for it and not yet written.
        self._seen: dict[RowKey, Row] = {}
        self._noted: dict[RowKey, Row] = {}
        self._began = datetime.now(UTC)

    def ahead(self, distance: timedelta) -> datetime:
        """A real time for the step about to run to send (a proposed start): its mark lands
        it exactly `distance` after the step's `at`."""
        return self._began + distance

    async def mark(self, at: datetime) -> None:
        """Notes that every time value written or changed since the last mark belongs at
        `at`. The next step begins now."""
        async with self._sessions() as session:
            for key, current in (await self._read(session)).items():
                known = self._seen.get(key, {})
                for column, value in current.items():
                    if value is not None and known.get(column) != value:
                        self._noted.setdefault(key, {})[column] = moved(value, at, self._began)
                self._seen[key] = current
        self._began = datetime.now(UTC)

    def put(self, column: str, value: datetime) -> None:
        """Notes a time on the request's own row that no endpoint sets (the first contact)."""
        self._noted.setdefault((_REQUESTS, self._request_id), {})[column] = value

    async def flush(self) -> None:
        """Writes the noted dates. Rows the last mark did not see are left alone."""
        async with self._sessions() as session:
            for key, noted in self._noted.items():
                table, row_id = key
                settled: Row = {**self._seen[key], **noted}
                assignments = ", ".join(
                    f"{column} = :{column}" for column in self._table_columns[table]
                )
                await session.execute(
                    text(f"UPDATE {table} SET {assignments} WHERE id = :id"),  # noqa: S608
                    {**settled, "id": row_id},
                )
                self._seen[key] = settled
            await session.commit()
        self._noted = {}

    async def _read(self, session: AsyncSession) -> dict[RowKey, Row]:
        found = await session.execute(text(Timeline._statement), {"request": self._request_id})
        return {(table, row_id): _parse(raw) for table, row_id, raw in found.all()}


def _parse(raw: object) -> Row:
    """jsonb's ISO strings back to datetimes and dates."""
    values = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(values, dict):
        raise TypeError("the timeline's read did not return an object")
    return {
        str(column): None if value is None else _moment(str(value))
        for column, value in values.items()
    }


def _moment(value: str) -> Moment:
    return datetime.fromisoformat(value) if "T" in value else date.fromisoformat(value)
