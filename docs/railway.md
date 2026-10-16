# Railway

Staging and production run on Railway Pro (ADR 0001): one project, two environments.

| Environment | Deploys from | Visibility                     |
| ----------- | ------------ | ------------------------------ |
| staging     | `develop`    | Public domains for api and web |
| production  | `main`       | Private until launch (D20)     |

## Services

Railway reads each service's settings from a config file in the repo. The files have custom
names, so set **Config-as-code file path** in every service's settings.

| Service  | Root directory      | Config file path                | Builder    | Start                               | Healthcheck   |
| -------- | ------------------- | ------------------------------- | ---------- | ----------------------------------- | ------------- |
| api      | `/apps/api`         | `/apps/api/railway.api.json`    | Dockerfile | `python -m app.serve`               | `/health`     |
| worker   | `/apps/api`         | `/apps/api/railway.worker.json` | Dockerfile | `arq app.worker.WorkerSettings ...` | none          |
| web      | `/`                 | `/apps/web/railway.json`        | Railpack   | `pnpm --filter @jack/web start`     | `/api/health` |
| Postgres | Railway Postgres 16 | -                               | -          | -                                   | -             |
| Redis    | Railway Redis       | -                               | -          | -                                   | -             |

- **api** runs `alembic upgrade head` as its pre-deploy command. A failed migration stops the
  deploy and the previous version keeps serving.
- **worker** uses the same image with ARQ as the start command, restart policy `ALWAYS`, and
  no healthcheck. It runs no migrations. A worker task that needs a new table must ship after
  the migration that creates it.
- **web** uses the repo root as its root directory because the build installs the whole pnpm
  workspace (`@jack/shared` is a workspace package). Node comes from `.nvmrc`, pnpm from
  `packageManager`.
- Watch patterns (in the config files) stop unrelated changes from redeploying a service:
  api and worker `/apps/api/**`; web `/apps/web/**`, `/packages/shared/**`, `/pnpm-lock.yaml`.

## Variables

Set them per environment in the Railway dashboard. Values that point to another service use
reference variables so they follow that service automatically. Secret values never enter the
repo; their names are listed, commented, in `apps/api/.env.example` with the task that adds
them.

**api**

| Variable       | Value                                                           |
| -------------- | --------------------------------------------------------------- |
| `APP_ENV`      | `staging` or `production`                                       |
| `LOG_LEVEL`    | `INFO`                                                          |
| `PORT`         | `8000` (set it explicitly so web can reference it)              |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (normalized to asyncpg by the app) |
| `REDIS_URL`    | `${{Redis.REDIS_URL}}`                                          |
| `CORS_ORIGINS` | empty until a browser calls the API directly                    |
| `SENTRY_DSN`   | per environment                                                 |

Leave `HOST` unset: the default `::` listens on IPv6 (private network) and IPv4 (public proxy
and healthcheck) on one socket.

**worker**: `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `SENTRY_DSN`, same values as
api.

**web**

| Variable           | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| `APP_ENV`          | `staging` or `production` (only production is indexable) |
| `API_INTERNAL_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`   |

The web server calls the API over the private network; browsers and the mobile app use the
api's public domain.

## Deploys

- Connect the GitHub repo to each of api, worker and web. Staging tracks `develop`, production
  tracks `main`.
- Enable **Wait for CI** on every service in both environments. Railway then waits for the
  GitHub Actions `CI` workflow on the pushed commit and skips the deploy when it fails, so a red
  commit never reaches an environment. CI runs on pushes to `develop` and `main` for this.
- Rollback: redeploy a previous deployment from the service's history. In production only a
  human does this.

## Health signals

What Sentinel checks after each deploy:

| Service | Signal                                                                      |
| ------- | --------------------------------------------------------------------------- |
| api     | `GET /health` 200 (liveness) and `GET /health/ready` 200 (Postgres + Redis) |
| worker  | a JSON log line with `"message": "worker_started"`                          |
| web     | `GET /api/health` 200                                                       |

## Sentinel allowlist

`docs/agents/sentinel.md` is authoritative. Where each allowed change lives:

| Allowed change (staging only)                 | Where                                                |
| --------------------------------------------- | ---------------------------------------------------- |
| Build command, start command, watch paths     | `railway*.json` in the repo, or the service settings |
| Healthcheck path and timeout, restart policy  | `railway*.json` in the repo, or the service settings |
| Root directory, config file path, port        | Service settings                                     |
| Redeploy or restart a service                 | Service deployments                                  |
| Non-secret variables listed in `.env.example` | Service variables                                    |
| Service reference variables (`${{...}}`)      | Service variables                                    |

A fix that belongs in a config file is also proposed as a PR, so the repo and Railway agree.
Everything else (secrets, databases, domains, deletions, billing, members, any production
change) is a human's job.

## Backups and restore drill

Enable scheduled backups and point-in-time recovery (PITR) on the Postgres service in both
environments.

Restore drill (human only; first run for D3.1, #23, then before launch):

1. In staging, write down a marker: `alembic current` and the row count of a few tables.
2. Restore a recent backup, or a PITR timestamp, into a **separate** environment or a scratch
   Postgres service. Never restore over production.
3. Point a one-off connection at the restored database and compare the marker.
4. Record the date, the backup or timestamp used, how long it took and the result in the
   runbook (#101).
5. Remove the scratch database.

Confirm the exact dashboard steps on the first drill and update this section.

## First-time setup (human)

1. Create the project and the `staging` and `production` environments.
2. Add Postgres and Redis to each environment; enable backups and PITR.
3. Create api, worker and web from the GitHub repo with the root directories and config file
   paths above.
4. Set the variables above, then enable Wait for CI.
5. Generate public domains for api and web in staging; keep production private until D20.
6. For Sentinel: a project token scoped to the staging environment, and a GitHub token limited
   to issues and pull requests.
