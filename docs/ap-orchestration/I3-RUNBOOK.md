# I3 local recovery rehearsal and laptop walkthrough

Use this runbook for the verified **single `/ap-system` case** rather than combining the older seeded `/ap-demo` recovery with another case. [Observed result and boundaries](evidence/I3-process-recovery.md). USD only; laptop web only. Hosting is a later decision.

## Read the retained run

Open `http://127.0.0.1:5195/ap-system?case=kd74wbhvrp0y8tr74pt603pj6x8gzv2y` while the owned I3 services are running. Choose **I3 simulated operator**. Its banner explicitly distinguishes this from real Auth0 or external bank approval. The retained case is already settled: use the phase screenshots to explain earlier states; do not describe historical decisions as new live approvals.

1. **Source & fields:** select Total amount to inspect its native original highlight, then Supplier name to show the unresolved-location warning. The four original source hashes are in the evidence record. An extracted value, its location and supplier authenticity are separate claims.
2. **Matching:** use `01-missing-receipt.png` for revision1's receiving-owner hold. The current revision2 includes the later receipt. The intake, evaluator and actual evidence are distinct artifacts; revision1 had no future receipt data.
3. **Accounting:** `02-authorized-unexecuted.png` shows recognized AP and separately authorized, queued payment. `03-worker-killed.png` shows in-flight execution while outstanding AP is still678.60. Acceptance alone is not settlement.
4. **Accounting after recovery:** inspect the settled/matched summary and both journal entries. The recognition journal is `s97cbt48b9hcrn7ra4xtg9056n8gy4yn`; the settlement journal is `s975kw97g4z0exqqr98affrrex8gy8wv`, linked to bank debit `txn_6bcd47346f2fa8effb9599a2`. The original transfer is `transfer_f96c1173f62a7494bf159327`. Outstanding AP is0.
5. **History:** show both field reviews, revision2's bill approval, the later receipt delivery and renamed replay deliveries. The same case ID and frozen payment command survive recovery. Show [results.json](evidence/I3/results.json) for the actual process signal,0 recovery create calls, dropped notifications and polling1/0/0 counts.

## Repeat in a fresh isolated environment

The retained run is immutable. Completed phases refuse to overwrite their evidence. Do not rerun setup against the retained backend, any existing I1/I2/Auth0 backend, or an externally connected environment. Reproduction needs a fresh checkout/backend and a securely provisioned copy of the four completed genuine parser jobs and13 referenced artifacts, verified against [parser-cache-hashes.json](evidence/I3/parser-cache-hashes.json). Raw results are not bundled publicly because they contain signed URLs. A cache miss fails; the harness does not submit to the provider.

The harness fixes run`ap97-i3-20261025`, backend3256/site3257, gateway8827 and UI5195. Verify these ports are free before allocating a fresh reproduction. Use Node and dependencies from this repository, Convex local backend`precompiled-2026-10-10-72ce13c`, and the Homebrew OCR paths declared in the harness. Start Convex with a clean environment and the two assigned ports. Its private `.convex/local/default/config.json` must identify the matching deployment. Configure only the fresh backend's synthetic issuer`https://ap-demo.invalid` and audience`ap-i3-local` so auth-config can deploy. Do not print or share the local admin key.

Copy the verified parser cache into `var/ap97-i3-20261025/sources` in that fresh checkout. Do not copy the prior run's bank, decisions, requests, secrets or phase results. Start the gateway with:

```bash
env -i PATH="$PATH" HOME="$HOME" node --import tsx scripts/ap-system/local-recovery-rehearsal.ts serve
```

Keep it running. It creates distinct random local agent/worker credentials, a clearly simulated human binding and an empty isolated FakeBank. It validates the exact local deployment identity. It does not read providers.env or seed financial rows. Freeze the runtime HEAD and harness file for the entire run; every later phase verifies them.

Start Vite in a separate terminal from a source containing the exact dev-only I3 origin fix:

```bash
env -i PATH="$PATH" HOME="$HOME" AP_SYSTEM_GATEWAY_URL=http://127.0.0.1:8827 VITE_CONVEX_URL=http://127.0.0.1:3256 node node_modules/vite/bin/vite.js --config console/vite.config.ts --host 127.0.0.1 --port 5195 --strictPort
```

Run each phase separately with the same clean environment prefix:

```bash
env -i PATH="$PATH" HOME="$HOME" node --import tsx scripts/ap-system/local-recovery-rehearsal.ts exception
env -i PATH="$PATH" HOME="$HOME" node --import tsx scripts/ap-system/local-recovery-rehearsal.ts prepare
env -i PATH="$PATH" HOME="$HOME" node --import tsx scripts/ap-system/local-recovery-rehearsal.ts fault
env -i PATH="$PATH" HOME="$HOME" node --import tsx scripts/ap-system/local-recovery-rehearsal.ts recover
env -i PATH="$PATH" HOME="$HOME" node --import tsx scripts/ap-system/local-recovery-rehearsal.ts verify
```

Pause after exception, prepare and fault for browser inspection. Use the case ID returned by your run. Only the harness's own child is killed. `recover` waits the actual lease, bounded below59seconds, looks up the original transfer, explicitly simulates FakeBank settlement and drops its notifications. Preserve failed-attempt files and bank/backend state if a phase fails; do not reset money state or repeat a submitted payment to obtain a green result. Private phase files contain fuller diagnostic records; publish only reviewed non-sensitive evidence.

## Explain the accounting terms against evidence

| Term | Record and explanation |
| --- | --- |
| System of record | Original source for the supplier claim, received evidence for delivery, approved beneficiary for destination, bank evidence for execution, posted ledger for accounting. None is interchangeable. |
| Chart of accounts | In this declared expense fixture,5000 is expense,2000 AP and1000 cash. Different cost treatments require their own policy. |
| Journal entry | Open the separately linked recognition and settlement records above. |
| Double-entry bookkeeping | Recognition debits5000 and credits2000 by678.60; settlement debits2000 and credits1000 by678.60. Balance alone does not prove correct coding. |
| Subledger | The case's accepted obligation678.60 is reduced by verified settlement678.60, leaving0. |
| General ledger | The linked AP control-account entries net to0 for this case. Use the separate I2 statement evidence for a complete workspace AP-to-GL comparison. |
| Internal controls | Held receipt evidence, fresh revision review, exact payment hash, lease/lookup recovery and idempotent posting constrain the workflow. |
| Segregation of duties | Agent credentials prepare; a separate simulated human identity approves. This tests the boundary, not a real person's approval. |
| Controller | The role governs exceptions/coding/close under policy; this engineering fixture does not constitute independent professional review. |
| Materiality | Inspect explicit matching policy tolerances. Do not equate a software threshold with professional audit materiality or use it to waive payment authority. |
| Reconciliation | The settled bank debit is matched to its command, bill and journal. This does not claim an entire bank statement reconciles. |
| Period close | Open the separate [I2 evidence](evidence/I2-business-flow.md): AP-to-GL difference0 and six explicit close blockers. Label it a different run; this I3 payment cannot sign off period close. |
| Audit trail | History retains earlier and later source revisions, decisions and duplicate deliveries; structured results retain command, transfer, debit and journal IDs. |

Real Auth0/QBO/Increase and practitioner gates remain separate. Do not use this fixture's simulated identity to fulfill them.
