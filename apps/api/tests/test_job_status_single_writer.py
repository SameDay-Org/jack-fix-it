"""jobs.status is written only by JobStateMachine (app/modules/jobs/service.py) (#60, AGENTS.md).

An AST scan of app/ flags, outside STATUS_WRITERS:
- every `<x>.status = ...` (plain, annotated or augmented) and `setattr(<x>, "status", ...)`,
  whatever the module imports: callers reach jobs only through its service (ADR 0003) and get
  the ORM Job back, so an import-based filter would miss exactly them;
- a statement on Job (`update`/`insert` of Job, an alias or `models.Job`) that sets a status:
  `.values(status=...)`, `.values({"status": ...})`, `.values({Job.status: ...})`,
  `.values(**anything)`, `on_conflict_do_update(set_=...)` with a status or a non-literal
  `set_`, and ORM bulk updates `execute(update(Job), rows)`;
- `Job(status=...)` and `Job(**anything)`;
- raw SQL that updates the status of the jobs table (quoted or schema-qualified too).

Request statuses also change only through a state machine (AGENTS.md). A module that gets its
own state machine for another model's `status` is added to STATUS_WRITERS, with the reason.
"""

import ast
import re
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1] / "app"
STATE_MACHINE = APP_DIR / "modules" / "jobs" / "service.py"
# The only files allowed to write a `.status`, each with its reason.
STATUS_WRITERS = {
    STATE_MACHINE: "JobStateMachine, the single writer of jobs.status",
}
JOBS_MODELS = "app.modules.jobs.models"
_RAW_SQL_STATUS_UPDATE = re.compile(
    r"update\s+(?:\"?\w+\"?\.)?\"?jobs\"?\s.*\bset\b.*\bstatus\b", re.I | re.S
)


def _job_names(tree: ast.Module) -> tuple[set[str], set[str]]:
    """Local names bound to the Job model, and to the jobs models module."""
    classes, modules = {"Job"}, set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == JOBS_MODELS:
            classes |= {a.asname or a.name for a in node.names if a.name == "Job"}
        elif isinstance(node, ast.ImportFrom) and node.module == "app.modules.jobs":
            modules |= {a.asname or a.name for a in node.names if a.name == "models"}
        elif isinstance(node, ast.Import):
            modules |= {a.asname or a.name for a in node.names if a.name == JOBS_MODELS}
    return classes, modules


def _called_name(call: ast.Call) -> str | None:
    """`update` for both `update(...)` and `sa.update(...)`."""
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


class _Scanner:
    def __init__(self, tree: ast.Module) -> None:
        self.job_classes, self.job_modules = _job_names(tree)

    def is_job(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Name):
            return node.id in self.job_classes
        # models.Job, or app.modules.jobs.models.Job.
        return isinstance(node, ast.Attribute) and node.attr == "Job"

    def is_job_statement(self, node: ast.AST) -> bool:
        """`update(Job)` or `insert(Job)` somewhere in a call chain."""
        while isinstance(node, ast.Call | ast.Attribute):
            if (
                isinstance(node, ast.Call)
                and _called_name(node) in ("update", "insert")
                and any(self.is_job(arg) for arg in node.args)
            ):
                return True
            node = node.func if isinstance(node, ast.Call) else node.value
        return False


def _is_status_key(key: ast.expr | None) -> bool:
    if isinstance(key, ast.Constant):
        return key.value == "status"
    return isinstance(key, ast.Attribute) and key.attr == "status"


def _sets_status(call: ast.Call) -> bool:
    """A status keyword or dict key, or anything opaque (`**x`) that could hold one."""
    if any(keyword.arg in ("status", None) for keyword in call.keywords):
        return True
    for arg in call.args:
        if isinstance(arg, ast.Dict):
            # A None key is `**mapping` inside the literal: opaque.
            if any(key is None or _is_status_key(key) for key in arg.keys):
                return True
        else:
            return True
    return False


def status_writes(source: str, path: str) -> list[str]:
    """Every place in `source` that writes a status, as "path:line"."""
    tree = ast.parse(source)
    scanner = _Scanner(tree)
    found: list[int] = []
    for node in ast.walk(tree):
        line = getattr(node, "lineno", 0)
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AugAssign | ast.AnnAssign):
            targets = [node.target]
        if any(isinstance(t, ast.Attribute) and t.attr == "status" for t in targets):
            found.append(line)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if _RAW_SQL_STATUS_UPDATE.search(node.value):
                found.append(line)
            continue
        if not isinstance(node, ast.Call):
            continue
        name = _called_name(node)
        if (
            name == "setattr"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value == "status"
        ):
            found.append(line)
        if scanner.is_job(node.func) and any(
            keyword.arg in ("status", None) for keyword in node.keywords
        ):
            found.append(line)
        receiver = node.func.value if isinstance(node.func, ast.Attribute) else None
        if (
            name == "values"
            and receiver is not None
            and scanner.is_job_statement(receiver)
            and _sets_status(node)
        ):
            found.append(line)
        if (
            name == "on_conflict_do_update"
            and receiver is not None
            and scanner.is_job_statement(receiver)
        ):
            set_ = next((k.value for k in node.keywords if k.arg == "set_"), None)
            if (
                set_ is None
                or not isinstance(set_, ast.Dict)
                or any(key is None or _is_status_key(key) for key in set_.keys)
            ):
                found.append(line)
        # ORM bulk UPDATE by primary key: execute(update(Job), [{"id": ..., "status": ...}]).
        if (
            name == "execute"
            and len(node.args) >= 2
            and isinstance(node.args[0], ast.Call)
            and _called_name(node.args[0]) == "update"
            and any(scanner.is_job(arg) for arg in node.args[0].args)
        ):
            found.append(line)
    return [f"{path}:{line}" for line in sorted(set(found))]


def test_no_status_assignment_outside_state_machine() -> None:
    writes: list[str] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        if path in STATUS_WRITERS:
            continue
        relative = path.relative_to(APP_DIR.parent).as_posix()
        writes += status_writes(path.read_text(encoding="utf-8"), relative)

    assert writes == [], f"jobs.status may only change in JobStateMachine: {writes}"


def test_the_state_machine_itself_is_seen_writing() -> None:
    # The guard is not vacuous: it does see the one legitimate writer.
    assert status_writes(STATE_MACHINE.read_text(encoding="utf-8"), "service.py") != []


PLANTED = {
    # A caller of the state machine that only imports its service and transitions.
    "after_transition": (
        "from app.modules.jobs.service import JobStateMachine\n"
        "from app.modules.jobs.models import JobStatus\n"
        "async def f(machine: JobStateMachine, job_id, admin) -> None:\n"
        "    job = await machine.transition(job_id, JobStatus.PAID_OUT, admin)\n"
        "    job.status = JobStatus.REFUNDED\n"
    ),
    "attribute_without_jobs_import": "def f(job) -> None:\n    job.status = 'confirmed'\n",
    "annotated_attribute": "def f(job) -> None:\n    job.status: str = 'paid_out'\n",
    "setattr": "def f(job) -> None:\n    setattr(job, 'status', 'refunded')\n",
    "update_values_keyword": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "statement = update(Job).where(Job.id == 1).values(status='paid_out')\n"
    ),
    "update_values_dict": (
        "import sqlalchemy as sa\n"
        "from app.modules.jobs.models import Job\n"
        "statement = sa.update(Job).values({'status': 'paid_out'})\n"
    ),
    "update_values_column_key": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job, JobStatus\n"
        "statement = update(Job).where(Job.id == 1).values({Job.status: JobStatus.CONFIRMED})\n"
    ),
    "update_values_kwargs": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "statement = update(Job).values(**changes)\n"
    ),
    "orm_bulk_update": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "async def f(session, ids) -> None:\n"
        "    await session.execute(update(Job), [{'id': i, 'status': 'confirmed'} for i in ids])\n"
    ),
    "aliased_class": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job as JobRow\n"
        "statement = update(JobRow).values(status='confirmed')\n"
    ),
    "module_attribute": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs import models\n"
        "statement = update(models.Job).values(status='confirmed')\n"
    ),
    "insert_values": (
        "from sqlalchemy.dialects.postgresql import insert\n"
        "from app.modules.jobs.models import Job\n"
        "statement = insert(Job).values(status='confirmed')\n"
    ),
    "on_conflict_do_update": (
        "from sqlalchemy.dialects.postgresql import insert\n"
        "from app.modules.jobs.models import Job\n"
        "statement = insert(Job).values(id=1).on_conflict_do_update(\n"
        "    index_elements=[Job.id], set_={'status': 'confirmed'}\n"
        ")\n"
    ),
    "constructor": (
        "from app.modules.jobs.models import Job, JobStatus\n"
        "job = Job(request_id=1, status=JobStatus.CONFIRMED)\n"
    ),
    "constructor_kwargs": ("from app.modules.jobs.models import Job\njob = Job(**data)\n"),
    "raw_sql": "statement = \"UPDATE jobs SET status = 'paid_out' WHERE id = :id\"\n",
    "raw_sql_quoted": "statement = 'update \"jobs\" set status = :s'\n",
    "raw_sql_schema": "statement = 'UPDATE public.jobs\\n   SET status = :s'\n",
}


@pytest.mark.parametrize("name", PLANTED)
def test_guard_detects_a_planted_assignment(name: str) -> None:
    assert status_writes(PLANTED[name], f"planted_{name}.py") != []


@pytest.mark.parametrize(
    "source",
    [
        # Reading a job's status is fine.
        "from app.modules.jobs.models import Job\ndef f(job: Job):\n    return job.status\n",
        # Filtering on it in a query is fine.
        "from sqlalchemy import select\nfrom app.modules.jobs.models import Job\n"
        "statement = select(Job).where(Job.status == 'confirmed')\n",
        # Updating other columns of a job is not a status write.
        "from sqlalchemy import update\nfrom app.modules.jobs.models import Job\n"
        "statement = update(Job).where(Job.id == 1).values(started_at=None)\n",
        # Creating a job with the default status.
        "from app.modules.jobs.models import Job\njob = Job(request_id=1, quote_id=2)\n",
        # Raw SQL on another table, or reading jobs.
        "statement = 'UPDATE jobs_archive SET status = :s'\n",
        "statement = 'SELECT status FROM jobs WHERE id = :id'\n",
    ],
    ids=["read", "query_filter", "other_columns", "default_status", "other_table", "select"],
)
def test_guard_ignores_reads_and_other_writes(source: str) -> None:
    assert status_writes(source, "allowed.py") == []
