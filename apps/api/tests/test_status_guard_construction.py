"""Review round 3 (#162): the guards judge how a statement on a guarded model is built, not
which executor runs it. Cases for both models, through the shared scanner."""

import inspect

import pytest
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from tests.test_job_status_single_writer import JOBS, REQUESTS, StatusModel, status_writes

MODELS = pytest.mark.parametrize("target", [JOBS, REQUESTS], ids=["jobs", "requests"])
EXECUTORS = ["execute", "scalars", "scalar", "stream", "stream_scalars"]


def module(target: StatusModel, body: str) -> str:
    return (
        "from sqlalchemy import bindparam, delete, insert, update\n"
        f"from {target.models_module} import {target.model}\n"
        f"Model = {target.model}\n"
        "async def write(session, connection, rows, helper) -> None:\n"
        + "".join(f"    {line}\n" for line in body.splitlines())
    )


def flagged(target: StatusModel, body: str) -> bool:
    return bool(status_writes(module(target, body), "planted.py", target))


@MODELS
@pytest.mark.parametrize("executor", EXECUTORS)
@pytest.mark.parametrize("named", [False, True], ids=["positional", "statement="])
def test_connection_parameters_keyword_is_caught(
    target: StatusModel, executor: str, named: bool
) -> None:
    # The Gatekeeper's 20 cases, with the real AsyncConnection keyword.
    assert "parameters" in inspect.signature(getattr(AsyncConnection, executor)).parameters
    statement = "statement=stmt" if named else "stmt"
    body = (
        f"stmt = update({target.model}).where({target.model}.id == bindparam('rid'))"
        f".returning({target.model}.id)\n"
        f"await connection.{executor}({statement}, parameters=rows)"
    )
    assert flagged(target, body)


@MODELS
@pytest.mark.parametrize("executor", EXECUTORS)
def test_session_params_keyword_is_caught(target: StatusModel, executor: str) -> None:
    assert "params" in inspect.signature(getattr(AsyncSession, executor)).parameters
    assert flagged(target, f"await session.{executor}(update({target.model}), params=rows)")


@MODELS
@pytest.mark.parametrize(
    "body",
    [
        # Whatever runs it: run_sync, a helper of ours, a list handed on.
        "stmt = update(Model)\nawait connection.run_sync(lambda sync: sync.execute(stmt, rows))",
        "stmt = update(Model)\nawait helper(stmt, rows)",
        "statements = [update(Model)]\nawait helper(statements)",
        "await helper(update(Model).where(Model.id == 1))",
        # SET clauses that do not prove status stays out.
        "stmt = update(Model).values(**rows)",
        "stmt = update(Model).values(rows)",
        "stmt = update(Model).ordered_values(('status', 'accepted'))",
        "stmt = update(Model).values(next_action='x').values(status='accepted')",
        "stmt = Model.__table__.update().where(Model.id == 1)",
        # Inserts with a status, non-literal keys, or bulk rows at execution.
        "stmt = insert(Model)",
        "stmt = insert(Model).values(status='accepted')",
        "stmt = insert(Model).values(rows)",
        "stmt = insert(Model).values(**rows)",
        # ORM bulk writes, and setattr with a name we cannot read.
        "session.bulk_update_mappings(Model, rows)",
        "session.bulk_insert_mappings(Model, rows)",
        "session.bulk_save_objects(rows)",
        "setattr(rows[0], helper, 'accepted')",
        # Raw SQL inserting a status.
        "await session.execute('INSERT INTO TABLE_NAME (id, status) VALUES (:id, :s)')",
    ],
    ids=[
        "run_sync",
        "helper",
        "list",
        "helper_inline",
        "values_kwargs",
        "values_mapping",
        "ordered_values",
        "second_values_with_status",
        "table_method_bare",
        "insert_bare",
        "insert_status",
        "insert_rows",
        "insert_kwargs",
        "bulk_update_mappings",
        "bulk_insert_mappings",
        "bulk_save_objects",
        "setattr_dynamic",
        "raw_sql_insert",
    ],
)
def test_construction_is_caught_whatever_runs_it(target: StatusModel, body: str) -> None:
    assert flagged(target, body.replace("TABLE_NAME", target.table))


@MODELS
def test_literal_values_with_parameters_are_caught(target: StatusModel) -> None:
    # Execution parameters add their keys to the SET clause, even after a literal .values().
    body = "stmt = update(Model).values(next_action='x')\nawait connection.execute(stmt, rows)"
    assert flagged(target, body)


@MODELS
def test_setattr_of_another_literal_attribute_is_allowed(target: StatusModel) -> None:
    assert not flagged(target, "setattr(rows[0], 'next_action', 'x')")


@MODELS
@pytest.mark.parametrize(
    "body",
    [
        "await session.execute(update(Model).where(Model.id == 1).values(next_action='x'))",
        "await session.execute(insert(Model).values(description='d', customer_id=1))",
        "await session.execute(Model.__table__.update().where(Model.id == 1).values(note='x'))",
        "await session.execute(delete(Model).where(Model.id == 1))",
    ],
    ids=["update_literal_values", "insert_literal_values", "table_method_literal", "delete"],
)
def test_any_construction_is_flagged_since_round_4(target: StatusModel, body: str) -> None:
    # Allowed in round 3 (literal values without status); Cesar chose strict in round 4: a
    # legitimate one gets an ALLOW_LIST entry with its reason.
    assert flagged(target, body)


# Review round 4 (Cesar: strict). A literal .values() reached execution through a carrier the
# scanner cannot follow, with parameters adding status: the construction itself is flagged.
INDIRECT = {
    "helper_return": (
        "def build_statement():\n"
        "    return update(Model).where(Model.id == bindparam('rid'))"
        ".values(next_action='x').returning(Model.id)\n"
        "async def write(connection, rows):\n"
        "    await connection.execute(build_statement(), parameters=rows)\n"
    ),
    "container": (
        "async def write(connection, rows):\n"
        "    statements = [update(Model).where(Model.id == bindparam('rid'))"
        ".values(next_action='x').returning(Model.id)]\n"
        "    await connection.execute(statements[0], parameters=rows)\n"
    ),
    "run_sync_helper": (
        "def build_statement():\n"
        "    return update(Model).values(next_action='x')\n"
        "async def write(connection, rows):\n"
        "    await connection.run_sync(\n"
        "        lambda sync: sync.execute(build_statement(), parameters=rows)\n"
        "    )\n"
    ),
}


@MODELS
@pytest.mark.parametrize("kind", INDIRECT)
def test_indirect_literal_construction_is_caught(target: StatusModel, kind: str) -> None:
    source = (
        "from sqlalchemy import bindparam, update\n"
        f"from {target.models_module} import {target.model}\n"
        f"Model = {target.model}\n" + INDIRECT[kind]
    )
    assert status_writes(source, "planted.py", target), kind
