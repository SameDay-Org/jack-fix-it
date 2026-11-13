"""A request's address is never edited, so its point never goes stale (#384).

Geocode on save places an `addresses` row once and keeps the point for good. That is right
only while nothing changes the row's street, city, state or ZIP: an edit would leave the old
point under a new text, and the route would lead the pro to the old place. Nothing edits one
today (POST /v1/requests makes the row; the address book is another table). This scan fails
the day something does, so the edit is written to clear `lat`/`lng` in the same write (and
queue a new geocode), and this file is updated with it.

What it looks for in app/, scripts/ and alembic/ (a data migration is code too):

- an assignment to `.line1`, `.city`, `.state` or `.zip_code` of anything, outside the
  functions listed in OTHER_ROWS (today SavedAddressService.update, which edits an address
  book entry, a `saved_addresses` row). The scan cannot tell whose row an attribute is on, so
  a new edit of another table's city or state lands here too: list it in OTHER_ROWS;
- a `setattr` with one of those names, or with a name that is not a literal, in a file that
  names the Address model;
- a statement that changes `addresses` rows: the ORM's `update(Address)` (or `Update(Address)`,
  the class behind it), the table's `.update()`, an upsert (`on_conflict_do_update`), `merge`,
  `bulk_update_mappings`, a lightweight `table("addresses")`, or SQL text; outside
  AddressRepository.set_point, which may set `lat` and `lng` and nothing else. The model
  counts wherever the call names it: in what it is given, by position or by keyword, and in
  what it is made on (`values.on_conflict_do_update(index_elements=[Address.id], ...)`, the
  way this codebase writes an upsert).

Names are followed inside each file before anything is matched, for the callables above
(with `setattr`, `table` and `Table`) and for the model, so a write under another name is
found too. Covered:

- an import under another name, from any module: `from sqlalchemy import update as change`,
  `from sqlalchemy.sql.expression import update as change`, `from sqlalchemy.orm import
  aliased as other`, `from app.modules.addresses.models import Address as Row`;
- a module under any name, since the last name of a dotted call is the one matched:
  `import sqlalchemy as sa` then `sa.update(...)`, `import sqlalchemy` then
  `sqlalchemy.update(...)`, `import app.modules.addresses.models as m` then `m.Address`;
- a name bound by assignment to a callable, to the model or to a dotted name through them,
  at module level or inside a function, through any chain: `edit = update`,
  `edit = sa.update`, `Row = Address`, `rows = Address.__table__`, `save = session.merge`,
  `edit: Any = update`, `(edit := update)`, `edit, Row = update, Address`.

`insert`, `delete` and `text` need no following: a new row gets its own point, a deleted
row keeps none, and SQL text is read from every string, whatever it is handed to.

A tripwire for accidents in this codebase, like the status guard's scan
(tests/test_job_status_single_writer.py); not a boundary against code written to dodge it.
A name is followed without scope or order: bound to `update` anywhere in a file, it is
`update` everywhere in that file. What it cannot see:

- a generic helper in another file (`for name, value in changes.items(): setattr(row, name,
  value)`) handed an address row, and SQL assembled at run time;
- a name bound in another file (`change_rows = update` in one module, imported as
  `change_rows` in the next), bound to anything but a plain dotted name
  (`edit = update if quick else None`), handed over as an argument or a default
  (`def edit(change=update)`), kept on an object or a class (`self.change = update`), or
  looked up at run time (`getattr(sa, "update")`, `functools.partial(update, Address)`);
- a statement, a table or a row built in one statement and written through a variable, in
  a call that names the model nowhere: `rows = session.query(Address)` then
  `rows.update(...)`, `Row = aliased(Address)` then `update(Row)`, `row = Address(...)` then
  `session.merge(row)`. `update` is a dict's and a set's method too, so a variable alone
  does not tell.
"""

import ast
import re
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
SCANNED = ("app", "scripts", "alembic")
ADDRESSES = "app/modules/addresses"
PLACE_FIELDS = frozenset({"line1", "city", "state", "zip_code"})
POINT_FIELDS = frozenset({"lat", "lng"})
MODEL = "Address"
BOOK_EDIT = (f"{ADDRESSES}/service.py", "SavedAddressService.update")
# (file, function) -> the other table whose row it edits: code that may assign a place field.
OTHER_ROWS = {BOOK_EDIT: "saved_addresses"}
# (file, function): the only statement that may update `addresses`.
POINT_WRITE = (f"{ADDRESSES}/repository.py", "AddressRepository.set_point")
# Calls that change existing rows of the model they are given or chained on.
WRITING_CALLS = frozenset({"update", "merge", "bulk_update_mappings", "on_conflict_do_update"})
# `Update(Address)` builds the statement `update(Address)` returns.
SAME_CALL = {"Update": "update"}
# Every callable matched by its name: a name bound to one of them is followed (`_aliases`).
WATCHED_CALLS = WRITING_CALLS | {*SAME_CALL, "setattr", "table", "Table"}
# UPDATE addresses, UPDATE ONLY "addresses", UPDATE public.addresses.
_SQL_UPDATE = re.compile(r"\bupdate\s+(?:only\s+)?(?:\"?\w+\"?\.)?\"?addresses\"?\b", re.IGNORECASE)


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


def _path(node: ast.AST) -> tuple[str, ...] | None:
    """`a.b.c` as ("a", "b", "c"); None for anything but a plain dotted name."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    return (node.id, *reversed(parts)) if isinstance(node, ast.Name) else None


def _bound(tree: ast.Module) -> list[tuple[str, tuple[str, ...]]]:
    """Each name this file binds to a plain dotted name, in any scope: (b, a) for
    `from m import a as b`; (b, a.c) for `b = a.c`, `b: T = a.c`, `(b := a.c)` and
    `b, d = a.c, e`."""
    bound: list[tuple[str, tuple[str, ...]]] = []
    pairs: list[tuple[ast.expr, ast.expr]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            bound += [(alias.asname, (alias.name,)) for alias in node.names if alias.asname]
        elif isinstance(node, ast.Assign):
            pairs += [(target, node.value) for target in node.targets]
        elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
            pairs.append((node.target, node.value))
    while pairs:
        target, value = pairs.pop()
        if (
            isinstance(target, (ast.Tuple, ast.List))
            and isinstance(value, (ast.Tuple, ast.List))
            and len(target.elts) == len(value.elts)
        ):
            pairs += zip(target.elts, value.elts, strict=True)
        elif isinstance(target, ast.Name) and (path := _path(value)):
            bound.append((target.id, path))
    return bound


def _aliases(tree: ast.Module) -> dict[str, tuple[str, ...]]:
    """What a name stands for in this file, when that is a watched callable or leads to the
    model: `change` -> ("update",), `Row` -> ("Address",), `rows` -> ("Address", "__table__").
    A name bound to an alias is one too, whatever the order the file binds them in: a chain
    of n names settles within n passes, and names bound to each other in a circle stop there."""
    bound = _bound(tree)
    aliases: dict[str, tuple[str, ...]] = {}
    for _ in bound:
        settled = dict(aliases)
        for name, path in bound:
            full = (*aliases.get(path[0], path[:1]), *path[1:])
            if full[-1] in WATCHED_CALLS or MODEL in full:
                aliases[name] = full
        if aliases == settled:
            break
    return aliases


def _names_model(node: ast.AST, aliases: dict[str, tuple[str, ...]]) -> bool:
    return any(
        (isinstance(part, ast.Name) and MODEL in aliases.get(part.id, (part.id,)))
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


def _call_name(call: ast.Call, aliases: dict[str, tuple[str, ...]]) -> str | None:
    """The name of what is called, an alias put back first: `change(...)` is `update` after
    `from sqlalchemy import update as change`; `sa.update(...)` is `update` as written."""
    function = call.func
    if isinstance(function, ast.Name):
        name = aliases.get(function.id, (function.id,))[-1]
    elif isinstance(function, ast.Attribute):
        name = function.attr
    else:
        return None
    return SAME_CALL.get(name, name)


def _set_fields(call: ast.Call, tree: ast.Module) -> set[str] | None:
    """The columns the `.values(...)` chained on this update sets; None when it cannot be
    read (no .values, a mapping, **kwargs): then the statement counts as setting anything."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr != "values" or not any(part is call for part in ast.walk(node.func)):
            continue
        if node.args or any(keyword.arg is None for keyword in node.keywords):
            return None
        return {keyword.arg for keyword in node.keywords if keyword.arg is not None}
    return None


def findings(relative: str, source: str) -> list[str]:
    """Every write this scan refuses in one file, as `file:line function: what`."""
    tree = ast.parse(source)
    scope = _qualified_names(tree)
    aliases = _aliases(tree)
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
                and where not in OTHER_ROWS
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
        name = _call_name(node, aliases)
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
        if name not in WRITING_CALLS:
            continue
        # update(Address), update(models.Address), Address.__table__.update(),
        # insert(Address).on_conflict_do_update(...), session.merge(Address(...)), and
        # values.on_conflict_do_update(index_elements=[Address.id], ...): the model named in
        # what the call is made on or in what it is given.
        given = [*node.args, *(keyword.value for keyword in node.keywords)]
        if not any(_names_model(part, aliases) for part in (node.func, *given)):
            continue
        if name != "update":
            report(node, f"{name} on addresses")
            continue
        fields = _set_fields(node, tree)
        if where == POINT_WRITE and fields is not None and fields <= POINT_FIELDS:
            continue
        report(node, f"updates addresses (sets {sorted(fields) if fields else 'unknown'})")
    return found


def scanned_files(api_dir: Path = API_DIR) -> list[tuple[str, str]]:
    return [
        (path.relative_to(api_dir).as_posix(), path.read_text(encoding="utf-8"))
        for folder in SCANNED
        for path in sorted((api_dir / folder).rglob("*.py"))
    ]


def refused_writes(api_dir: Path = API_DIR) -> list[str]:
    """Every write the scan refuses in the scanned folders of an API tree."""
    return [
        finding
        for relative, source in scanned_files(api_dir)
        for finding in findings(relative, source)
    ]


def test_nothing_edits_the_place_of_a_request_address() -> None:
    writes = refused_writes()

    assert writes == [], (
        "A request's address is never edited (#384). An edit of its street, city, state or ZIP "
        "must clear lat/lng in the same write and queue a new geocode; then update this scan. "
        "A write to another table's row (the scan cannot tell): list its function in "
        f"OTHER_ROWS. Found: {writes}"
    )


def test_every_exemption_is_still_a_real_function() -> None:
    """No stale entry: each exempt function exists and still makes the write it is exempt
    for (seen once the exemption is taken away)."""
    sources = dict(scanned_files())
    for relative, function in (*OTHER_ROWS, POINT_WRITE):
        elsewhere = findings("app/elsewhere.py", sources[relative])
        assert any(f" {function}: " in finding for finding in elsewhere), (relative, function)


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
    "raw_sql_schema": "SQL = 'UPDATE public.addresses SET state = :state'\n",
    "migration": (
        "from alembic import op\n"
        "def upgrade() -> None:\n"
        '    op.execute("UPDATE ONLY addresses SET zip_code = left(zip_code, 5)")\n'
    ),
    "upsert": (
        "from sqlalchemy.dialects.postgresql import insert\n"
        + IMPORT
        + "statement = insert(Address).values(id=1).on_conflict_do_update(\n"
        + "    index_elements=['id'], set_={'line1': '1 Other Street'}\n"
        + ")\n"
    ),
    "merge": (
        IMPORT
        + "async def edit(session, address_id) -> None:\n"
        + "    await session.merge(Address(id=address_id, city='X'))\n"
    ),
    "bulk_update_mappings": (
        IMPORT
        + "def edit(session, rows) -> None:\n"
        + "    session.bulk_update_mappings(Address, rows)\n"
    ),
    # A module under any name: the last name of the dotted call is the one matched.
    "update_plain_module": (
        "import sqlalchemy\n"
        + IMPORT
        + "statement = sqlalchemy.update(Address).values(line1='1 Other Street')\n"
    ),
    "update_model_module_alias": (
        "from sqlalchemy import update\n"
        "import app.modules.addresses.models as m\n"
        "statement = update(m.Address).values(city='X')\n"
    ),
    "update_class": (
        "from sqlalchemy import Update\n"
        + IMPORT
        + "statement = Update(Address).values(line1='1 Other Street')\n"
    ),
    "update_class_module": (
        "import sqlalchemy as sa\n" + IMPORT + "statement = sa.Update(Address).values(state='GA')\n"
    ),
    # Names from sqlalchemy.orm: the legacy Query's update, and an aliased entity.
    "legacy_query": (
        "from sqlalchemy.orm import Session\n"
        + IMPORT
        + "def edit(session: Session, address_id) -> None:\n"
        + "    session.query(Address).filter(Address.id == address_id).update({'city': 'X'})\n"
    ),
    "aliased_entity": (
        "from sqlalchemy import update\n"
        "from sqlalchemy.orm import aliased as other\n"
        + IMPORT
        + "statement = update(other(Address)).values(zip_code='33301')\n"
    ),
    # The upsert as this codebase writes it: the insert kept in a variable first.
    "upsert_kept_in_a_variable": (
        "from sqlalchemy.dialects.postgresql import insert as pg_insert\n"
        + IMPORT
        + "values = pg_insert(Address).values(id=1, line1='1 Other Street')\n"
        + "statement = values.on_conflict_do_update(\n"
        + "    index_elements=[Address.id], set_={'line1': values.excluded.line1}\n"
        + ")\n"
    ),
    "raw_sql_renamed": (
        "from sqlalchemy import text as sql\n"
        "statement = sql('UPDATE addresses SET line1 = :line1 WHERE id = :id')\n"
    ),
}

# An edit under another name: an import alias, or a name bound by assignment. Each is found
# only once the file's names are followed (`_aliases`), with the finding it must give.
SETS_STREET = "updates addresses (sets ['line1'])"
RENAMED = {
    # The Gatekeeper's plant (PR #395, round 1): it changed a street and kept the old point.
    "gatekeeper_r1": (
        "from sqlalchemy import update as sql_update\n"
        "from app.modules.addresses.models import Address\n"
        "\n"
        "async def edit(session, address_id, street):\n"
        "    await session.execute(\n"
        "        sql_update(Address).where(Address.id == address_id).values(line1=street)\n"
        "    )\n",
        SETS_STREET,
    ),
    "import_from_a_submodule": (
        "from sqlalchemy.sql.expression import update as change\n"
        + IMPORT
        + "statement = change(Address).values(city='X')\n",
        "updates addresses (sets ['city'])",
    ),
    "import_inside_a_function": (
        IMPORT
        + "async def edit(session, street) -> None:\n"
        + "    from sqlalchemy import update as change\n"
        + "    await session.execute(change(Address).values(line1=street))\n",
        SETS_STREET,
    ),
    "callable_and_model_renamed": (
        "from sqlalchemy import update as change\n"
        "from app.modules.addresses.models import Address as Row\n"
        "statement = change(Row).where(Row.id == 1).values(state='GA')\n",
        "updates addresses (sets ['state'])",
    ),
    "rebound": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "edit = update\n"
        + "statement = edit(Address).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "rebound_from_a_module": (
        "import sqlalchemy as sa\n"
        + IMPORT
        + "edit = sa.update\n"
        + "statement = edit(Address).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "rebound_inside_a_function": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "async def edit(session, street) -> None:\n"
        + "    change = update\n"
        + "    await session.execute(change(Address).values(line1=street))\n",
        SETS_STREET,
    ),
    "rebound_through_a_chain": (
        "from sqlalchemy import update as change\n"
        "from app.modules.addresses.models import Address as Row\n"
        "edit = change\n"
        "Entry = Row\n"
        "statement = edit(Entry).values(zip_code='33301')\n",
        "updates addresses (sets ['zip_code'])",
    ),
    "rebound_annotated": (
        "from typing import Any\n"
        "from sqlalchemy import update\n"
        + IMPORT
        + "edit: Any = update\n"
        + "statement = edit(Address).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "rebound_in_an_expression": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "def edit(street):\n"
        + "    if (change := update) is not None:\n"
        + "        return change(Address).values(line1=street)\n",
        SETS_STREET,
    ),
    "rebound_in_a_pair": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "edit, Row = update, Address\n"
        + "statement = edit(Row).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "model_rebound": (
        "from sqlalchemy import update\n"
        + IMPORT
        + "Row = Address\n"
        + "statement = update(Row).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "model_rebound_from_a_module": (
        "from sqlalchemy import update\n"
        "import app.modules.addresses.models as m\n"
        "Row = m.Address\n"
        "statement = update(Row).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "table_rebound": (
        IMPORT + "rows = Address.__table__\nstatement = rows.update().values(state='GA')\n",
        "updates addresses (sets ['state'])",
    ),
    "table_update_rebound": (
        IMPORT
        + "change = Address.__table__.update\n"
        + "statement = change().values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    # Three names deep, bound before and after their use: no order of binding hides it.
    "table_update_rebound_through_three_names": (
        IMPORT
        + "rows = Address.__table__\n"
        + "change = rows.update\n"
        + "edit = change\n"
        + "statement = edit().values(state='GA')\n",
        "updates addresses (sets ['state'])",
    ),
    "table_update_rebound_after_its_use": (
        IMPORT
        + "def edit(street):\n"
        + "    change = late.update\n"
        + "    return change().values(line1=street)\n"
        + "late = rows\n"
        + "rows = Address.__table__\n",
        SETS_STREET,
    ),
    "update_class_renamed": (
        "from sqlalchemy import Update as Change\n"
        + IMPORT
        + "statement = Change(Address).values(line1='1 Other Street')\n",
        SETS_STREET,
    ),
    "merge_rebound": (
        IMPORT
        + "async def edit(session, address_id) -> None:\n"
        + "    save = session.merge\n"
        + "    await save(Address(id=address_id, city='X'))\n",
        "merge on addresses",
    ),
    "setattr_renamed": (
        "from builtins import setattr as put\n"
        + IMPORT
        + "def edit(a: Address) -> None:\n"
        + "    put(a, 'city', 'X')\n",
        "setattr of a place field, or of a name that is not a literal",
    ),
    "setattr_rebound": (
        IMPORT
        + "put = setattr\n"
        + "def edit(a: Address, data: dict) -> None:\n"
        + "    for name, value in data.items():\n"
        + "        put(a, name, value)\n",
        "setattr of a place field, or of a name that is not a literal",
    ),
    "table_renamed": (
        "from sqlalchemy import column, table as lightweight\n"
        "rows = lightweight('addresses', column('line1'))\n",
        "a table over addresses, apart from the model",
    ),
}


@pytest.mark.parametrize("name", PLANTED)
def test_the_scan_finds_a_planted_edit(name: str) -> None:
    assert findings("app/modules/requests/service.py", PLANTED[name]) != [], name


@pytest.mark.parametrize("name", RENAMED)
def test_the_scan_finds_an_edit_made_under_another_name(name: str) -> None:
    """In any file, the exempt ones included: one finding, the one the edit must give."""
    source, expected = RENAMED[name]

    for relative in ("app/modules/requests/service.py", BOOK_EDIT[0], POINT_WRITE[0]):
        [finding] = findings(relative, source)
        assert finding.endswith(f": {expected}"), (relative, finding)


def test_the_application_scan_refuses_the_edit_the_gatekeeper_planted(tmp_path: Path) -> None:
    """End to end, as it was planted in round 1: a file in each scanned folder of an API
    tree, found and refused by the function the real scan runs."""
    source, expected = RENAMED["gatekeeper_r1"]
    planted = [
        "app/modules/addresses/planted_edit.py",
        "scripts/planted_edit.py",
        "alembic/versions/planted_edit.py",
    ]
    for relative in planted:
        (tmp_path / relative).parent.mkdir(parents=True)
        (tmp_path / relative).write_text(source, encoding="utf-8")

    assert refused_writes(tmp_path) == [f"{relative}:6 edit: {expected}" for relative in planted]


@pytest.mark.parametrize("name", ["update_values", "attribute", "bulk_update", "raw_sql"])
def test_an_edit_planted_in_the_exempt_files_is_found_too(name: str) -> None:
    """The exemptions are one function each, not their files."""
    for relative, _ in (BOOK_EDIT, POINT_WRITE):
        assert findings(relative, PLANTED[name]) != [], (relative, name)


@pytest.mark.parametrize("imported", ["update", "update as change"])
def test_the_point_write_may_set_nothing_but_the_point(imported: str) -> None:
    """Under its own name or another: the exemption reads the same statement."""
    relative, function = POINT_WRITE
    class_name, method = function.split(".")
    called = imported.split()[-1]

    def point_write(values: str) -> str:
        return (
            f"from sqlalchemy import {imported}\n"
            + IMPORT
            + f"class {class_name}:\n"
            + f"    async def {method}(self) -> None:\n"
            + f"        await self._session.execute({called}(Address).values({values}))\n"
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
        # Another name for `update`, used on another table; the model only read, under other
        # names too, and beside another table's write or upsert.
        (
            "from sqlalchemy import update as change\n"
            "from app.modules.addresses.models import SavedAddress as Entry\n"
            "statement = change(Entry).values(is_default=False)\n"
        ),
        (
            "from sqlalchemy import select, update\n"
            "from app.modules.addresses.models import Address as Row, SavedAddress\n"
            "edit = update\n"
            "async def tidy(session, address_id) -> None:\n"
            "    place = await session.scalar(select(Row).where(Row.id == address_id))\n"
            "    statement = edit(SavedAddress).where(SavedAddress.user_id == place.user_id)\n"
            "    await session.execute(statement.values(is_default=False))\n"
        ),
        (
            "from sqlalchemy import select as query\n"
            "from app.modules.addresses.models import Address as Row\n"
            "Entry = Row\n"
            "rows = Row.__table__\n"
            "statement = query(Entry.line1, rows.c.city).where(Row.id == 1)\n"
        ),
        (
            "from sqlalchemy import select\n"
            "from sqlalchemy.dialects.postgresql import insert\n"
            "from app.modules.addresses.models import Address\n"
            "from app.modules.devices.models import Device\n"
            "zips = select(Address.zip_code)\n"
            "values = insert(Device).values(user_id=1)\n"
            "statement = values.on_conflict_do_update(\n"
            "    index_elements=[Device.id], set_={'user_id': values.excluded.user_id}\n"
            ")\n"
        ),
        # A dict's update under another name, and a schema that is called Update here.
        (
            "seen: dict[str, str] = {}\n"
            "put = seen.update\n"
            "put({'line1': '1 Main Street'})\n"
            "seen.update(city='Orlando')\n"
        ),
        (
            "from app.modules.addresses.schemas import SavedAddressUpdate as Update\n"
            "data = Update(line1='1 Main Street')\n"
        ),
    ],
    ids=[
        "read",
        "compare",
        "constructor",
        "app_state",
        "other_model",
        "other_table",
        "select",
        "renamed_on_other_model",
        "rebound_on_other_model_beside_a_read",
        "renamed_only_read",
        "other_upsert_beside_a_read",
        "dict_update_rebound",
        "schema_named_update",
    ],
)
def test_the_scan_leaves_reads_and_other_tables_alone(source: str) -> None:
    assert findings("app/modules/requests/service.py", source) == []
