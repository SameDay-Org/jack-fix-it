# Maestri agent roles

Versioned role prompts for the Jack Fix It pipeline. Edit here first, then paste into Maestri, so the prompts and the repo rules (`AGENTS.md`) change together in reviewed PRs. Each role file contains only the prompt text, to be pasted verbatim.

| Role           | File                | Tool / model                              | Trigger                                           | Output                                                  |
| -------------- | ------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Foreman        | `foreman.md`        | Claude Code, `claude-opus-5-5`, high      | issue labeled `agent:ready`                       | prompt comment, `agent:in-progress`, "Assigned to" line |
| Builder        | `builder.md`        | Claude Code, `claude-opus-5-5`, ultracode | `agent:in-progress`, assigned to Builder          | branch + PR `Closes #N`, label `agent:review`           |
| Builder-Mobile | `builder-mobile.md` | Claude Code, `claude-fable-5-1`           | `agent:in-progress`, assigned to Builder-Mobile   | branch + PR `Closes #N`, label `agent:review`           |
| Gatekeeper     | `gatekeeper.md`     | Codex, `gpt-6-astra`, xhigh               | PR labeled `agent:review`, CI finished            | review comment, labels                                  |
| Vault          | `vault.md`          | Codex, `gpt-6-astra`, xhigh               | PR labeled `needs-vault` after Gatekeeper APPROVE | review comment, labels                                  |
| Sentinel       | `sentinel.md`       | Claude Code, `claude-sonnet-5-5`, high    | routine every 5 minutes                           | deploy comment or `deploy-fix` issue                    |

## Labels

`agent:ready` -> `agent:in-progress` -> `agent:review` -> `agent:changes-requested` (back to `agent:review`) or `agent:approved` -> human merge.
`needs-vault`: payments, Stripe, webhooks, auth, permissions, audit_log, uploads, chat redaction.
`needs-human`: pipeline stopped. `has-migration`: PR with an Alembic migration (one open at a time). `deploy:failed`: opened by Sentinel.
Area labels: `area:api`, `area:web`, `area:mobile`, `area:infra`, `area:docs`.

## Canvas connections

Foreman -> Builder and Builder-Mobile -> Gatekeeper -> Vault (conditional). Sentinel is run by a 5-minute routine. Only Builder-Mobile is connected to the Pixel 8 portal.
