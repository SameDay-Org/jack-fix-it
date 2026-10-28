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

Secret means the value is a credential: it lives only in Railway, never in the repo, and only
a human sets or changes it. Values the api and worker share are easiest to set once per
environment as **shared variables** referenced from both services, so the two never drift apart.

### api

| Variable                      | Value                                                                    | Secret          | Source     |
| ----------------------------- | ------------------------------------------------------------------------ | --------------- | ---------- |
| `APP_ENV`                     | `staging` or `production`                                                | no              | D3.1 (#22) |
| `LOG_LEVEL`                   | `INFO`                                                                   | no              | D3.1 (#22) |
| `PORT`                        | `8000` (set it explicitly so web can reference it)                       | no              | D3.1 (#22) |
| `DATABASE_URL`                | `${{Postgres.DATABASE_URL}}` (normalized to asyncpg by the app)          | yes (reference) | D3.1 (#22) |
| `REDIS_URL`                   | `${{Redis.REDIS_URL}}`                                                   | yes (reference) | D3.1 (#22) |
| `CORS_ORIGINS`                | empty until a browser calls the API directly                             | no              | D3.1 (#22) |
| `SENTRY_DSN`                  | per environment                                                          | no              | D3.1 (#22) |
| `FORWARDED_ALLOW_IPS`         | the addresses Railway's proxy connects from; confirm at first setup      | no              | D4.4 (#28) |
| `RATE_LIMIT_TIMEOUT_SECONDS`  | optional; `0.5` by default                                               | no              | D4.4 (#28) |
| `JWT_SECRET`                  | required; random, at least 32 characters                                 | yes             | D4.2 (#25) |
| `RATE_LIMIT_KEY_SECRET`       | required; random, at least 32 characters, one per environment            | yes             | #137       |
| `REFRESH_ROTATION_SECRET`     | required; random, at least 32 characters, one per environment            | yes             | #152       |
| `REFRESH_REUSE_GRACE_SECONDS` | optional; `30` by default                                                | no              | #152       |
| `TWILIO_ACCOUNT_SID`          | required                                                                 | no              | D4.3 (#26) |
| `TWILIO_AUTH_TOKEN`           | required                                                                 | yes             | D4.3 (#26) |
| `TWILIO_VERIFY_SERVICE_SID`   | required                                                                 | no              | D4.3 (#26) |
| `RESEND_API_KEY`              | required                                                                 | yes             | D4.3 (#27) |
| `EMAIL_FROM`                  | required; e.g. `Jack Fix It <no-reply@…>` on a domain verified in Resend | no              | D4.3 (#27) |
| `S3_ENDPOINT_URL`             | required                                                                 | no              | D6.2 (#35) |
| `S3_BUCKET`                   | required                                                                 | no              | D6.2 (#35) |
| `S3_ACCESS_KEY_ID`            | required                                                                 | yes             | D6.2 (#35) |
| `S3_SECRET_ACCESS_KEY`        | required                                                                 | yes             | D6.2 (#35) |
| `S3_REGION`                   | `auto` (the default) for Cloudflare R2                                   | no              | D6.2 (#35) |
| `GOOGLE_MAPS_API_KEY`         | optional until #14; without it `POST /v1/geo/reverse` answers 503        | yes             | #215       |

"Required" means the API refuses to start in staging and production without it (the settings
validators in `apps/api/app/config.py`). Every other setting has a working default; the
non-secret ones are listed in `apps/api/.env.example`.

Leave `HOST` unset: the default `::` listens on IPv6 (private network) and IPv4 (public proxy
and healthcheck) on one socket.

### worker

The worker builds the same settings when `app/worker.py` is imported, so the same validators
stop it: without every required variable it crash-loops under its `ALWAYS` restart policy and
never logs `worker_started`. Use the same values as api.

| Variable                    | Value                                                      | Secret          | Source      |
| --------------------------- | ---------------------------------------------------------- | --------------- | ----------- |
| `APP_ENV`                   | same as api                                                | no              | D3.1 (#22)  |
| `LOG_LEVEL`                 | same as api                                                | no              | D3.1 (#22)  |
| `DATABASE_URL`              | `${{Postgres.DATABASE_URL}}`                               | yes (reference) | D3.1 (#22)  |
| `REDIS_URL`                 | `${{Redis.REDIS_URL}}`                                     | yes (reference) | D3.1 (#22)  |
| `SENTRY_DSN`                | same as api                                                | no              | D3.1 (#22)  |
| `JWT_SECRET`                | same as api                                                | yes             | D4.2 (#25)  |
| `RATE_LIMIT_KEY_SECRET`     | same as api                                                | yes             | #137        |
| `REFRESH_ROTATION_SECRET`   | same as api                                                | yes             | #152        |
| `TWILIO_ACCOUNT_SID`        | same as api                                                | no              | D4.3 (#26)  |
| `TWILIO_AUTH_TOKEN`         | same as api                                                | yes             | D4.3 (#26)  |
| `TWILIO_VERIFY_SERVICE_SID` | same as api                                                | no              | D4.3 (#26)  |
| `RESEND_API_KEY`            | same as api                                                | yes             | D4.3 (#27)  |
| `EMAIL_FROM`                | same as api                                                | no              | D4.3 (#27)  |
| `S3_ENDPOINT_URL`           | same as api                                                | no              | D6.2 (#35)  |
| `S3_BUCKET`                 | same as api                                                | no              | D6.2 (#35)  |
| `S3_ACCESS_KEY_ID`          | same as api                                                | yes             | D6.2 (#35)  |
| `S3_SECRET_ACCESS_KEY`      | same as api                                                | yes             | D6.2 (#35)  |
| `EXPO_ACCESS_TOKEN`         | optional; set it only if Expo enhanced push security is on | yes             | D10.3 (#54) |

`apps/api/tests/test_railway_doc.py` fails when a setting that staging or production requires
is missing from either table, so this list cannot fall behind `app/config.py`.

### web

| Variable                    | Value                                                                                                            | Secret | Source      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| `APP_ENV`                   | `staging` or `production` (only production is indexable)                                                         | no     | D3.1 (#22)  |
| `API_INTERNAL_URL`          | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}`                                                           | no     | D3.1 (#22)  |
| `REFRESH_TOKEN_TTL_SECONDS` | the api's refresh token lifetime (2592000 unless the api sets another); the panel's session cookie lasts as long | no     | D16.1 (#80) |
| `API_TIMEOUT_MS`            | `5000`: the longest wait on the api for one call, body included                                                  | no     | D16.1 (#80) |

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
7. After the first deploy of each environment, create the first admin from a shell on the api
   service: `uv run python -m scripts.create_staff_user` (it asks for the email and the role,
   and the password twice without echoing it). Public registration never creates staff
   accounts (#155). For a scripted setup: `--email … --role admin --password-env NAME`, with
   the password only in that environment variable.
8. Seed the launch data from a shell on the api service, after each first deploy and again
   whenever a seed file changes: `uv run python -m scripts.seed_categories` and
   `uv run python -m scripts.seed_service_areas`. Both are safe to re-run, because they insert
   what is missing and never update a row. Without the service areas, every request is refused
   with `zip_not_served`. The areas are South Florida with Broward active (#9). The sources and
   the rebuild steps are in `apps/api/app/modules/service_areas/SOURCES.md`.
   - **Switching a county on later** (Miami-Dade or Palm Beach): use the admin (#41), or run
     SQL. Example: `UPDATE service_areas SET active = true WHERE zip_code IN (...)` with that
     county's ZIPs from `seed_data.json`. Editing `active` in the file does nothing to rows that
     already exist.
