"""jobs.status is written only by JobStateMachine (app/modules/jobs/service.py) (#60, AGENTS.md).

An AST scan of app/ flags, outside that file:
- in a module that imports the jobs models: `<x>.status = ...` and `setattr(<x>, "status", ...)`;
- anywhere: `update(Job)` / `insert(Job)` with a status value, `Job(..., status=...)`, and raw
  SQL that updates the jobs table's status.
"""

import ast
import re
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1] / "app"
STATE_MACHINE = APP_DIR / "modules" / "jobs" / "service.py"
JOBS_MODELS = "app.modules.jobs.models"
_RAW_SQL_STATUS_UPDATE = re.compile(r"update\s+jobs\b.*\bset\b.*\bstatus\b", re.I | re.S)


def _imports_jobs_models(tree: ast.Module) -> bool:
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in (JOBS_MODELS, "app.modules.jobs"):
            return True
        if isinstance(node, ast.Import) and any(a.name == JOBS_MODELS for a in node.names):
            return True
    return False


def _called_name(call: ast.Call) -> str | None:
    """`update` for both `update(...)` and `sa.update(...)`."""
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _is_job_statement(node: ast.AST) -> bool:
    """`update(Job)` or `insert(Job)` somewhere in a call chain."""
    while isinstance(node, ast.Call | ast.Attribute):
        if (
            isinstance(node, ast.Call)
            and _called_name(node) in ("update", "insert")
            and any(isinstance(arg, ast.Name) and arg.id == "Job" for arg in node.args)
        ):
            return True
        node = node.func if isinstance(node, ast.Call) else node.value
    return False


def _sets_status(call: ast.Call) -> bool:
    if any(keyword.arg == "status" for keyword in call.keywords):
        return True
    return any(
        isinstance(arg, ast.Dict)
        and any(isinstance(k, ast.Constant) and k.value == "status" for k in arg.keys)
        for arg in call.args
    )


def status_writes(source: str, path: str) -> list[str]:
    """Every place in `source` that writes a job's status, as "path:line"."""
    tree = ast.parse(source)
    jobs_module = _imports_jobs_models(tree)
    found: list[int] = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AugAssign | ast.AnnAssign):
            targets = [node.target]
        if jobs_module and any(
            isinstance(t, ast.Attribute) and t.attr == "status" for t in targets
        ):
            found.append(line)
        if not isinstance(node, ast.Call):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and _RAW_SQL_STATUS_UPDATE.search(node.value)
            ):
                found.append(line)
            continue
        func = node.func
        if (
            jobs_module
            and isinstance(func, ast.Name)
            and func.id == "setattr"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value == "status"
        ):
            found.append(line)
        if isinstance(func, ast.Name) and func.id == "Job" and _sets_status(node):
            found.append(line)
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "values"
            and _is_job_statement(func.value)
            and _sets_status(node)
        ):
            found.append(line)
    return [f"{path}:{line}" for line in sorted(set(found))]


def test_no_status_assignment_outside_state_machine() -> None:
    writes: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path == STATE_MACHINE:
            continue
        relative = path.relative_to(APP_DIR.parent).as_posix()
        writes += status_writes(path.read_text(encoding="utf-8"), relative)

    assert writes == [], f"jobs.status may only change in JobStateMachine: {writes}"


def test_the_state_machine_itself_is_seen_writing() -> None:
    # The guard is not vacuous: it does see the one legitimate writer.
    assert status_writes(STATE_MACHINE.read_text(encoding="utf-8"), "service.py") != []


PLANTED = {
    "attribute": (
        "from app.modules.jobs.models import Job, JobStatus\n"
        "def f(job: Job) -> None:\n"
        "    job.status = JobStatus.CONFIRMED\n"
    ),
    "annotated_attribute": (
        "from app.modules.jobs.models import JobStatus\n"
        "def f(job) -> None:\n"
        "    job.status: JobStatus = JobStatus.PAID_OUT\n"
    ),
    "setattr": (
        "from app.modules.jobs.models import JobStatus\n"
        "def f(job) -> None:\n"
        '    setattr(job, "status", JobStatus.REFUNDED)\n'
    ),
    "update_values_keyword": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        'statement = update(Job).where(Job.id == 1).values(status="paid_out")\n'
    ),
    "update_values_dict": (
        "import sqlalchemy as sa\n"
        "from app.modules.jobs.models import Job\n"
        'statement = sa.update(Job).values({"status": "paid_out"})\n'
    ),
    "insert_values": (
        "from sqlalchemy.dialects.postgresql import insert\n"
        "from app.modules.jobs.models import Job\n"
        'statement = insert(Job).values(status="confirmed")\n'
    ),
    "constructor": (
        "from app.modules.jobs.models import Job, JobStatus\n"
        "job = Job(request_id=1, status=JobStatus.CONFIRMED)\n"
    ),
    "raw_sql": (
        "from sqlalchemy import text\n"
        "statement = text(\"UPDATE jobs SET status = 'paid_out' WHERE id = :id\")\n"
    ),
}


@pytest.mark.parametrize("name", PLANTED)
def test_guard_detects_a_planted_assignment(name: str) -> None:
    assert status_writes(PLANTED[name], f"planted_{name}.py") != []


@pytest.mark.parametrize(
    "source",
    [
        # Another model's status, in a module that knows nothing of jobs.
        "from app.modules.users.models import User\ndef f(user):\n    user.status = 'suspended'\n",
        # Reading a job's status is fine.
        "from app.modules.jobs.models import Job\ndef f(job: Job):\n    return job.status\n",
        # Comparing in a query is fine.
        "from sqlalchemy import select\nfrom app.modules.jobs.models import Job\n"
        "statement = select(Job).where(Job.status == 'confirmed')\n",
    ],
    ids=["other_model", "read", "query_filter"],
)
def test_guard_ignores_reads_and_other_models(source: str) -> None:
    assert status_writes(source, "allowed.py") == []
