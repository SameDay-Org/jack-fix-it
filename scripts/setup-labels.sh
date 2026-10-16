#!/usr/bin/env bash
# Creates or updates every label the project uses. Safe to re-run (--force overwrites
# color and description). Meanings and the agent state machine: AGENTS.md, "Labels".
#
# Usage: scripts/setup-labels.sh [owner/repo]    (default: the current gh repo)
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

label() {
  gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force
}

# Agent pipeline state
label "agent:ready"             "2EA44F" "Foreman can pick it up"
label "agent:in-progress"       "FBCA04" "Builder working"
label "agent:review"            "1D76DB" "Waiting for Gatekeeper"
label "agent:changes-requested" "D93F0B" "Back to Builder"
label "agent:approved"          "0E8A16" "Ready to merge"
label "needs-vault"             "B60205" "Waiting for Vault security/payments review"
label "needs-human"             "7057FF" "Pipeline stopped: waiting for Cesar"
label "has-migration"           "FFA657" "PR contains an Alembic migration, one open at a time"
label "deploy:failed"           "B60205" "Open deploy incident"

# Area
label "area:api"    "5319E7" "apps/api (FastAPI + ARQ worker)"
label "area:web"    "006B75" "apps/web (Next.js landing + admin/BDC)"
label "area:mobile" "0E8A16" "apps/mobile (Expo / React Native)"
label "area:infra"  "6E7781" "Hosting, CI/CD, backups"
label "area:docs"   "BFDADC" "docs/: plan, ADRs, glossary, runbooks"
label "area:design" "F9D0C4" "Design system, Figma, store assets"

# Type
label "type:feature"  "1D76DB" "Product functionality"
label "type:chore"    "C5DEF5" "Tooling, setup, infra plumbing"
label "type:docs"     "0075CA" "Documentation, ADRs, runbooks"
label "type:ops"      "BFD4F2" "Operational task outside the codebase"
label "type:qa"       "FBCA04" "Testing and quality"
label "type:decision" "D93F0B" "Pending business/technical decision"
label "bug"           "d73a4a" "Something isn't working"

# Risk (Vault review required)
label "risk:payments" "B60205" "Touches money, Stripe, transfers or refunds: Vault review required"
label "risk:security" "E99695" "Touches auth, permissions, files, PII or chat redaction: Vault review required"

# Planning
label "owner:human"   "7057FF" "Not for the agent pipeline: a person does this"
label "priority:high" "D73A4A" "External dependency or long lead time: start early"
label "blocked"       "000000" "Waiting on a decision or partner input"
label "post-mvp"      "EDEDED" "Roadmap after launch"
