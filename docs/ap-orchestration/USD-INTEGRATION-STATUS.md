# USD backend integration — 2026-10-25

This branch integrates the current main branch with the QuickBooks settlement/recovery work (#106/#110), durable AP case worker (#109), retained transition evidence (#113), and APEX replay (#111). It is a local implementation checkpoint, not a claim that the entire issue #97 roadmap or practitioner acceptance is complete.

## Implemented controls

- Individual payment authorization, batch authorization and first bank dispatch use one release-policy gate. Governed cases require explicit `paymentBands` and group membership. First-wave AP cases require `demoPayments.configure.paymentAuthorizers` with explicit cent limits. Batch limits apply to the aggregate cash amount.
- The current field reviewer, retained bill approvers (including delegated principals), supplier callback verifier and destination approver cannot release the same payment, even if they also belong to a payment group. Field reviewers cannot recognize their own reviewed invoice.
- Immutable payment proposals bind the release policy and human identity mapping. Policy changes require cancel/reprepare before first dispatch. Unknown or possibly accepted sends retain their original bank operation and reconciliation path.
- Free-text legacy `recordCredit` is unavailable once a run contains AP cases or a governed business policy. AP credits use original-allocation approval.
- `apCases.recordHistoricalPayment` stores source-paid evidence bound to the original invoice, amount and source hashes. Reimports and explicit revisions retain the restriction. Legacy and governed recognition reject it, as does the central payment gate. The case projection exposes the classification and a blocking exception. It creates no bill, journal, transfer or invented settlement.
- APEX statement matching now requires one unambiguous transaction row binding the reference, date, payee and amount. Cross-row and reference-prefix matches fail. Layouts with multiple money columns fail closed and require a reviewed layout adapter. Replay hold checks require the expected policy error and both missing-contract and missing-receipt reasons.

## Model runner

`npm run agents:ap -- --config <private JSON> [--once]` keeps its deterministic mode by default. Explicit `mode: "model"` enables model-selected `inspect_case`, `advance_case` and `escalate_case` tools. Their case, generation, scope and credentials are supplied by the host, not the model. Every financial and human-approval gate remains in Convex.

The optional `model` configuration requires provider (`openai` or `anthropic`), an explicit model identifier, effort, input/output limits, token price ceilings, `maxSpendMicros`, and a private `directory`. Prices are USD per million tokens (numerically micro-USD per token); supply current operator-approved ceilings rather than inferred defaults. The corresponding API key must exist in the worker environment. There are no provider retries or fallback models.

Each claim permits at most three model turns and four tool invocations, requires inspection before a terminal tool, and allows only one terminal effect. Ten-second heartbeats renew the owned generation for at most five minutes. A model ending without an allowed action escalates for operator attention. Durable case state survives worker exit; local JSONL traces record prompts, selected tools, results, usage and final summaries, without agent credentials. Worst-case costs are reserved on disk before provider I/O; uncertain charges remain reserved across restarts. A stale lock after a process crash fails closed and requires operator review before deletion.

Local tests inject a model through the same tool registry and real Convex test backend. They are not evidence of live provider inference. No model, Increase, QuickBooks or Auth0 credentials were available on this MacBook; no external run is claimed.

## Migration and local operation

New first-wave runs default to `ap97-usd-controls-v2`; B3 runs default to `ap97-b3-controls-v2`. Explicit local actor selection includes separate field reviewer and payer roles. Existing immutable run configurations and historical evidence remain unchanged. For a new run, configure distinct people and payment limits. Existing policies without payment bands remain readable but cannot authorize new payments. Old decisions without retained human seat bindings need fresh review/recertification; old unsubmitted snapshots need cancellation and preparation again. Do not rewrite or replace a possibly sent command to migrate it.

The governance form exposes payment groups and limits. Original I1 scripts and saved evidence describe the old single-operator rehearsal; they are historical artifacts and are not current acceptance proof. Use the multi-human workflow and current tests for the new controls.

## Validation and remaining acceptance

The integrated AP suite passed 911 tests before the model runner was added. The first full-repository run passed 1,988 tests, skipped four, and identified five older fixtures assuming single-person approval or the former local actor roster. Those five fixtures were migrated and their focused suite passed. Final full-repository results are reported on the PR. Source, backend and test type checks, console build and design lint are required on the submitted revision.

Still outstanding from the independent review: same-invoice supplemental recognition (F3), unused-credit acknowledgement and supplier-debit close treatment (F5), duplicate receipt/PO soft holds (F6), invoice bank-detail discrepancy detection (F7), governed recognition reversal (F8), amount-based close dispositions (F9), and credit chronology gates (F10). F11 needs refreshed end-to-end evidence after those workflows are complete. Live model traces, new external sandbox verification and practitioner sign-off also remain outstanding. This checkpoint must not close those acceptance items.
