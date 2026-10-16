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

- Models subclass `app.db.Base` (naming convention set); `alembic/env.py` imports every
  `app/modules/*/models.py`.
- `uv run alembic revision --autogenerate -m "<what>"`, then read and fix the generated file.
  Money columns are integer `*_cents`. Prove `upgrade` → `downgrade` → `upgrade` locally.
- Migrations run on Railway as the api service's pre-deploy command.

## Worker

ARQ tasks are async functions registered in `app/worker.py` `WorkerSettings.functions`. Make
them idempotent: they can run twice.

## Tests

`pytest` with `asyncio_mode = auto`; `tests/conftest.py` builds the app from explicit settings
and an `httpx` ASGI client, without a database. Replace dependencies with
`app.dependency_overrides`. The isolated test-database fixture arrives with the first tables
(#24). No real network calls.

## Commands (from apps/api)

```sh
uv run python -m app.serve                       # API on HOST:PORT from .env
uv run arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
uv run alembic upgrade head
uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest
```
