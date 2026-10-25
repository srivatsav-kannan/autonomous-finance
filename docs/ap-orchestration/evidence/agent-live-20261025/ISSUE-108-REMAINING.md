# Issue 108 — completed external flow and remaining gaps

The minimal synthetic sandbox flow **passed**, but **issue108 cannot close yet**. CI was skipped at the user's request. No Claude independent model review has been performed.

1. **Remaining: real model loop.** Current case progression is deterministic. Implement and exercise the intended model decision/tool loop with narrow allowed tools, scoped credentials, durable state and independent payment authorization. Evidence must include actual model calls and permitted tool outcomes.

2. **Completed: new case external flow.** `INV-AGENT-20261025-01` ($77) passed missing-evidence wait/resume, user bill approval, separate user payment authorization, Increase settlement and reconciliation. QBO Bill **147** has balance zero; verified BillPayment **148** links to it. Increase transfer `sandbox_ach_transfer_8mguyq0upoyjbjoa0516` settled through debit `sandbox_transaction_r8hbiuowvzm2dq0o7s7g`. Test funding is classified; all four imported bank transactions are matched/posted with zero unresolved items. See `flow-summary.json` and final evidence hashes.

3. **Remaining: APEX / issue107 adapter.** Adapt the AP case path to consume issue107's shared APEX packet and validate its input/output and evidence contracts. Use the shared packet/importer contract and preserve backend authority.

4. **Remaining: crash/retry, duplicate and denial evidence.** The saved 14:21:51 UTC checkpoint proves the bill-approval wait survived a worker restart with zero payments/journals at that stage. Complete the remaining runtime crash/recovery and duplicate intake/tool replay cases, checking no duplicate payment or journal. Record denied actions with unchanged business state. Preserve durable artifacts.

5. **Remaining: before/after model/tool traces and handoff.** Connect originals, missing evidence, actual model decisions, tool requests/results, durable state changes and final provider/accounting outcomes. Include findings, fixes, rechecks and limits. Label any future Claude work as “Claude independent model review”; no such review or practitioner sign-off is claimed here.

Forensic recovery remains an explicit limitation: all 1,672 surviving documents were unchanged by the targeted five-index repair and checked readbacks work, but absence of completely lost records after SQLite `.recover` is not provable. The original malformed database remains preserved; the recovery copy serves this sandbox.
