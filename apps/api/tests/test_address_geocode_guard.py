"""A request's address is never edited, so its point never goes stale (#384).

Geocode on save places an `addresses` row once and keeps the point for good. That is right
only while nothing changes the row's street, city, state or ZIP: an edit would leave the old
point under a new text, and the route would lead the pro to the old place. Nothing edits one
today (POST /v1/requests makes the row; the address book is another table). This scan fails
the day something does, so the edit is written to clear `lat`/`lng` in the same write (and
queue a new geocode), and this file is updated with it.

What it looks for in app/ and scripts/:

- an assignment to `.line1`, `.city`, `.state` or `.zip_code` of anything, outside
  SavedAddressService.update (which edits an address book entry, a `saved_addresses` row);
- a `setattr` with one of those names, or with a name that is not a literal, in a file that
  names the Address model;
- an UPDATE of `addresses` (the ORM's `update(Address)`, the table's `.update()`, or SQL
  text), outside AddressRepository.set_point, which may set `lat` and `lng` and nothing else.

A tripwire for accidents in this codebase, like the status guard's scan
(tests/test_job_status_single_writer.py); not a boundary against code written to dodge it.
"""

import ast
import re
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
SCANNED = (API_DIR / "app", API_DIR / "scripts")
ADDRESSES = "app/modules/addresses"
PLACE_FIELDS = frozenset({"line1", "city", "state", "zip_code"})
POINT_FIELDS = frozenset({"lat", "lng"})
MODEL = "Address"
# (file, function): the only code that may assign a place field, and the only UPDATE.
BOOK_EDIT = (f"{ADDRESSES}/service.py", "SavedAddressService.update")
POINT_WRITE = (f"{ADDRESSES}/repository.py", "AddressRepository.set_point")
_SQL_UPDATE = re.compile(r"\bupdate\s+(?:only\s+)?\"?addresses\"?\b", re.IGNORECASE)


def _qualified_names(tree: ast.Module) -> dict[ast.AST, str]:
    """Each node's enclosing function, as `Class.function` (the module's own code: "")."""
    names: dict[ast.AST, str] = {}

    def walk(node: ast.AST, scope: tuple[str, ...]) -> None:
        for child in ast.iter_child_nodes(node):
            inner = scope
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                inner = (*scope, child.name)
            names[child] = ".".join(inner)
            walk(child, inner)

    walk(tree, ())
    return names


def _model_aliases(tree: ast.Module) -> set[str]:
    """The names the Address model goes by in this file (`import ... Address as Row`)."""
    aliases = {MODEL}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            aliases |= {alias.asname or alias.name for alias in node.names if alias.name == MODEL}
    return aliases


def _names_model(node: ast.AST, aliases: set[str]) -> bool:
    return any(
        (isinstance(part, ast.Name) and part.id in aliases)
        or (isinstance(part, ast.Attribute) and part.attr == MODEL)
        for part in ast.walk(node)
    )


def _targets(node: ast.AST) -> list[ast.expr]:
    if isinstance(node, ast.Assign):
        found = list(node.targets)
    elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
        found = [node.target]
    else:
        return []
    flat: list[ast.expr] = []
    while found:
        target = found.pop()
        if isinstance(target, (ast.Tuple, ast.List)):
            found.extend(target.elts)
        else:
            flat.append(target.value if isinstance(target, ast.Starred) else target)
    return flat


def _call_name(call: ast.Call) -> str | None:
    function = call.func
    if isinstance(function, ast.Name):
        return function.id
    return function.attr if isinstance(function, ast.Attribute) else None


def _set_fields(call: ast.Call, tree: ast.Module) -> set[str] | None:
    """The columns the `.values(...)` chained on this update sets; None when it cannot be
    read (no .values, a mapping, **kwargs): then the statement counts as setting anything."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and _call_name(node) == "values"):
            continue
        if not any(part is call for part in ast.walk(node.func)):
            continue
        if node.args or any(keyword.arg is None for keyword in node.keywords):
            return None
        return {keyword.arg for keyword in node.keywords if keyword.arg is not None}
    return None


def findings(relative: str, source: str) -> list[str]:
    """Every write this scan refuses in one file, as `file:line function: what`."""
    tree = ast.parse(source)
    scope = _qualified_names(tree)
    aliases = _model_aliases(tree)
    mentions_model = _names_model(tree, aliases)
    found: list[str] = []

    def report(node: ast.AST, what: str) -> None:
        found.append(f"{relative}:{getattr(node, 'lineno', 0)} {scope.get(node, '')}: {what}")

    for node in ast.walk(tree):
        where = (relative, scope.get(node, ""))
        for target in _targets(node):
            if (
                isinstance(target, ast.Attribute)
                and target.attr in PLACE_FIELDS
                and where != BOOK_EDIT
            ):
                report(node, f"assigns .{target.attr}")
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and _SQL_UPDATE.search(node.value)
        ):
            report(node, "SQL text that updates addresses")
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node)
        if name == "setattr" and len(node.args) >= 2 and mentions_model:
            field = node.args[1]
            literal = field.value if isinstance(field, ast.Constant) else None
            if literal is None or literal in PLACE_FIELDS:
                report(node, "setattr of a place field, or of a name that is not a literal")
        if name in {"table", "Table"} and any(
            isinstance(argument, ast.Constant) and argument.value == "addresses"
            for argument in node.args
        ):
            # sa.table("addresses", ...): a way to the table around the model.
            report(node, "a table over addresses, apart from the model")
        if name != "update":
            continue
        # update(Address), update(models.Address), or Address.__table__.update().
        on_the_model = any(_names_model(argument, aliases) for argument in node.args) or (
            isinstance(node.func, ast.Attribute) and _names_model(node.func, aliases)
        )
        if not on_the_model:
            continue
        fields = _set_fields(node, tree)
        if where == POINT_WRITE and fields is not None and fields <= POINT_FIELDS:
            continue
        report(node, f"updates addresses (sets {sorted(fields) if fields else 'unknown'})")
    return found


def scanned_files() -> list[tuple[str, str]]:
    return [
        (path.relative_to(API_DIR).as_posix(), path.read_text(encoding="utf-8"))
        for root in SCANNED
        for path in sorted(root.rglob("*.py"))
    ]


def test_nothing_edits_the_place_of_a_request_address() -> None:
    writes = [
        finding for relative, source in scanned_files() for finding in findings(relative, source)
    ]

    assert writes == [], (
        "A request's address is never edited (#384). An edit of its street, city, state or ZIP "
        "must clear lat/lng in the same write and queue a new geocode; then update this scan: "
        f"{writes}"
    )


def test_the_scan_sees_the_two_writes_it_allows() -> None:
    """Not vacuous: without the two exemptions, the address book's edit and the point's
    write are both found."""
    sources = dict(scanned_files())
    book, _ = BOOK_EDIT
    repository, _ = POINT_WRITE

    as_other_code = findings("app/elsewhere.py", sources[book])
    assert {finding.split(": ", 1)[1] for finding in as_other_code} == {
        "assigns .line1",
        "assigns .city",
        "assigns .state",
        "assigns .zip_code",
    }
    assert all("SavedAddressService.update" in finding for finding in as_other_code)
    [point_write] = [
        finding
        for finding in findings("app/elsewhere.py", sources[repository])
        if "set_point" in finding
    ]
    assert point_write.endswith("updates addresses (sets ['lat', 'lng'])")


IMPORT = "from app.modules.addresses.models import Address\n"
PLANTED = {
    "attribute": "def edit(address, data) -> None:\n    address.line1 = data.line1\n",
    "attribute_zip": "def edit(address) -> None:\n    address.zip_code = '33301'\n",
    "tuple_target": "def edit(a, b) -> None:\n    a.city, a.state = b.city, b.state\n",
    "augmented": "def edit(a) -> None:\n    a.line1 += ' Apt 2'\n",
    "setattr_literal": IMPORT + "def edit(a: Address) -> None:\n    setattr(a, 'city', 'X')\n",
    "setattr_loop": (
        IMPORT
        + "def edit(a: Address, data: dict) -> None:\n"
        + "    for name, value in data.items():\n"
        + "        setattr(a, name, value)\n"
    ),
    "update_values": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "statement = update(Address).values(line1='1 Other Street')\n"
    ),
    "update_alias": (
        "from sqlalchemy import update\n"
        "from app.modules.addresses.models import Address as Row\n"
        "statement = update(Row).where(Row.id == 1).values({Row.city: 'X'})\n"
    ),
    "update_module_attribute": (
        "import sqlalchemy as sa\n"
        "from app.modules.addresses import models\n"
        "statement = sa.update(models.Address).values(zip_code='33301')\n"
    ),
    "update_point_elsewhere": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "statement = update(Address).values(lat=1, lng=2)\n"
    ),
    "table_method": IMPORT + "statement = Address.__table__.update().values(state='GA')\n",
    "lightweight_table": (
        "import sqlalchemy as sa\n"
        "rows = sa.table('addresses', sa.column('line1'))\n"
        "statement = sa.update(rows).values(line1='X')\n"
    ),
    "bulk_update": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "async def edit(session, rows) -> None:\n"
        + "    await session.execute(update(Address), rows)\n"
    ),
    "raw_sql": (
        "from sqlalchemy import text\n"
        "statement = text('UPDATE addresses SET line1 = :line1 WHERE id = :id')\n"
    ),
    "raw_sql_quoted": 'SQL = """\n  update "addresses" set city = :city\n"""\n',
}


@pytest.mark.parametrize("name", PLANTED)
def test_the_scan_finds_a_planted_edit(name: str) -> None:
    assert findings("app/modules/requests/service.py", PLANTED[name]) != [], name


@pytest.mark.parametrize("name", ["update_values", "attribute", "bulk_update", "raw_sql"])
def test_an_edit_planted_in_the_exempt_files_is_found_too(name: str) -> None:
    """The exemptions are one function each, not their files."""
    for relative, _ in (BOOK_EDIT, POINT_WRITE):
        assert findings(relative, PLANTED[name]) != [], (relative, name)


def test_the_point_write_may_set_nothing_but_the_point() -> None:
    relative, function = POINT_WRITE
    class_name, method = function.split(".")

    def point_write(values: str) -> str:
        return (
            "from sqlalchemy import update\n"
            + IMPORT
            + f"class {class_name}:\n"
            + f"    async def {method}(self) -> None:\n"
            + f"        await self._session.execute(update(Address).values({values}))\n"
        )

    assert findings(relative, point_write("lat=1, lng=2")) == []
    [finding] = findings(relative, point_write("lat=1, lng=2, line1='1 Other Street'"))
    assert "sets ['lat', 'line1', 'lng']" in finding
    # A mapping, or keywords from a dict, cannot be read: not exempt.
    assert findings(relative, point_write("{Address.lat: 1}")) != []
    assert findings(relative, point_write("**point")) != []


@pytest.mark.parametrize(
    "source",
    [
        # Reads, comparisons and keyword arguments are not writes.
        "def read(address) -> str:\n    return address.line1\n",
        "def same(a, b) -> bool:\n    return a.city == b.city and a.state == b.state\n",
        IMPORT + "row = Address(user_id=1, line1='x', city='y', state='FL', zip_code='33301')\n",
        "def app_state(request, provider) -> None:\n    request.app.state.provider = provider\n",
        # Another model's update, and SQL about another table.
        (
            "from sqlalchemy import update\n"
            "from app.modules.addresses.models import SavedAddress\n"
            "statement = update(SavedAddress).values(is_default=False)\n"
        ),
        "SQL = 'UPDATE saved_addresses SET line1 = :line1'\n",
        "SQL = 'SELECT line1 FROM addresses WHERE id = :id'\n",
    ],
    ids=["read", "compare", "constructor", "app_state", "other_model", "other_table", "select"],
)
def test_the_scan_leaves_reads_and_other_tables_alone(source: str) -> None:
    assert findings("app/modules/requests/service.py", source) == []
