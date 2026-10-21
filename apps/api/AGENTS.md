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

## Worker

ARQ tasks are async functions registered in `app/worker.py` `WorkerSettings.functions`. Make
them idempotent: they can run twice.

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
uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest
```
