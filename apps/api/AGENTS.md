# apps/api

FastAPI + SQLAlchemy 2 async + Alembic + ARQ, Python 3.12, managed with uv. Root `AGENTS.md`
rules apply.

## Layout and layering (ADR 0003)

- Domain code lives in `app/modules/<domain>/`: `router.py` (HTTP only), `service.py` (business
  rules, transactions), `repository.py` (SQLAlchemy queries), `models.py` (ORM), `schemas.py`
  (Pydantic in/out). A module calls another module's service, never its repository.
- Vendor SDKs (Stripe, Twilio, Resend, Expo Push, S3, Google) are wrapped in `app/integrations/`;
  services call the wrapper, and tests replace it there.
- Public routes go under `/v1`: include the domain router in `app/api.py`.
- `app/config.py` `Settings` is the only reader of env vars (env name = field name in upper
  case). Add new names to `.env.example`; secrets stay commented, with their task ID.
- Access (`app/modules/auth/permissions.py`): every new `/v1` route picks exactly one of public
  (added to `PUBLIC_ROUTES` with a reason), `CurrentUser`, `AppUser` (customer, pro),
  `PanelUser` (agent, admin), `CustomerUser`, `ProUser`, `AdminUser` or `require_roles(...)`. A
  wrong role is 403. Resources addressed by id call `ensure_owner` (404 for anyone else) or a
  feature rule, and carry a test proving user A cannot read or change user B's.
  `tests/test_route_permissions.py` fails CI on a route with no decision.
- Errors: raise an `AppError` subclass from `app/errors.py`; responses always have the shape
  `{"error": {"code", "message"}}`. Unexpected exceptions become a generic 500.
- Logging: `logging.getLogger(__name__)`, an event-style message plus `extra={...}`; the JSON
  formatter adds the request id. Ids only, no PII.

## Database

- Models subclass `app.db.Base` (naming convention set) and `app.db.IdTimestampsMixin`;
  `app.db.import_models()` (used by `alembic/env.py`) imports every `app/modules/*/models.py`.
  Table conventions (UUID keys, enums, cents, foreign keys) are in ADR 0007.
- `uv run alembic revision --autogenerate -m "<what>"`, then read and fix the generated file.
  Money columns are integer `*_cents`. Prove `upgrade` → `downgrade` → `upgrade` locally.
- Migrations run on Railway as the api service's pre-deploy command.
- **Status guard (#163).** Request and job statuses change only through `RequestStateMachine`
  and `JobStateMachine`, and the database enforces it.
  - **The trigger:** triggers on `service_requests` and `jobs` refuse any status change, and any
    insert with a status other than the column default. The refusal is SQLSTATE 42501, with a
    message naming the table only.
  - **The exception:** a write passes only while the transaction-local setting
    `app.status_writer` names that very row, `<table>:<row id>`. A machine first flushes
    everything pending (the drain: an unrelated status write fails there, unauthorized), checks
    that nothing but its locked row is pending, then sets the token around its single flush and
    clears it in a `finally`. It is `set_config(..., true)`, so it never outlives the
    transaction on a pooled connection, and no other row or table can ride along.
  - **Who may set the token:** nothing else in `app/` or `scripts/` may, and a static test fails
    if anything does.
  - **Tests** create rows in a given status with `tests/helpers.py::as_status_writer`, whose
    wildcard token `fixtures` the trigger accepts only in a database whose own setting
    `app.status_writer_fixtures` is `on`. `tests/conftest.py` sets it on the test database; no
    production database has it.
  - **What it protects against:** accidents, meaning app code, scripts and raw SQL that write a
    status without going through a machine. It is not a security boundary. Any connection, of
    any role, can set both settings for its own session (`set_config`), so a client that wants
    to forge the token can. The static test is what keeps app code from naming them.
  - **A refusal is a bug:** it reaches the API as a 500 and is never mapped to a 4xx. The logs
    get `status_guard_refused` with the table name and a sanitized `unhandled_error`. Like every
    database error, it is logged as a summary only (`app/db_errors.py`): never the statement,
    the parameters or the driver's message, which can hold SQL literals.
  - **SQLAdmin (#41) cannot change a status by design.** A status change is a state-machine
    action with its own endpoint.

## Worker

ARQ tasks are async functions registered in `app/worker.py` `WorkerSettings.functions`. Make
them idempotent: they can run twice.

- **Media copies (#173).** `sanitize_request_media` makes a privacy-safe copy of each request
  photo and video (no EXIF, GPS, XMP or video tags) under an opaque `m/<32 hex><ext>` key.
  Only a `ready` copy may ever be shown to a pro; a `failed` one never is. Videos need the
  ffmpeg binary: the Docker image installs it, and so does CI. Locally the video tests skip
  without it. ARQ ends a job at its timeout for good (no retry), so every step of the job is
  bounded and each try stops itself `MEDIA_SANITIZE_SETTLE_SECONDS` before it
  (`media_copies.py`); `tests/test_media_copy_deadlines.py` runs the real worker on Redis.
- **Orphan uploads (#191).** The cron `sweep_orphan_uploads` (`uploads/orphans.py`) lists `u/`
  and deletes uploads older than `ORPHAN_UPLOAD_MIN_AGE_HOURS` that no row references.
  `ORPHAN_UPLOAD_MODE` is `off`, `dry_run` (the default: counts only, in the
  `orphan_uploads_swept` log) or `delete`. One run is bounded by
  `ORPHAN_UPLOAD_SWEEP_TIMEOUT_SECONDS`; the next starts over. A new upload purpose or key
  column must be added to `REFERENCED_BY` or `SKIPPED` there; tests fail until it is.

## Tests

`pytest` with `asyncio_mode = auto`; `tests/conftest.py` builds the app from explicit settings
and an `httpx` ASGI client, without a database. Replace dependencies with
`app.dependency_overrides`. No real network calls.

Tests that touch the database take the `db_session` fixture (an `AsyncSession`). The first one
creates `<dbname>_test` next to `DATABASE_URL`'s database (e.g. `jack_test`) and migrates it to
head; the dev database is never written. Each test runs inside a transaction that is rolled
back afterwards, so its rows are gone in the next test, even if it called `commit()`. Tests
without `db_session` still run without Postgres. Expect a constraint violation with
`pytest.raises(IntegrityError)` inside `session.begin_nested()`, as `tests/test_schema_core.py`
does.

## Commands (from apps/api)

```sh
uv run python -m app.serve                       # API on HOST:PORT from .env
uv run arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
uv run alembic upgrade head
uv run python -m scripts.seed_categories          # inserts missing launch categories (seed_data.json); never updates a row
uv run python -m scripts.seed_service_areas       # inserts missing served ZIPs (service_areas/seed_data.json: South Florida, Broward active, #9); never updates a row
uv run python -m scripts.create_staff_user        # creates an admin or agent (asks; password via getpass), or --promote an account; --help
uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest
```
