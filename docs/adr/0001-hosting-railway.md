# 0001. Host staging and production on Railway Pro

- **Status:** accepted
- **Date:** 2026-10-16
- **Issue:** #1

The two options were the Hostinger VPS we already have (Docker Compose with Caddy, near-zero
cost, but security, backups and operations would be on us) and Railway Pro (managed services,
Postgres with scheduled backups and PITR, private network, SOC 2 Type II, audit log, deploy
rollback, variable monthly cost). Both run in the US.

We chose **Railway Pro**. One project with two environments: **staging** deploys from `develop`
and **production** from `main`. Services: `api`, `worker` and `web` built from this repo, plus
Railway Postgres (scheduled backups + PITR) and Redis on the private network. Railway provides
the managed backups, private network and deploy rollback that the VPS option would leave to us.

## Consequences

- No Hostinger, no Caddy and no production Docker Compose. `docker-compose.yml` exists for
  local development only (Postgres and Redis).
- Service settings live as config files in the repo (`apps/api/railway.api.json`,
  `apps/api/railway.worker.json`, `apps/web/railway.json`); setup, variables, "Wait for CI" and
  the restore drill are in `docs/railway.md`.
- The code stays portable: configuration only through environment variables, file storage
  through the generic S3 API (Cloudflare R2 or Railway Buckets).
