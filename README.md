# Jack Fix It

Home services marketplace for the US, starting in South Florida: the customer says what happened
at home, a verified pro does the job, the payment is held until the job is confirmed, and both
sides review each other.

| Path              | What                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `apps/api`        | FastAPI + SQLAlchemy 2 async + Alembic + ARQ worker (Python 3.12) |
| `apps/web`        | Next.js: landing page and admin/BDC panel                         |
| `apps/mobile`     | Expo (React Native): one app for customers and pros               |
| `packages/shared` | TypeScript types generated from the API's OpenAPI schema          |
| `docs`            | Plan, product context, ADRs, glossary, Railway, agent roles       |

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 10 through Corepack: `corepack enable`
- Python 3.12 and [uv](https://docs.astral.sh/uv/)
- Docker (local Postgres and Redis)

## Quick start

```sh
pnpm install
cd apps/api && uv sync && cd ../..
uvx pre-commit install            # ruff, ruff-format, prettier, detect-private-key on commit

docker compose up -d              # Postgres 16 on 5432, Redis 7 on 6379
# Ports taken? POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose up -d, and match them in apps/api/.env
```

**API** (http://127.0.0.1:8000, docs at `/docs`)

```sh
cd apps/api
cp .env.example .env
uv run alembic upgrade head
uv run python -m app.serve
uv run arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG   # worker, second terminal
```

**Web** (http://localhost:3000)

```sh
cp apps/web/.env.example apps/web/.env.local     # set API_INTERNAL_URL=http://127.0.0.1:8000
pnpm --filter @jack/web dev
```

**Mobile**: the app uses a development build (`expo-dev-client`), not Expo Go.

```sh
cp apps/mobile/.env.example apps/mobile/.env     # EXPO_PUBLIC_API_URL=http://<your LAN IP>:8000
pnpm --filter @jack/mobile start
```

Build the dev client once with EAS (`eas build --profile development-simulator` for the
emulator and simulator, `--profile development` for a device).

## Checks

The same checks run in CI on every PR.

```sh
cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest
pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm --filter @jack/web build
pnpm gen:api-types                 # after an API schema change; commit packages/shared
```

## How we work

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/); branches and PRs
  go to `develop`. Details and the rules every change follows: [AGENTS.md](AGENTS.md).
- Product context and decisions: [docs/jack-fix-it-contexto.md](docs/jack-fix-it-contexto.md)
- MVP plan with task IDs: [docs/mvp-plan.md](docs/mvp-plan.md)
- Architecture decisions: [docs/adr/](docs/adr/)
- Statuses and terms: [docs/glossary.md](docs/glossary.md)
- Hosting and deploys: [docs/railway.md](docs/railway.md)
- Agent pipeline roles: [docs/agents/](docs/agents/)
