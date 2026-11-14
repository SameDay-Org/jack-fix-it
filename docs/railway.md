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

- **redis-location** is a second Redis, for the pros' live positions only (#350):
  no volume, no backups, its own start command. See "Live positions" under the api variables.
- **api** runs these as its pre-deploy command, in order, on every deploy:

  1. `alembic upgrade head`
  2. `python -m scripts.seed_categories`
  3. `python -m scripts.seed_service_areas`

  The first failure stops the deploy and the previous version keeps serving. Railway's config
  schema allows a single pre-deploy entry, so `railway.api.json` chains them with `&&` in one
  `sh -c` string. The seeds are explained in step 8 of the first-time setup.

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

| Variable                           | Value                                                                       | Secret          | Source     |
| ---------------------------------- | --------------------------------------------------------------------------- | --------------- | ---------- |
| `APP_ENV`                          | `staging` or `production`                                                   | no              | D3.1 (#22) |
| `LOG_LEVEL`                        | `INFO`                                                                      | no              | D3.1 (#22) |
| `PORT`                             | `8000` (set it explicitly so web can reference it)                          | no              | D3.1 (#22) |
| `DATABASE_URL`                     | `${{Postgres.DATABASE_URL}}` (normalized to asyncpg by the app)             | yes (reference) | D3.1 (#22) |
| `REDIS_URL`                        | `${{Redis.REDIS_URL}}`                                                      | yes (reference) | D3.1 (#22) |
| `CORS_ORIGINS`                     | empty until a browser calls the API directly                                | no              | D3.1 (#22) |
| `SENTRY_DSN`                       | per environment                                                             | no              | D3.1 (#22) |
| `FORWARDED_ALLOW_IPS`              | the addresses Railway's proxy connects from; confirm at first setup         | no              | D4.4 (#28) |
| `RATE_LIMIT_TIMEOUT_SECONDS`       | optional; `0.5` by default                                                  | no              | D4.4 (#28) |
| `JWT_SECRET`                       | required; random, at least 32 characters                                    | yes             | D4.2 (#25) |
| `RATE_LIMIT_KEY_SECRET`            | required; random, at least 32 characters, one per environment               | yes             | #137       |
| `REFRESH_ROTATION_SECRET`          | required; random, at least 32 characters, one per environment               | yes             | #152       |
| `REFRESH_REUSE_GRACE_SECONDS`      | optional; `30` by default                                                   | no              | #152       |
| `TWILIO_ACCOUNT_SID`               | required                                                                    | no              | D4.3 (#26) |
| `TWILIO_AUTH_TOKEN`                | required                                                                    | yes             | D4.3 (#26) |
| `TWILIO_VERIFY_SERVICE_SID`        | required                                                                    | no              | D4.3 (#26) |
| `RESEND_API_KEY`                   | required                                                                    | yes             | D4.3 (#27) |
| `EMAIL_FROM`                       | required; e.g. `Jack Fix It <no-reply@…>` on a domain verified in Resend    | no              | D4.3 (#27) |
| `S3_ENDPOINT_URL`                  | required                                                                    | no              | D6.2 (#35) |
| `S3_BUCKET`                        | required                                                                    | no              | D6.2 (#35) |
| `S3_ACCESS_KEY_ID`                 | required                                                                    | yes             | D6.2 (#35) |
| `S3_SECRET_ACCESS_KEY`             | required                                                                    | yes             | D6.2 (#35) |
| `S3_REGION`                        | `auto` (the default) for Cloudflare R2                                      | no              | D6.2 (#35) |
| `STRIPE_WEBHOOK_SECRET`            | optional until the Stripe endpoint exists; unset, the webhook gives 503     | yes             | D7.3 (#40) |
| `GOOGLE_MAPS_API_KEY`              | optional until #14; without it `POST /v1/geo/reverse` answers 503           | yes             | #215       |
| `STRIPE_SECRET_KEY`                | required; `sk_test_` until launch: a live key works in production only      | yes             | D7.1 (#39) |
| `STRIPE_PUBLISHABLE_KEY`           | only a `pk_` key (`pk_test_` until launch); unset, payment gives 503        | no              | #58        |
| `PUBLIC_API_URL`                   | required; https, e.g. `https://${{api.RAILWAY_PUBLIC_DOMAIN}}`              | no              | D7.1 (#39) |
| `ORPHAN_UPLOAD_MIN_AGE_HOURS`      | optional; `24` by default; a shared variable (see below)                    | no              | #191, #298 |
| `JOB_PHOTO_ATTACH_MAX_AGE_MINUTES` | optional; `720` by default, at most half the hours above; a shared variable | no              | #298       |
| `CHAT_ORIGINAL_KEYS`               | JSON `{"<key id>": "<base64 32-byte key>"}`; see "Chat originals" below     | yes             | #72        |
| `CHAT_ORIGINAL_ACTIVE_KEY_ID`      | the key id of `CHAT_ORIGINAL_KEYS` new originals are sealed with            | no              | #72        |
| `CHAT_ORIGINAL_RETENTION_DAYS`     | optional; `90` by default                                                   | no              | #72        |
| `LOCATION_REDIS_URL`               | `redis-location`'s private URL (see below); unset, positions give 503       | yes (reference) | #350       |
| `LOCATION_REDIS_RECHECK_SECONDS`   | optional; `60` by default                                                   | no              | #350       |
| `LOCATION_REDIS_ASSUME_EPHEMERAL`  | optional; only for a Redis that refuses `CONFIG GET` (see below)            | no              | #350       |
| `MAPBOX_ACCESS_TOKEN`              | a secret server token; unset, `GET /v1/jobs/{job_id}/route` answers 503     | yes             | #351       |
| `GEOCODE_ON_SAVE`                  | optional; `false` by default; see "Geocode on save" below before `true`     | no              | #384       |

"Required" means the API refuses to start in staging and production without it (the settings
validators in `apps/api/app/config.py`). Every other setting has a working default; the
non-secret ones are listed in `apps/api/.env.example`.

#### Chat originals (#72)

When the redactor masks a contact in a chat message, the API keeps what the sender typed,
encrypted (AES-256-GCM), for staff only (`GET /v1/admin/jobs/{id}/messages`, each read audited),
and the worker deletes it after `CHAT_ORIGINAL_RETENTION_DAYS`. Without `CHAT_ORIGINAL_KEYS`
the API still starts, logs `chat_original_key_missing` (WARNING) in staging and production, and
keeps **no** original (never plaintext). A malformed value stops startup; the error never shows
the key.

- Make a key (one per environment, never reused): `python -c "import base64, os;
print(base64.b64encode(os.urandom(32)).decode())"`. Set `CHAT_ORIGINAL_KEYS` to
  `{"2026-11": "<that value>"}` and `CHAT_ORIGINAL_ACTIVE_KEY_ID` to `2026-11`. Key ids are 1
  to 32 of `A-Z a-z 0-9 _ . -`.
- Rotate: add the new key to the JSON and point `CHAT_ORIGINAL_ACTIVE_KEY_ID` at it. Keep the
  old key until `CHAT_ORIGINAL_RETENTION_DAYS` have passed since the switch (the purge has then
  removed what it sealed); a key removed early makes those originals unreadable (`original:
null`, ERROR `chat_original_unreadable`).
- Only the api needs these; the worker's purge clears rows without decrypting.

#### Live positions (#350)

While a pro is on the way, the API keeps their latest position in Redis for
`PRO_LOCATION_TTL_SECONDS` and deletes it at the check-in. That is the whole retention only if
that Redis writes the position nowhere else, so the positions get a Redis service of their own,
`redis-location`, apart from `Redis` (the queue's, which stays durable):

- Create `redis-location` from the `redis:7` image, with no public networking (no domain, no
  TCP proxy). Define `REDIS_PASSWORD` on it yourself, as that service's own variable: a random
  hex value (`openssl rand -hex 32`), so it needs no escaping in a URL. It is not the Railway
  Redis template's `REDISPASSWORD`; nothing below reads that one.
- Start it with no RDB snapshot, no AOF and the slow log off. Railway runs a start command
  without a shell, so a bare `$REDIS_PASSWORD` would become the password itself, literally.
  The command starts a shell to read the variable and stops if it is empty:

  ```sh
  sh -c 'test -n "$REDIS_PASSWORD" || { echo "REDIS_PASSWORD is empty" >&2; exit 1; }; exec redis-server --save "" --appendonly no --slowlog-log-slower-than -1 --requirepass "$REDIS_PASSWORD"'
  ```

- No volume, no backups and no replica on that service: what it holds must end with the
  container. The API's check does not cover these three; they are the deployer's to keep.
- Set `LOCATION_REDIS_URL` on api to
  `redis://:${{redis-location.REDIS_PASSWORD}}@${{redis-location.RAILWAY_PRIVATE_DOMAIN}}:6379`.
  Never point it at `Redis`, the queue's. The worker does not use it.

The API asks that Redis what it keeps (`CONFIG GET save`, `appendonly`,
`slowlog-log-slower-than`) before a position goes in or out, and again every
`LOCATION_REDIS_RECHECK_SECONDS`. In staging and production:

| State of the positions' Redis | Log                                                         | Position routes            |
| ----------------------------- | ----------------------------------------------------------- | -------------------------- |
| `LOCATION_REDIS_URL` unset    | WARNING `location_redis_not_configured` at startup          | 503 `location_unavailable` |
| snapshots, AOF or slow log on | ERROR `location_redis_not_ephemeral` (`unsafe` lists which) | 503 `location_unavailable` |
| `CONFIG GET` refused          | ERROR `location_redis_unverifiable`                         | 503 `location_unavailable` |
| all three off                 | INFO `location_redis_ephemeral`                             | work                       |

Each refused request also logs ERROR `pro_location_refused` with the job id and the reason,
never a coordinate. The API starts in all four states, and On my way, check-in, start and every
other job step keep working. Fixing the Redis brings the routes back within the check interval,
with no redeploy. In development and test the positions use `REDIS_URL`'s Redis and the same
findings are only logged (WARNING).

`LOCATION_REDIS_ASSUME_EPHEMERAL=true` is only for a managed Redis that refuses `CONFIG GET`:
the deployer vouches that it keeps nothing (WARNING `location_redis_assume_ephemeral_set` at
startup, `location_redis_assumed_ephemeral` at the check). It never overrides a Redis that
answers that it keeps positions. Leave it unset on Railway.

The pro's route to the job's address (#351, `GET /v1/jobs/{job_id}/route`) is computed by
Mapbox with `MAPBOX_ACCESS_TOKEN` and kept for `ROUTE_CACHE_SECONDS` in `redis-location` too,
never in `Redis`: a route starts at the pro's position and ends at the customer's address.
Without the token that route answers 503 `route_unavailable` (WARNING `mapbox_not_configured`)
and nothing else changes; in the three refused states above it answers 503
`location_unavailable` (ERROR `job_route_store_refused`).

Verify after the first deploy, from a shell in `redis-location` (`railway ssh --service
redis-location`; the image has `redis-cli`, and the shell has the service's `REDIS_PASSWORD`):

```sh
redis-cli AUTH "$REDIS_PASSWORD"   # OK
redis-cli AUTH '$REDIS_PASSWORD'   # WRONGPASS: the literal text is not the password
for name in save appendonly slowlog-log-slower-than; do
  redis-cli --no-auth-warning -a "$REDIS_PASSWORD" CONFIG GET "$name"
done                               # save "" (empty line), appendonly no, slowlog-log-slower-than -1
```

Pass the password with `-a`: `redis-cli -u` turns the URL's empty user name into a failing
`AUTH "" <password>`, while the API's client sends the password alone. Then check that the
service has no volume, and that the api log shows `location_redis_ephemeral` after the first
position. Confirm the exact dashboard steps on the first setup and update this section.

Leave `HOST` unset: the default `::` listens on IPv6 (private network) and IPv4 (public proxy
and healthcheck) on one socket.

#### Geocode on save (#384)

`GEOCODE_ON_SAVE` is `false` by default: each computed route then places the job's address
itself, with Mapbox's temporary geocoding (one more call per computed route, and nothing
kept). With `true`, the worker places each new request's address once, with Mapbox's
**permanent** geocoding (`permanent=true`), and keeps the point on the address row; the route
reads it and asks Mapbox for directions only. Setting it to `true` starts billed calls, so
it is a billing change: Cesar's decision in every environment, never Sentinel's, although the
variable is not a secret. Before setting it to `true`:

1. Cesar adds a payment method to the Mapbox account. Permanent geocoding is billed per
   request, apart from the temporary kind, and Mapbox refuses it to an account without one.
2. Set `GEOCODE_ON_SAVE=true` on api and worker (a shared variable), and give the worker
   `MAPBOX_ACCESS_TOKEN`: the api only queues the job, the worker makes the call. The
   customer's save waits for the queue at the most (`JOB_ENQUEUE_TIMEOUT_SECONDS`), never
   for Mapbox; the worker's call takes `MAPBOX_TIMEOUT_SECONDS` at the most.
3. Optional, once: fill the addresses made before, from a shell in the worker.
   `python -m scripts.backfill_address_geocodes` is a dry run that counts the addresses
   without a point: every one, whatever became of its request (open, cancelled, expired or
   done). With `--apply` each of them is one billed call (`GEOCODE_BACKFILL_BATCH_SIZE` ids
   per step, at most `GEOCODE_BACKFILL_PER_MINUTE` calls a minute). It stops when Mapbox is
   unavailable three times in a row and can be run again; a later run asks once more, and
   is billed once more, for each address that kept nothing.

   `--apply` never runs unattended, because every call it makes is billed. Run it from an
   interactive shell: `railway ssh --service worker`, or a local terminal with the service's
   variables. Before Mapbox is asked anything it prints how many addresses it would send and
   that each one is billed, then waits for the operator to type that number. Without a
   terminal on standard input (a pipe, a file, a scheduled job), at the end of the input, on
   an empty line or on any other answer it exits 1 and asks Mapbox nothing. There is no
   `--yes` flag and no variable that skips the question. The run then asks about that many
   addresses at the most.

One caller at a time asks Mapbox about an address. The worker's job and the backfill both
claim the address in the queue's Redis (`REDIS_URL`, never `redis-location`) before the
call, and look at the row again once they hold the claim; a claim ends by itself a few
seconds after `MAPBOX_TIMEOUT_SECONDS`, so a holder that died blocks nobody. An address
claimed elsewhere is skipped (outcome `busy`): the worker leaves it to the holder and the
backfill counts it and moves on. If that Redis is unreachable the backfill stops with exit 1
before asking about the address, and the worker's job fails without asking.

A point is kept only when Mapbox places the address in its own state and ZIP. Anything else
keeps nothing and the route places that address itself, as with the switch off: WARNING
`address_geocode_not_kept` with the address id and the outcome (`no_result`, `mismatch`,
`unavailable`, `changed`), never the address or a coordinate. The job has one try, since
each run that reaches Mapbox is billed: one that a worker deploy interrupts is not run again
(ARQ logs it as cancelled, then as past its retries) and its address stays without a point.

Budget and abuse. One new request is one permanent geocoding call. What bounds the calls is
the request limiter, a rate bound and not a spending cap: `REQUEST_CREATE_LIMIT` creations
per customer per `REQUEST_CREATE_WINDOW_SECONDS` (10 an hour by default). It fails open when
its Redis is down (the availability policy of every limiter here), and there is no global
budget for the vendor across accounts and windows. So Cesar sets a spending alert in the
Mapbox account before turning the switch on. Turning it off takes the variable change and
the restart of api and worker that follows it: from then on no call is made, jobs already
queued included. It cannot undo a call already sent; the points kept so far stay in use.

### worker

The worker builds the same settings when `app/worker.py` is imported, so the same validators
stop it: without every required variable it crash-loops under its `ALWAYS` restart policy and
never logs `worker_started`. Use the same values as api.

| Variable                           | Value                                                      | Secret          | Source      |
| ---------------------------------- | ---------------------------------------------------------- | --------------- | ----------- |
| `APP_ENV`                          | same as api                                                | no              | D3.1 (#22)  |
| `LOG_LEVEL`                        | same as api                                                | no              | D3.1 (#22)  |
| `DATABASE_URL`                     | `${{Postgres.DATABASE_URL}}`                               | yes (reference) | D3.1 (#22)  |
| `REDIS_URL`                        | `${{Redis.REDIS_URL}}`                                     | yes (reference) | D3.1 (#22)  |
| `SENTRY_DSN`                       | same as api                                                | no              | D3.1 (#22)  |
| `JWT_SECRET`                       | same as api                                                | yes             | D4.2 (#25)  |
| `RATE_LIMIT_KEY_SECRET`            | same as api                                                | yes             | #137        |
| `REFRESH_ROTATION_SECRET`          | same as api                                                | yes             | #152        |
| `TWILIO_ACCOUNT_SID`               | same as api                                                | no              | D4.3 (#26)  |
| `TWILIO_AUTH_TOKEN`                | same as api                                                | yes             | D4.3 (#26)  |
| `TWILIO_VERIFY_SERVICE_SID`        | same as api                                                | no              | D4.3 (#26)  |
| `RESEND_API_KEY`                   | same as api                                                | yes             | D4.3 (#27)  |
| `EMAIL_FROM`                       | same as api                                                | no              | D4.3 (#27)  |
| `S3_ENDPOINT_URL`                  | same as api                                                | no              | D6.2 (#35)  |
| `S3_BUCKET`                        | same as api                                                | no              | D6.2 (#35)  |
| `S3_ACCESS_KEY_ID`                 | same as api                                                | yes             | D6.2 (#35)  |
| `S3_SECRET_ACCESS_KEY`             | same as api                                                | yes             | D6.2 (#35)  |
| `STRIPE_SECRET_KEY`                | same as api                                                | yes             | D7.1 (#39)  |
| `PUBLIC_API_URL`                   | same as api                                                | no              | D7.1 (#39)  |
| `EXPO_ACCESS_TOKEN`                | optional; set it only if Expo enhanced push security is on | yes             | D10.3 (#54) |
| `ORPHAN_UPLOAD_MIN_AGE_HOURS`      | same as api (shared variable)                              | no              | #191, #298  |
| `JOB_PHOTO_ATTACH_MAX_AGE_MINUTES` | same as api (shared variable)                              | no              | #298        |
| `GEOCODE_ON_SAVE`                  | same as api (shared variable); see "Geocode on save"       | no              | #384        |
| `MAPBOX_ACCESS_TOKEN`              | same as api; only needed with `GEOCODE_ON_SAVE=true`       | yes             | #384        |

`ORPHAN_UPLOAD_MIN_AGE_HOURS` and `JOB_PHOTO_ATTACH_MAX_AGE_MINUTES` must hold the same values
on api and worker: the api refuses job photo uploads older than the window, and the worker's
orphan sweep deletes only uploads older than the minimum age. Each service checks the rule
(window at most half the minimum age) against its own values only, so set both as shared
variables, or the sweep can delete a photo a job just attached (#298).

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
2. Add Postgres and Redis to each environment; enable backups and PITR. Add a second
   Redis, `redis-location`, with no volume and no backups ("Live positions" above).
3. Create api, worker and web from the GitHub repo with the root directories and config file
   paths above.
4. Set the variables above, then enable Wait for CI.
5. Generate public domains for api and web in staging; keep production private until D20.
6. For Sentinel: a project token scoped to the staging environment, and a GitHub token limited
   to issues and pull requests.
7. After the first deploy of each environment, create the first admin from a shell on the api
   service: `python -m scripts.create_staff_user` (it asks for the email and the role,
   and the password twice without echoing it). Public registration never creates staff
   accounts (#155). For a scripted setup: `--email … --role admin --password-env NAME`, with
   the password only in that environment variable.
8. The launch data seeds itself: the api's pre-deploy command (see Services) runs
   `python -m scripts.seed_categories` and `python -m scripts.seed_service_areas` after the
   migrations on every deploy, so a changed seed file lands with the deploy that ships it.
   Running them every time is safe, because they insert what is missing and never update or
   delete a row. The trade-off: a category deleted from the database comes back on the next
   deploy. That holds until the admin manages categories (#41); remove the seeds from the
   pre-deploy command then. Without the service areas, every request is refused
   with `zip_not_served`. The areas are South Florida with Broward active (#9). The sources and
   the rebuild steps are in `apps/api/app/modules/service_areas/SOURCES.md`.
   - **Switching a county on later** (Miami-Dade or Palm Beach): use the admin (#41), or run
     SQL. Example: `UPDATE service_areas SET active = true WHERE zip_code IN (...)` with that
     county's ZIPs from `seed_data.json`. Editing `active` in the file does nothing to rows that
     already exist.
