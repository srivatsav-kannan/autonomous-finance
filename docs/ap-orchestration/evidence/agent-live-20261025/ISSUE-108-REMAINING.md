# Issue 108 — remaining engineering acceptance gaps

This handoff records the five remaining gaps identified for the current delivery scope. The repaired runtime, deterministic agent transitions and prior INV-1001 success do not close them. CI remains skipped at the user's request. No Claude independent model review has been performed.

1. **Real model loop.** The current case agent uses deterministic policy/state progression. Add and exercise the intended model decision/tool loop, preserving narrow allowed tools, scoped credentials, durable state and independent payment authorization. Evidence must show actual model calls and permitted tool outcomes; do not relabel deterministic transitions as model reasoning.

2. **New case external flow.** Finish `INV-AGENT-20261025-01` ($77.00 USD): bill approval → agent payment proposal → separate payment authorization → Increase sandbox execution and settlement → bank reconciliation. Issue 108 requires new-case QBO Bill and BillPayment readbacks plus linked QBO and Increase IDs before it can close. Presently the case waits for bill approval with zero payments and journals. Old INV-1001 results are separate evidence.

3. **APEX / issue 107 adapter.** Adapt the real AP case path to consume issue 107’s shared APEX packet and validate its input/output and evidence contracts. This item uses the shared packet/importer contract. The current deterministic worker and sandbox recovery do not establish this adapter is implemented or accepted. Preserve source references and backend authority rather than introducing an alternate approval or payment path.

4. **Durable restart, duplicate and denial evidence.** The saved 14:21:51 UTC checkpoint already confirms this bill-approval wait survives a worker restart with zero payments/journals. Complete the remaining runtime crash/recovery and duplicate intake/tool replay cases, verifying no duplicate payment or journal. Record denied actions and unchanged business state, particularly approval/payment actions unavailable to the agent. The observed idle tick and preserved wait after one worker restart do not prove duplicate/retry or denied-action scenarios. Retain durable artifacts outside temporary directories.

5. **Before/after model-and-tool traces plus handoff.** Preserve a concise trace connecting original documents, missing evidence, the model's decisions, tool requests/results, durable state changes and final accounting/provider outcomes. Include before/after comparisons, findings, fixes, rechecks and remaining limits. Label any future Claude work as “Claude independent model review”; this run has no such review or practitioner sign-off.

The forensic database repair is an additional explicit limitation: surviving documents are unchanged and checked indexes/readbacks work, but absence of completely lost records after SQLite `.recover` is not provable. The original malformed database remains preserved; the recovery copy serves the sandbox.
