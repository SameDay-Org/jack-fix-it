# Agent roles (Maestri)

Five roles run the pipeline. Each file holds that role's prompt verbatim: edit it here, then
paste it into Maestri. Every role also follows the root `AGENTS.md`, whose
[Labels](../../AGENTS.md#labels) section holds the label meanings and the state machine.

| Role                        | Acts on                                                  | Produces                                           | Writes to the repo  |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ------------------- |
| [Foreman](foreman.md)       | Issue labeled `agent:ready`; Sentinel's deploy-fix issue | Builder prompt as an issue comment                 | No                  |
| [Builder](builder.md)       | The Foreman's prompt                                     | PR against `develop`, labeled `agent:review`       | Its own branch only |
| [Gatekeeper](gatekeeper.md) | PR labeled `agent:review` with CI finished               | PR review with a verdict                           | No                  |
| [Vault](vault.md)           | PR labeled `needs-vault`, after the Gatekeeper approves  | Security and payments review with a verdict        | No                  |
| [Sentinel](sentinel.md)     | Each merge into `develop`                                | Deploy check, deploy-fix issues, allowlisted fixes | No (staging config) |

Only Cesar merges. Services, variables and Sentinel's allowlist on Railway: `docs/railway.md`.
