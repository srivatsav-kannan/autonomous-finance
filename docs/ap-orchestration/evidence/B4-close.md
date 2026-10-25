# B4 core: period close, reconciliation and accruals

Spec: `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. Synthetic configured company policy only. No provider calls, production deploy, communications, real funds or canonical registry edits. This component checkpoint is not independent acceptance or practitioner approval.

## Authoritative behavior

- Supplier statements bind a retained original, supplier and period. Signed opening/movements/closing arithmetic is checked. Each statement line links an exact scoped bill, credit, verified cash settlement or return. Missing offsetting movements remain discrepancies even when the net balance agrees. Duplicate records, malformed arithmetic and out-of-period statement dates require a corrected statement. Other exact discrepancies require human reason/classification/source evidence; reviewer seat/current group/policy binding is rechecked before close.
- AP/GL reconciliation includes every earlier journal, unpaid approved bills, unused credits, direct credit applications, verified cash and returns. Accrued liability account 2010 is reconciled separately. Unpaid approved liabilities carry forward; unresolved sources, received-but-uninvoiced units, rejected bank posting and unexplained AP/GL differences remain owned blockers.
- Opening evidence explicitly reconciles all configured cash accounts, AP 2000 and accrued liabilities 2010. No zero-cash assumption. Previous configured periods must be closed. Tests include a nonzero 1,000,000-cent prior-period cash opening and 7,700-cent unpaid AP carryforward.
- Source-bound accruals recognize Dr approved cost / Cr 2010 after the configured human route. SKU/unit/capacity and full semantic original line identity are retained; parser/source renaming cannot create capacity. Exact partial reversals distribute remaining original allocation cents and never exceed original units/value. An invoice must explicitly reverse the previously accrued accepted portion in the same transaction as its bill/recognition journal.
- `DomainRequest.accountingDate` is optional; default is original invoice date. It may not precede that date. A different date requires finance/variance approval and matching allocation period. The original invoice date/source stays unchanged. Recertification cannot change the original recognition date. The late-invoice test closes October with accrued 7,700, then posts a November reversal and bill for 7,700 atomically; October retains its historical accrued liability.
- Close binds the exact reconciliation, statement reviews, dispositions and policy snapshot. Approved close retains its full immutable evidence snapshot and unpaid carryforward. Legacy `demoEvidence.signClose` cannot bypass the B4 workflow while an active business policy exists; legacy behavior is retained without active B policy.
- Closed-period posting remains blocked by the existing journal writer. A late verified bank debit becomes a treasury-owned exception; an independently approved reopen permits the original transaction to post once without a new bank command. New evidence makes the old close snapshot stale. Reopening an earlier period is blocked while later periods remain closed.
- Cost reclassification appends a new journal, preserves original records, uses only configured noncash cost accounts/store, and cannot exceed the original allocation after prior reclassifications and linked credits. Cash/AP/accrued-liability reclassifications are forbidden.

## API and UI composition

All functions are in `apClose`. Reads and human mutations require the currently authenticated configured human. Agent proposals use scoped controller credentials; `retainEvidence` additionally permits AP clerk. Every approval route uses the V4 retained-seat and delegation checks.

| Function | Request | Result |
| --- | --- | --- |
| `retainEvidence` | agent scope/seat/token + full private `SourceDocument` resolved by server from authenticated exact original route | `SourceBinding`; hash/bytes checked and original chunked once |
| `proposeStatement` | controller + `idempotencyKey`, `statement:SupplierStatement` | `{statementId,statementHash}`; prior statement for supplier/period becomes superseded |
| `reviewStatement` | human + `input:StatementReview` | exact review receipt; `snapshotHash` binds `view.reconciliationHash` |
| `propose` | controller + `input:{idempotencyKey,action:CloseAction}` | `{actionId,actionHash,route,amountCents}` |
| `vote` | human + `input:{actionId,actionHash,idempotencyKey,outcome,reason,delegationId?}` | pending stage or approved immutable result/journal/period state |
| `view` | human + scope + period `YYYY-MM` | `PeriodView` plus `actions`, `statementRecords`, `retainedSources` |

`CloseAction.kind`: `accrual`, `reverse_accrual`, `adjustment`, `disposition`, `close`, `reopen`. Exact typed shapes are in `src/ap-system/close-contracts.ts`. Statement reviews and source dispositions bind `reconciliationHash`; close binds `snapshotHash`. No browser-supplied raw source bytes/ref are needed when the server resolves an existing source binding.

`view.movements`: `{kind:bill|credit|payment|return,id,reference,date,amountCents,supplierId}` for the selected period. `view.retainedSources`: `{sourceId,revision,sha256,name,kind,pageStatus}`, with no original bytes/ref. `view.accruals` is cumulative through the selected period end, including earlier periods: `{accrualId,supplierId,sku,unit,quantity,reversedQuantity,outstandingQuantity,source,sourceLineId,date,amountCents,reversedCents,outstandingCents,entryId,expectedInvoiceCaseId}`. This lets the UI offer existing exact accrual IDs and remaining quantities for late invoice approval. `actions` retains immutable payload/hash/policy/context/route/votes/result; `statementRecords` retains proposed source payload and review evidence.

Tables added in delegated `apSystemSchema.ts`: `apSupplierStatements`, `apCloseActions`, `apAccruals`, `apAccrualApplications`. Root schema already spreads this module. No generated API edits.

## Explicit holds and next work

- Duplicate SKU/unit physical lines without an immutable physical-line map are held. Standalone accrual evidence establishes one explicitly reviewed line set; a later conflicting parser interpretation needs an explicit accrual resolution.
- A credit after original cost reclassification is held (`credit_classification_changed`) until reviewed correction allocations can be propagated to that linked credit. Reclassification of accrued cost is held (`adjustment_accrual_hold`); reverse/correct the accrual instead, preserving exact invoice reversal allocations. These paths must not reverse obsolete cost accounts silently.
- B4 authoritative export hooks for approved accrual/reclassification/reversal journals are the next same-worktree contribution for A/C4. This core commit does not claim QBO replication of those new journal kinds. D owns browser/server composition; Master owns live integration, shared capability register and practitioner packet.

## Evidence

17 new `close.test.ts` cases cover unpaid close/replay; statement discrepancies and malformed arithmetic; nonzero opening cash; prior-period AP carryforward; AP/GL drift/stale snapshot; legacy-close bypass; locks/reopen; exact partial accruals and remaining allocated cents; renamed receipt/accrual identities; original-date-preserving late invoice; failed extraction; retired statement reviewer; omitted offsetting statement movements; late bank settlement/reopen with one command; and linked-credit/reclassification capacity.

Final core suite: **1,120 passed / 4 skipped**, 102 passed test files / 1 skipped. Frontend, backend and tests TypeScript checks pass. All providers are local FakeBank or no provider. Independent review and integration remain outstanding.
