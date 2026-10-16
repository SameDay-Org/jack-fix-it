# AGENTS.md

Rules for every agent and human in this repo. Also read `apps/<area>/AGENTS.md` for the app you
touch. Maestri pipeline role prompts (Foreman, Builder, Gatekeeper, Vault, Sentinel) live in
`docs/agents/`.

## Sources of truth

- `docs/jack-fix-it-contexto.md`: product, business rules, payments, legal copy, decisions (§11).
- `docs/mvp-plan.md`: scope and daily tasks with stable IDs (`D8.2` = day 8, item 2).
- `docs/adr/`: accepted technical decisions.
- `docs/glossary.md`: customer-visible statuses, their i18n keys, domain terms.
- `docs/railway.md`: services, variables, deploys, restore drill.
- The GitHub issue and the Foreman's prompt for the task at hand.

When two of these disagree, or a task needs a rule none of them states, stop: comment the
question on the issue and add `needs-human`. Business rules come from these documents only.

## Pending decisions

Still open. Code reads them from `settings` or env; tests use explicit fixture values. A task
that needs the actual value stops with `needs-human` and lists the options.

- Take rate and who absorbs Stripe fees (#2)
- Cancellation and refund rule after the free 24 h window (#3)
- Warranty window length and its legal wording (#4)
- Portuguese in the app or only in BDC support (#7)

Decided: hosting is Railway Pro, staging from `develop`, production from `main`
(`docs/adr/0001-hosting-railway.md`).

## Repo layout

```
apps/api/         FastAPI + SQLAlchemy 2 async + Alembic + ARQ worker (Python 3.12, uv)
apps/web/         Next.js: landing (src/app/(marketing)) and admin/BDC panel (src/app/admin)
apps/mobile/      Expo + Expo Router: one app, customer and pro modes
packages/shared/  @jack/shared: TypeScript types generated from the API's OpenAPI schema
docs/             plan, context, ADRs, glossary, Railway, agent roles
scripts/          repo scripts (setup-labels.sh)
```

## Commands

```sh
docker compose up -d                  # local Postgres 16 + Redis 7 (POSTGRES_PORT/REDIS_PORT to move ports)
pnpm install                          # JS workspace (Node 22, pnpm 10 via corepack)
cd apps/api && uv sync                # Python env

# Checks: all green before opening a PR (CI runs the same)
cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy . && uv run pytest
pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm gen:api-types                    # after any API schema change; commit packages/shared
```

Per-app run commands are in `README.md` and each app's `AGENTS.md`.

## Git flow

- Branch from an up-to-date `develop`: `feat/<issue>-<slug>`, `fix/<issue>-<slug>` or
  `chore/<issue>-<slug>`.
- Conventional Commits in English: `feat(api): ...`, `fix(mobile): ...`, `docs: ...`, `ci: ...`.
  Scopes: `api`, `web`, `mobile`, `shared`, `infra`, `docs`.
- One issue, one small PR (target under 400 changed lines) against `develop`, using the PR
  template: `Closes #N`, plan task ID, each acceptance criterion pointing to code and test.
- `develop` deploys to staging and `main` to production on Railway. Releases are a
  `develop` → `main` merge done by Cesar.

GitHub branch protection is not available on the current plan, so protection is by process:

- Only Cesar merges, and only with green CI.
- Agents push only to their own feature branch. Foreman, Gatekeeper, Vault and Sentinel use
  tokens without `contents:write`. The Builder's token needs `contents:write` to push its
  branch and GitHub cannot limit that to one branch on this plan, so for the Builder this rule
  rests on this instruction and on review.
- Railway "Wait for CI" holds every deploy until CI is green on that commit.

## Labels

State machine (issue on the left, its PR on the right):

```
agent:ready ─Foreman─▶ agent:in-progress ─Builder opens PR─▶ agent:review
agent:review ─Gatekeeper REQUEST_CHANGES─▶ agent:changes-requested ─Builder fixes─▶ agent:review
agent:review ─Gatekeeper APPROVE, no needs-vault─▶ agent:approved ─▶ Cesar merges
agent:review ─Gatekeeper APPROVE + needs-vault─▶ stays agent:review ─Vault─▶ agent:approved
                                                                  └─Vault REQUEST_CHANGES─▶ agent:changes-requested
any step ─▶ needs-human (the pipeline stops until Cesar answers)
```

After Vault requests changes, the Gatekeeper reviews the fixes again before the Vault does. A
third review round that still has blocking items goes to `needs-human`.

| Label                     | Meaning                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agent:ready`             | Issue is ready; the Foreman may write the Builder prompt.                                                      |
| `agent:in-progress`       | Foreman released the prompt; a Builder is working.                                                             |
| `agent:review`            | PR waits for review: the Gatekeeper, or the Vault once the Gatekeeper approved a `needs-vault` PR.             |
| `agent:changes-requested` | A reviewer requested changes; back to the Builder.                                                             |
| `agent:approved`          | All required reviews approved; ready for Cesar's merge.                                                        |
| `needs-vault`             | PR touches payments, Stripe, webhooks, auth, permissions, `audit_log`, file uploads or chat redaction.         |
| `needs-human`             | Pipeline stopped: a question, a pending decision, a conflict, or round 3 of review. Waiting for Cesar.         |
| `has-migration`           | PR contains an Alembic migration. One open at a time: the Foreman holds other migration tasks until it merges. |
| `deploy:failed`           | Open deploy incident. Sentinel's deploy-fix issues carry it with `agent:ready` and an area label.              |
| `area:api`                | `apps/api` (FastAPI + ARQ worker).                                                                             |
| `area:web`                | `apps/web` (Next.js landing + admin/BDC).                                                                      |
| `area:mobile`             | `apps/mobile` (Expo / React Native).                                                                           |
| `area:infra`              | Hosting, CI/CD, backups.                                                                                       |
| `area:docs`               | `docs/`: plan, ADRs, glossary, runbooks.                                                                       |
| `area:design`             | Design system, Figma, store assets.                                                                            |
| `type:feature`            | Product functionality.                                                                                         |
| `type:chore`              | Tooling, setup, infra plumbing.                                                                                |
| `type:docs`               | Documentation, ADRs, runbooks.                                                                                 |
| `type:ops`                | Operational task outside the codebase.                                                                         |
| `type:qa`                 | Testing and quality.                                                                                           |
| `type:decision`           | Pending business or technical decision.                                                                        |
| `bug`                     | Something isn't working.                                                                                       |
| `risk:payments`           | Touches money, Stripe, transfers or refunds: Vault review required.                                            |
| `risk:security`           | Touches auth, permissions, files, PII or chat redaction: Vault review required.                                |
| `owner:human`             | A person does this; not for the agent pipeline.                                                                |
| `priority:high`           | External dependency or long lead time: start early.                                                            |
| `blocked`                 | Waiting on a decision or partner input.                                                                        |
| `post-mvp`                | Roadmap after launch; out of MVP scope.                                                                        |

`scripts/setup-labels.sh` creates or updates all of them.

## Rules that never break

The Gatekeeper and the Vault block any PR that breaks one of these.

- **Money.** Amounts are integer cents (USD) in `*_cents` columns, computed only in the backend
  from database values; amounts sent by a client are never trusted. Every Stripe charge,
  transfer and refund carries a deterministic idempotency key. Webhooks verify the signature on
  the raw body, are recorded in `webhook_events` and are processed once. A transfer happens only
  after confirmation or the 48 h auto-confirm, and an open dispute blocks it. No card
  pre-authorization (ADR 0006).
- **State machine.** Job and request statuses change only through the backend state machine
  (D12.1, #60), which writes `job_events`; an invalid transition returns 409.
- **Access.** Every endpoint enforces role and ownership, with a test proving user A cannot read
  or change user B's resource by ID.
- **Secrets.** Secrets live only in Railway variables or an untracked local `.env`.
  `.env.example` lists their names, commented, with the task that adds them.
- **PII.** Logs, Sentry and analytics carry ids only: no names, emails, phones, addresses or
  message text. Request logs record the path without the query string; Sentry runs with
  `send_default_pii=False`.
- **i18n.** Every user-facing string goes through i18next, with EN and ES added in the same PR
  (key-parity tests enforce it).
- **Legal copy.** Until legal approval, copy never promises insurance, a labor warranty, escrow,
  guaranteed refunds or licensing in every category. Use "Support when you need it", "Verified
  information where applicable", "Clear service records", "Secure payment experience".
  "Warranty" and "protected payment" are internal names only.
- **Real features only.** The UI shows what works today: no voice input, no call to action
  without a working flow, no invented reviews or testimonials.
- **Config, not literals.** Region, service areas and ZIPs, categories, money values, take
  rate, time windows and timeouts come from the database (`settings`, `service_areas`,
  `categories`) or env.
- **Stack.** Use the libraries already in the repo. A new dependency needs a justification in
  the PR and Cesar's approval; a stack change needs an ADR. Native modules go in with
  `npx expo install`.
- **Migrations.** One reversible Alembic migration per PR, labeled `has-migration`;
  `uv run alembic heads` shows exactly one head.
- **API contract.** A PR that changes the API schema also commits the regenerated
  `packages/shared` (`pnpm gen:api-types`); CI fails otherwise.
