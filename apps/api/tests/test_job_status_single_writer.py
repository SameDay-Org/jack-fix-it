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


def _assigned_names(target: ast.expr) -> list[ast.expr]:
    """The leaves of an assignment target: `a, (b, *c) = ...` gives a, b and c."""
    if isinstance(target, ast.Tuple | ast.List):
        return [leaf for element in target.elts for leaf in _assigned_names(element)]
    if isinstance(target, ast.Starred):
        return _assigned_names(target.value)
    return [target]


def _assignments(tree: ast.Module) -> list[tuple[list[ast.expr], ast.expr]]:
    pairs: list[tuple[list[ast.expr], ast.expr]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            pairs.append(([leaf for t in node.targets for leaf in _assigned_names(t)], node.value))
        elif isinstance(node, ast.AnnAssign | ast.NamedExpr) and node.value is not None:
            pairs.append(([node.target], node.value))
    return pairs


class _Scanner:
    """Knows which local names stand for the Job model or table, or a statement on it."""

    def __init__(self, tree: ast.Module) -> None:
        self.job_classes, self.job_modules = _job_names(tree)
        self.job_statements: set[str] = set()
        # Bind names until nothing changes: `t = Job.__table__`, `s = update(t)`, `s = s.where()`.
        assignments = _assignments(tree)
        changed = True
        while changed:
            changed = False
            for targets, value in assignments:
                names = {t.id for t in targets if isinstance(t, ast.Name)}
                if len(targets) != 1 or not names:
                    continue
                if self.is_job(value) and not names <= self.job_classes:
                    self.job_classes |= names
                    changed = True
                elif self.is_job_statement(value) and not names <= self.job_statements:
                    self.job_statements |= names
                    changed = True

    def is_job(self, node: ast.expr) -> bool:
        """Job, an alias of it, models.Job, Job.__table__, or a Table/table named "jobs"."""
        if isinstance(node, ast.Name):
            return node.id in self.job_classes
        if isinstance(node, ast.Attribute):
            if node.attr == "Job":
                return True
            if node.attr == "__table__":
                return self.is_job(node.value)
        return (
            isinstance(node, ast.Call)
            and _called_name(node) in ("Table", "table")
            and bool(node.args)
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "jobs"
        )

    def is_job_statement(self, node: ast.AST) -> bool:
        """A DML statement on the jobs table, or a name bound to one, anywhere in a call chain.

        Function forms: `update(Job)`, `insert(Job.__table__)`. Table method forms:
        `Job.__table__.update()`, `jobs.insert()`, `table("jobs").delete()`, for any receiver
        is_job() recognizes.
        """
        while isinstance(node, ast.Call | ast.Attribute | ast.Name):
            if isinstance(node, ast.Name):
                return node.id in self.job_statements
            if isinstance(node, ast.Call) and self._is_job_dml(node):
                return True
            node = node.func if isinstance(node, ast.Call) else node.value
        return False

    def _is_job_dml(self, call: ast.Call) -> bool:
        if _called_name(call) not in ("update", "insert", "delete"):
            return False
        if any(self.is_job(arg) for arg in call.args):
            return True
        return isinstance(call.func, ast.Attribute) and self.is_job(call.func.value)


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
            targets = [leaf for target in node.targets for leaf in _assigned_names(target)]
        elif isinstance(node, ast.AugAssign | ast.AnnAssign):
            targets = [node.target]
        elif isinstance(node, ast.For | ast.AsyncFor | ast.withitem):
            loop_target = (
                node.target if isinstance(node, ast.For | ast.AsyncFor) else node.optional_vars
            )
            targets = _assigned_names(loop_target) if loop_target is not None else []
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
        # ORM bulk UPDATE by primary key: execute(update(Job), [{"id": ..., "status": ...}]),
        # also through a name bound to the statement. The parameters are opaque here.
        if name == "execute" and len(node.args) >= 2 and scanner.is_job_statement(node.args[0]):
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
    # Review round 1: statements bound to names, the table object, destructuring.
    "reassigned_statement": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "statement = update(Job).where(Job.id == 1)\n"
        "statement = statement.values(status='paid_out')\n"
    ),
    "reassigned_through_returning": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "base = update(Job)\n"
        "scoped = base.where(Job.id == 1).returning(Job.id)\n"
        "final = scoped.values({'status': 'paid_out'})\n"
    ),
    "values_then_where": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "statement = update(Job).values(status='paid_out').where(Job.id == 1)\n"
    ),
    "table_object": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "statement = update(Job.__table__).values(status='paid_out')\n"
    ),
    "table_alias": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "jobs_table = Job.__table__\n"
        "statement = update(jobs_table).where(jobs_table.c.id == 1).values(status='paid_out')\n"
    ),
    "lightweight_table": (
        "import sqlalchemy as sa\n"
        "jobs = sa.table('jobs', sa.column('id'), sa.column('status'))\n"
        "statement = sa.update(jobs).values(status='paid_out')\n"
    ),
    "named_bulk_execute": (
        "from sqlalchemy import update\n"
        "from app.modules.jobs.models import Job\n"
        "async def f(session, rows) -> None:\n"
        "    statement = update(Job)\n"
        "    await session.execute(statement, rows)\n"
    ),
    "tuple_target": (
        "from app.modules.jobs.models import JobStatus\n"
        "def f(job) -> None:\n"
        "    job.status, job.confirmed_at = JobStatus.CONFIRMED, None\n"
    ),
    "nested_and_starred_target": (
        "def f(job, other, values) -> None:\n"
        "    (other.note, (job.status, *_)) = values\n"
        "    first, *job.status = values\n"
    ),
    "for_target": ("def f(job, values) -> None:\n    for job.status in values:\n        pass\n"),
    # Review round 3 (Vault V1): Table method forms on the jobs table.
    "table_method_update": (
        "from app.modules.jobs.models import Job, JobStatus\n"
        "def f(job_id) -> None:\n"
        "    statement = (\n"
        "        Job.__table__.update().where(Job.id == job_id).values(status=JobStatus.PAID_OUT)\n"
        "    )\n"
    ),
    "table_alias_method_update": (
        "from app.modules.jobs.models import Job\n"
        "jobs = Job.__table__\n"
        "statement = jobs.update().values(status='paid_out')\n"
    ),
    "table_method_values_before_where": (
        "from app.modules.jobs.models import Job\n"
        "statement = Job.__table__.update().values(status='paid_out').where(Job.id == 1)\n"
    ),
    "table_method_bound_then_values": (
        "from app.modules.jobs.models import Job\n"
        "jobs = Job.__table__\n"
        "statement = jobs.update().where(jobs.c.id == 1)\n"
        "statement = statement.values({jobs.c.status: 'paid_out'})\n"
    ),
    "table_method_bulk_execute": (
        "from app.modules.jobs.models import Job\n"
        "async def f(session) -> None:\n"
        "    jobs = Job.__table__\n"
        "    await session.execute(jobs.update(), [{'id': 1, 'status': 'paid_out'}])\n"
    ),
    "table_method_insert": (
        "from app.modules.jobs.models import Job\n"
        "statement = Job.__table__.insert().values(status='confirmed')\n"
    ),
    "module_table_method": (
        "from app.modules.jobs import models\n"
        "statement = models.Job.__table__.update().values(status='paid_out')\n"
    ),
    "lightweight_table_method": (
        "import sqlalchemy as sa\n"
        "statement = sa.table('jobs', sa.column('status')).update().values(status='paid_out')\n"
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
        (
            "from sqlalchemy import update\n"
            "from app.modules.jobs.models import Job\n"
            "statement = update(Job).where(Job.id == 1)\n"
            "statement = statement.values(started_at=None)\n"
        ),
        (
            "from sqlalchemy import update\n"
            "from app.modules.users.models import User\n"
            "statement = update(User.__table__).values(locale='es')\n"
        ),
        ("def f(job, values) -> None:\n    job.started_at, job.completed_at = values\n"),
        (
            "from app.modules.jobs.models import Job\n"
            "statement = Job.__table__.update().where(Job.id == 1).values(started_at=None)\n"
        ),
        (
            "from app.modules.jobs.models import Job\n"
            "statement = Job.__table__.delete().where(Job.id == 1)\n"
        ),
        (
            "from app.modules.users.models import User\n"
            "statement = User.__table__.update().values(status='suspended')\n"
        ),
    ],
    ids=[
        "read",
        "query_filter",
        "other_columns",
        "default_status",
        "other_table",
        "select",
        "other_columns_reassigned",
        "other_table_object",
        "tuple_without_status",
        "table_method_other_column",
        "table_method_delete",
        "other_table_method",
    ],
)
def test_guard_ignores_reads_and_other_writes(source: str) -> None:
    assert status_writes(source, "allowed.py") == []
