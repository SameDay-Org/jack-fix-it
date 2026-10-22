"""service_requests.status is written only by RequestStateMachine (#160, AGENTS.md).

The scanner of test_job_status_single_writer.py, pointed at ServiceRequest and its table: every
`<x>.status = ...` and setattr outside the two state machines, and any statement, constructor
or raw SQL that sets a request's status outside requests/state_machine.py.
"""

import pytest

from tests.test_job_status_single_writer import (
    APP_DIR,
    REQUEST_STATE_MACHINE,
    STATUS_WRITERS,
    StatusModel,
    status_writes,
)

REQUESTS = StatusModel(
    model="ServiceRequest", package="app.modules.requests", table="service_requests"
)


def test_only_the_state_machine_writes_request_status() -> None:
    writes: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path == REQUEST_STATE_MACHINE:
            continue
        relative = path.relative_to(APP_DIR.parent).as_posix()
        # The jobs' state machine may assign its own `.status`, never a request's.
        writes += status_writes(
            path.read_text(encoding="utf-8"),
            relative,
            REQUESTS,
            attributes=path not in STATUS_WRITERS,
        )

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
        "from sqlalchemy import update\nfrom app.modules.requests.models import ServiceRequest\n"
        "statement = update(ServiceRequest).values(description='x')\n",
        "statement = 'SELECT status FROM service_requests WHERE id = :id'\n",
        # A job's statement is the jobs guard's business, not this one's.
        "from sqlalchemy import update\nfrom app.modules.jobs.models import Job\n"
        "statement = update(Job).values(status='confirmed')\n",
    ],
    ids=["read", "query_filter", "default_status", "other_column", "select", "jobs_table"],
)
def test_guard_ignores_reads_and_other_writes(source: str) -> None:
    assert status_writes(source, "allowed.py", REQUESTS, attributes=False) == []
