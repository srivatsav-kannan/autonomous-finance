# Source-complete close and accounting evaluation

An invoice that cannot be read is still an unresolved source document. A balanced
journal and an empty held-bill queue do not establish that all obligations were
recorded. Issues #24 and #31 cover the operational close gate and the independent
evaluation of that omission, respectively.

## Close behavior

The controller checklist and each backend `ledger.signClose` mutation check
invoice and lease-invoice sources through the requested month. Missing bills,
held bills, and invalid or absent accruals block a signature. The readiness view
returns a total blocker count and a bounded list of explanations. Explicit
rejections and source-linked duplicate rejections recorded by the kernel can
resolve a source without creating another payable.

Both signatures must refer to the same source/bill state and ledger head. New
sources or changed accounting invalidate prior approvals. Older open-period
signatures without a snapshot must be collected again. Already-closed periods
are not reopened by this change.

The change is additive to the separate AP-demo payment implementation: its
legacy-run guards must remain in place when integrating the payment stack.
This gate does not replace the dedicated payment/evidence close checks.

## Evaluation behavior

The world generator saves a private, versioned accounting oracle with each new
scenario. It records legitimate obligations and account movements before the
agents process the documents. The scorer reconciles all chart accounts,
individual obligations, AP and payment subledgers, and simulator-bank receipts.
Unpaid but correctly accrued bills may pass; unrecorded obligations may not.

`booksStatus.status` is one of:

- `passed`: available independent evidence agrees and invoice coverage is complete.
- `failed`: a concrete accounting or bank/subledger inconsistency was found.
- `incomplete`: the required truth, bank evidence, or source disposition is missing.

Concrete inconsistencies take precedence over incomplete coverage; the report
retains both reasons. Both non-passing statuses make `npm run eval` exit 1 after
saving its reports. Old saved scenarios without the new oracle retain their
original seven metrics but cannot earn a complete accounting pass; regenerate a
fresh scenario for full coverage. Old saved reports display an incomplete status
when rendered without the new field.

These checks can expose existing workflow defects. For example, a disputed
marketplace shortfall remains a receivable. (A shipment short-paid for missing
goods must not receive the same credit deduction again; the AP clerk now records
such a credit memo as consumed by the short-paid invoice.) Expanding the evaluator
does not repair those separate accounting workflows or make every planted-error
scenario pass.

The receipt adapter here is the legacy local `WorldBank` outbox. This is simulator
evidence, not validation of Increase or the separate AP-demo bank implementation.

## Reproduce

Use an isolated local Convex deployment and synthetic run/account data. Configure
`CONVEX_URL` and `KERNEL_ADMIN_SECRET` as described in the repository README.

```sh
npm test
npm run typecheck
npx tsc --noEmit -p convex/tsconfig.json
npx tsx scripts/smoke-close-source.ts
ANTHROPIC_API_KEY= npm run eval -- --run close-eval-check --stores 3 --days 14 --seed 1 --clean --chaos 0.3
```

The final command intentionally needs no model or bank credentials. When the
built-in parsers leave sources unreadable, expect a failing accounting report and
no clean-close request. That expected failure is the regression proof; do not
reinterpret it as a successful financial run. The live close smoke separately
checks that resolving sources permits two current signatures to close a period.

The fixes use the existing serializable Convex mutations. The readiness scan is
scoped to one run and its invoice history; it is suitable for the current
simulation size, not a new large-history reporting index.

## Observed validation

On Node 24.22.0 and an isolated local Convex backend
`precompiled-2026-10-10-72ce13c`, the same seed-1 clean scenario (3 stores, 14 days,
30% duplicate delivery) produced:

| Check | Original main `adbe32c` | Integrated fixes |
| --- | --- | --- |
| Received invoices / recorded bills | 63 / 42 | 63 / 42 |
| Unreadable invoices | 21 | 21 |
| Book result | All seven differences zero; exit 0 | Failed; exit 1; 21 unresolved sources |
| Missing AP and expenses | Omitted from the checks | 2,134,650 cents detected |
| Controller close | Signed; requested human co-sign | Not ready; 21 source blockers |
| Direct human close | Not exercised | Refused with `close_blocked` |

The negative run used zero model calls. A subsequent positive acceptance step
explicitly recorded the 21 missing synthetic obligations from the private fixture
truth, without rerunning or claiming to repair the parsers. Re-scoring then gave
63 recorded bills, zero unresolved sources, and `passed`; two fresh signatures
closed the period. Historical unreadable task counts remained visible.

The integrated revision also passed 218 tests across 20 files, application/backend/
tests-inclusive TypeScript checks, the console production build, and all 14 live
checks in `scripts/smoke-close-source.ts`. Independent comparisons across 60
seed/window/error configurations confirmed that the accounting-oracle addition
does not change the existing generated events or answer key. No paid model,
provider sandbox, production deployment, or real-money operation was used.
