# APEX World 9 AP replay runbook (issue #107)

This replays two APEX contract-attorney invoices through the AP system on an isolated local backend. It uses FakeBank and simulated local identities only. It makes no QuickBooks, Increase, Auth0, LlamaParse or model call.

**APEX is a synthetic company dataset authored for an accounting benchmark** ([Mercor/Ramp APEX-Accounting](https://huggingface.co/datasets/mercor/apex-accounting), [Harbor distribution](https://huggingface.co/datasets/mercor/apex-accounting-harbor), CC BY 4.0, revision `1662b7e4c3b04b8717f2f723df823e7b6cbe2118`). It is not a real customer's books and not Sweetgreen data.

Recorded result: [evidence/apex-107/README.md](evidence/apex-107/README.md).

## What you need

- This checkout with `npm ci` done.
- Poppler (`pdftotext`, `pdfinfo`, `pdftoppm`) at `/opt/homebrew/bin`. The parser reads the PDF's own text layer. No paid parser is involved.
- The git-ignored APEX files under `var/benchmarks/finance-eight/private/raw/apex-world/` (prepare them with `scripts/external-bench/prepare.py` as described in [docs/evals/external-benchmarks.md](../evals/external-benchmarks.md), or set `APEX_WORLD_ROOT`). The replay reads `filesystem/contract_attorney_invoices/`, `filesystem/operating_bank_statements/`, `filesystem/qbo_general_ledger_detail_2024.xlsx`, `filesystem/ap_aging_2024_12_31.xlsx` and `apps_data/quickbooks/{ap_bill_ledger_2024.csv,operating_bank_transactions_2024.csv,vendor_master_list.xlsx}`. Never commit them.
- Free ports 3460/3461 (Convex), 8847 (gateway) and 5197 (UI). The harness refuses any other backend.

## Run it

Every command uses a clean environment so no provider key from your shell can leak in. The harness also refuses to start if one is present.

1. Start a fresh local Convex backend from this checkout and keep it running.

   ```bash
   env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" CONVEX_AGENT_MODE=anonymous CONVEX_DISABLE_TELEMETRY=1 node node_modules/convex/bin/main.js dev --typecheck disable --tail-logs disable --local-backend-version precompiled-2026-10-10-72ce13c --local-cloud-port 3460 --local-site-port 3461
   ```

   The first deploy stops on the auth config. Set the synthetic issuer once, then touch `convex/auth.config.ts` so it redeploys.

   ```bash
   env -i PATH="$PATH" HOME="$HOME" CONVEX_AGENT_MODE=anonymous node node_modules/convex/bin/main.js env set AP_HUMAN_AUTH_ISSUER https://ap-demo.invalid
   ```

   ```bash
   env -i PATH="$PATH" HOME="$HOME" CONVEX_AGENT_MODE=anonymous node node_modules/convex/bin/main.js env set AP_HUMAN_AUTH_AUDIENCE ap-apex107-local
   ```

2. Start the replay gateway and keep it running. It creates the run, its agent seats and six simulated human seats.

   ```bash
   env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" AGENT_LLM=off node --import tsx scripts/ap-system/apex-replay.ts serve
   ```

3. Start the UI in another terminal.

   ```bash
   env -i PATH="$PATH" HOME="$HOME" AP_SYSTEM_GATEWAY_URL=http://127.0.0.1:8847 VITE_CONVEX_URL=http://127.0.0.1:3460 node node_modules/vite/bin/vite.js --config console/vite.config.ts --host 127.0.0.1 --port 5197 --strictPort
   ```

4. Run the phases in this order. Each one prints one JSON line and writes a private record to `var/apex107-replay-20261025/<phase>.json`.

   | Phase | What it does |
   | --- | --- |
   | `inventory` | Parses all 21 invoice PDFs locally and compares them with the AP ledger and bank export. No backend writes. |
   | `case1-intake` | Uploads `Avila_AVILA-202412-A6.pdf` through `/api/ap-system/intake`, checks the parsed fields against the ledger, records the field review and shows a payment request is refused before any bill exists. |
   | `case1-evidence` | Uploads a revision with two generated PDFs labeled SIMULATED: a rate agreement and a service acceptance. APEX has neither. |
   | `governance` | Activates the SIMULATED services policy and supplier master (trusted contact, callback and beneficiary are all simulated). The backend refuses an invoice as trusted-contact evidence, so this runs after the simulated agreement exists. |
   | `case1-hold` | Proposes acceptance citing only the invoice. The backend holds it on `missing_contract` and `missing_receipt`. |
   | `case1-approve` | Proposes acceptance citing the simulated agreement and acceptance. The simulated matter owner and finance approver vote. The bill is recognized. |
   | `case1-pay` | Requests the $3,000 payment as the payments agent, shows a stale snapshot is refused, then authorizes as the simulated payment authorizer. No bank contact yet. |
   | `worker` | Runs the payment dispatcher against FakeBank, explicitly simulates settlement, runs the evidence worker, then repeats both to show nothing is reposted. |
   | `case2` | Verifies the historical $3,500 payment against the ledger, bank export, GL, AP aging and April statement. Uploads the invoice and shows a payment request is refused. The importer never proposes approval or payment for a source-paid invoice. |
   | `reimport` | Re-uploads both invoices (same key, then new key and new filename) and resubmits payment requests. Counts of cases, bills, versions, commands, journals, bank rows and FakeBank transfers must not change. |
   | `report` | Writes `docs/ap-orchestration/evidence/apex-107/run.json` and `inventory.json`. |

   ```bash
   for p in inventory case1-intake case1-evidence governance case1-hold case1-approve case1-pay worker case2 reimport report; do env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" AGENT_LLM=off node --import tsx scripts/ap-system/apex-replay.ts $p || break; done
   ```

5. Screenshots. Run between phases to capture a state (`<stage>` is a file prefix). `PLAYWRIGHT_CHANNEL=chrome` uses the installed Chrome with a temporary profile instead of downloading Playwright's browser.

   ```bash
   env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" PLAYWRIGHT_CHANNEL=chrome node --import tsx scripts/ap-system/apex-replay-screens.ts 03-settled-matched
   ```

   Or open `http://127.0.0.1:5197/ap-system` and choose a SIMULATED actor.

## Rules the harness keeps

- Historical APEX outcomes (ledger status, bank row `OBT-000200`, GL entries) are read from the source files and recorded as historical. They are never loaded into FakeBank or the ledger. The FakeBank transfer and debit are new local observations.
- The parser never reads the ledger. The ledger comparison runs after parsing, as a check.
- Every added policy, approval, contact, beneficiary, agreement and acceptance is labeled SIMULATED in its name, reason or document text.
- Phases are safe to rerun. They reuse idempotency keys and skip finished steps. To start over, stop the backend and use a fresh checkout or delete `.convex/local` and `var/apex107-replay-20261025` in this worktree only.

## Not covered here

Increase sandbox payment, QuickBooks write and readback, and real Auth0 login are blocked until they run on JJ's machine with his sandbox credentials. The same cases can be replayed there with the normal sandbox runtime once the parser and policy pieces from this PR are wired in.
