"""service_requests.status is written only by RequestStateMachine (#160, AGENTS.md).

The scanner of test_job_status_single_writer.py, pointed at ServiceRequest and its table: every
`<x>.status = ...` and setattr outside the two state machines, and any statement, constructor
or raw SQL that sets a request's status outside requests/state_machine.py.
"""

import pytest

from tests.test_job_status_single_writer import (
    APP_DIR,
    REQUEST_STATE_MACHINE,
    REQUESTS,
    STATE_MACHINE,
    guarded_writes,
    planted,
    status_writes,
)


def test_only_the_state_machine_writes_request_status() -> None:
    writes: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        writes += guarded_writes(path, path.read_text(encoding="utf-8"), REQUESTS)

    assert writes == [], f"service_requests.status may only change in RequestStateMachine: {writes}"


def test_the_state_machine_itself_is_seen_writing() -> None:
    # The guard is not vacuous: it does see the one legitimate writer.
    source = REQUEST_STATE_MACHINE.read_text(encoding="utf-8")
    assert status_writes(source, "state_machine.py", REQUESTS) != []


PLANTED = {
    "attribute": "def f(request) -> None:\n    request.status = 'accepted'\n",
    "update_values": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "statement = update(ServiceRequest).values(status='accepted')\n"
    ),
    "aliased_class": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest as Row\n"
        "statement = update(Row).where(Row.id == 1).values({Row.status: 'expired'})\n"
    ),
    "module_attribute": (
        "from sqlalchemy import update\n"
        "from app.modules.requests import models\n"
        "statement = update(models.ServiceRequest).values(status='expired')\n"
    ),
    "table_method": (
        "from app.modules.requests.models import ServiceRequest\n"
        "statement = ServiceRequest.__table__.update().values(status='cancelled')\n"
    ),
    "lightweight_table": (
        "import sqlalchemy as sa\n"
        "requests = sa.table('service_requests', sa.column('status'))\n"
        "statement = sa.update(requests).values(status='cancelled')\n"
    ),
    "constructor": (
        "from app.modules.requests.models import ServiceRequest\n"
        "request = ServiceRequest(customer_id=1, status='accepted')\n"
    ),
    "orm_bulk_update": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, rows) -> None:\n"
        "    await session.execute(update(ServiceRequest), rows)\n"
    ),
    # Review round 2 (Vault V1): bulk parameters by keyword, and other executors.
    "execute_params_keyword": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, connection, rows) -> None:\n"
        "    await session.execute(update(ServiceRequest), params=rows)\n"
    ),
    "execute_statement_and_params_keywords": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, connection, rows) -> None:\n"
        "    await session.execute(statement=update(ServiceRequest), params=rows)\n"
    ),
    "scalars_bulk": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, connection, rows) -> None:\n"
        "    await session.scalars(update(ServiceRequest).returning(ServiceRequest.id), rows)\n"
    ),
    "scalar_params_keyword": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, connection, rows) -> None:\n"
        "    await session.scalar(update(ServiceRequest), params=rows)\n"
    ),
    "stream_bulk": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, connection, rows) -> None:\n"
        "    await session.stream(update(ServiceRequest), rows)\n"
    ),
    "connection_execute": (
        "from sqlalchemy import update\n"
        "from app.modules.requests.models import ServiceRequest\n"
        "async def f(session, connection, rows) -> None:\n"
        "    await connection.execute(update(ServiceRequest), params=rows)\n"
    ),
    "raw_sql": "statement = 'UPDATE service_requests SET status = :s WHERE id = :id'\n",
}


@pytest.mark.parametrize("name", PLANTED)
def test_guard_detects_a_planted_request_status_write(name: str) -> None:
    assert status_writes(PLANTED[name], f"planted_{name}.py", REQUESTS) != []


@pytest.mark.parametrize(
    "source",
    [
        "def f(request):\n    return request.status\n",
        "from sqlalchemy import select\nfrom app.modules.requests.models import ServiceRequest\n"
        "statement = select(ServiceRequest).where(ServiceRequest.status == 'received')\n",
        # How POST /v1/requests creates one: the default status (received).
        "from app.modules.requests.models import ServiceRequest\n"
        "request = ServiceRequest(customer_id=1, description='x')\n",
        "statement = 'SELECT status FROM service_requests WHERE id = :id'\n",
        # A job's statement is the jobs guard's business, not this one's.
        "from sqlalchemy import update\nfrom app.modules.jobs.models import Job\n"
        "statement = update(Job).values(status='confirmed')\n",
    ],
    ids=["read", "query_filter", "default_status", "select", "jobs_table"],
)
def test_guard_ignores_reads_and_other_writes(source: str) -> None:
    assert status_writes(source, "allowed.py", REQUESTS, attributes=False) == []


# Review round 1 (#162): the other state machine's file is no blind spot.
FOREIGN_REQUEST_WRITES = {
    "attribute": "request.status = 'accepted'",
    "setattr": "setattr(request, 'status', 'accepted')",
}


@pytest.mark.parametrize("body", FOREIGN_REQUEST_WRITES.values(), ids=list(FOREIGN_REQUEST_WRITES))
def test_a_request_status_write_in_the_jobs_machine_is_caught(body: str) -> None:
    assert guarded_writes(STATE_MACHINE, planted(STATE_MACHINE, body), REQUESTS) != []


@pytest.mark.parametrize("body", FOREIGN_REQUEST_WRITES.values(), ids=list(FOREIGN_REQUEST_WRITES))
def test_a_second_write_in_the_request_machine_is_caught(body: str) -> None:
    source = planted(REQUEST_STATE_MACHINE, body)
    assert guarded_writes(REQUEST_STATE_MACHINE, source, REQUESTS) != []


def test_a_literal_update_of_another_column_is_flagged_since_round_4() -> None:
    # Allowed until round 3; strict since (Cesar): any construction on the model is flagged.
    source = (
        "from sqlalchemy import update\nfrom app.modules.requests.models import ServiceRequest\n"
        "statement = update(ServiceRequest).values(description='x')\n"
    )
    assert status_writes(source, "strict.py", REQUESTS) != []
