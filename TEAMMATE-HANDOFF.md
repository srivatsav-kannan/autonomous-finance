# AP teammate handoff — 2026-10-25

The AP work is available in the same GitHub repository across the branches below. **The live branch is the tested runtime subset, not the complete extended AP implementation.** Fetch both branches to obtain the source, review packet and final sandbox evidence.

| Branch | Contents |
| --- | --- |
| [`codex/ap-system-live-auth0`](https://github.com/srivatsav-kannan/autonomous-finance/tree/codex/ap-system-live-auth0) | Auth0 runtime and the completed $77 sandbox flow, original synthetic PDFs, provider readbacks and reconciliation screenshots |
| [`codex/ap-case-agent`](https://github.com/srivatsav-kannan/autonomous-finance/tree/codex/ap-case-agent) — [PR 109](https://github.com/srivatsav-kannan/autonomous-finance/pull/109) | Broader AP implementation, durable case worker, tax/physical/dimension support and the prepared Claude review packet |
| [`codex/qbo-sandbox-settlement`](https://github.com/srivatsav-kannan/autonomous-finance/tree/codex/qbo-sandbox-settlement) — [PR 106](https://github.com/srivatsav-kannan/autonomous-finance/pull/106) | Earlier QBO integration and $678.60 sandbox settlement evidence; base of PR 109 |

## Get the files

```sh
git clone --branch codex/ap-system-live-auth0 https://github.com/srivatsav-kannan/autonomous-finance.git
cd autonomous-finance
git fetch origin
# Optional second directory for the broader implementation and review packet:
git worktree add --detach ../autonomous-finance-ap-full origin/codex/ap-case-agent
```

Use Node >=24.18.0 and run `npm ci` in each checkout you intend to run. The lockfile is committed; `node_modules` is generated locally. These branches have different validated scopes; integrating them is separate work, not an already-tested merge.

## Start with the verified evidence

- [Final live result and limitations](docs/ap-orchestration/evidence/agent-live-20261025/ROLLOUT.md)
- [Machine-readable flow](docs/ap-orchestration/evidence/agent-live-20261025/flow-summary.json)
- [Four original synthetic PDFs](docs/ap-orchestration/evidence/agent-live-20261025/sources/)
- [Independent provider readback](docs/ap-orchestration/evidence/agent-live-20261025/final-provider-readback.json)
- [Final bank reconciliation](docs/ap-orchestration/evidence/agent-live-20261025/final-bank-reconciliation.png)
- [Issue 108 remaining work](docs/ap-orchestration/evidence/agent-live-20261025/ISSUE-108-REMAINING.md)
- [Claude review packet on the broader branch](https://github.com/srivatsav-kannan/autonomous-finance/tree/codex/ap-case-agent/docs/ap-orchestration/claude-review)

The $77 case passed missing-evidence wait, evidence resumption, user bill approval, separate user payment authorization, Increase sandbox settlement, QBO Bill 147 / BillPayment 148 and bank reconciliation with zero unresolved items. The current case worker is deterministic; a real model/tool loop and the other issue 108 gaps remain. The prepared review packet is not a completed Claude review or practitioner sign-off. CI was intentionally skipped.

## Running on another laptop

The root README's general quick start runs the simulated scenario. For the separate AP Auth0 environment, follow [AUTH0-SETUP.md](docs/ap-orchestration/AUTH0-SETUP.md) and [QUICKBOOKS-SETUP.md](docs/ap-orchestration/QUICKBOOKS-SETUP.md). The final evidence above supersedes their earlier progress/status paragraphs; setup requirements still need to be satisfied for your own environment.

The AP environment uses UI 5192, gateway 8825 and Convex 3252/3253. Provision a fresh isolated backend/run, distinct scoped AP and payments seats, a reviewed sandbox bank account/beneficiary, and the explicit human identity binding. The setup documents describe these requirements but are not a one-command provisioning/reproduction script. Keep independent human payment authorization enabled.

Git includes source, configuration examples, synthetic originals and sanitized evidence. It does **not** include API keys, OAuth tokens, private mappings, seat credentials, live browser sessions, `var/`, `.env.local`, or the local database. Configure these privately; cloning does not restore the current case IDs or authenticated sessions. Original ingestion requiring LlamaParse also needs a private parser key. Do not replay saved settled payment IDs as new transactions.

The current laptop's sandbox runs from a forensic database recovery copy. The original damaged database was preserved, and the limitations are recorded in the final result. That recovery copy is not a portable database seed; a fresh checkout should use a fresh isolated backend.
