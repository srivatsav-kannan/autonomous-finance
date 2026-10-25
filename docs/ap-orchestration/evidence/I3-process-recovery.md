# I3 — same original case, later receipt and actual worker recovery

**PASS, 25 October 2026.** The same uploaded AP case moved from missing-receipt hold to a later supported revision, separate simulated approvals, actual worker process interruption, original-transfer recovery and one settlement. [Structured results](I3/results.json), [desktop screenshots and hashes](I3/browser-manifest.json), [reproduction and walkthrough](../I3-RUNBOOK.md).

The runtime and new harness were frozen at `e1147850f98882630653b98b988e30e86a399143` on baseline `433511e`. Master independently executed the harness authored by agent A. The UI was served from `996e930` after repairing the exact local rehearsal origin. The harness is integrated as `39bcf93`; the source/runtime/UI commits are deliberately reported separately.

## Observed sequence

| Phase | Observation |
| --- | --- |
| Exception, 11:08:13–14 UTC | Multipart invoice, PO and contract created case `kd74wbhvrp0y8tr74pt603pj6x8gzv2y`, revision1. Four lines had receiving-owner holds. The later receipt's hash, source and purchasing evidence were absent. Field review did not override the holds: bill approval and payment preparation both returned409. |
| Later receipt, 11:09:22–23 UTC | An explicit full-packet revision retained the same case and advanced to revision2. Earlier review/history remained. Fresh bill approval before field review and payment preparation before bill approval returned409. Exact new field review, bill approval, payment proposal and separate payment authorization then succeeded. A stale payment hash returned409. No bank transfer existed yet. |
| Actual process fault, 11:09:40–41 UTC | The parent verified durable FakeBank acceptance and the frozen command hash before sending SIGKILL to its own dispatcher child. Local execution was in-flight, cash unposted, bill paid amount0, no bank debit imported and no provider ID recorded on the command. |
| Recovery, 11:09:49–11:10:12 UTC | The actual lease expired; no clock or database state was patched. A fresh child looked up the original transfer, with0 create calls. Pending acceptance still did not mark the bill paid. Explicit FakeBank settlement produced2 notifications, both dropped. Polling posted1 settlement; two repeated polling passes posted0 each. Total recovery phase including the real lease wait was22,748ms. |
| Replay, 11:10:15–16 UTC | Renamed identical originals resolved to the same case and added delivery history. Different bytes under the existing intake key returned409. Revision, amounts and financial records remained unchanged. |

## Exact final effect

One case, two case revisions, five retained source revisions and four current source bindings; one bill, one payment version, one command, one transfer, one posted bank debit, one recognition journal and one settlement journal. FakeBank observed1 create call and1 lookup. All22 frozen expected invoice fields passed per comparison; current original downloads matched all four input hashes. There were0 new parser/provider calls.

The supplier claim and accepted amount are both USD678.60. Recognition totals Dr5000 / Cr2000 USD678.60; settlement is Dr2000 / Cr1000 USD678.60. Settled amount isUSD678.60 and outstanding AP is0. The exact source hashes, command hash and all linked IDs are in results.json. This proves the tested case's payment/bank/journal matching; it is not a full bank-statement reconciliation or a period-close sign-off.

## Desktop review and first-run repair

Master inspected the actual connected case in a1280×720 laptop viewport: missing-receipt owner/action, approved-but-unexecuted state, in-flight/unpaid state, settled/matched state, both journals, revision1/revision2 decisions and delivery history. Native total-amount highlighting and explicitly unresolved supplier location were visible on the original PDF. No phone work was performed. The original inherited palette/layout was not changed by the origin fix.

The first UI attempt failed because local-simulation login allowed onlyport5193. Commit996e930 additionally admits5195 only in a development build with the exact I3 run, organization, account and fake/local scope. Real Auth0 behavior is unchanged.22 auth/origin tests, all3 typechecks, build and design checks passed. Independent verifier14 found no actionable defect; it correctly required this actual browser verification in addition to helper tests. The existing build-size advisory remains. The separately adopted upstream Linux temporary-directory fix passed its2 targeted tests.

## Boundaries

These are project-authored synthetic originals, genuine cached LlamaParse results, a clearly simulated local human and local FakeBank. No real operator approval, QBO transaction, Increase transfer or practitioner sign-off is claimed. Four cached jobs and13 referenced artifacts were hash-verified. Raw provider results contain signed download URLs and remain private; only their [hash manifest](I3/parser-cache-hashes.json) is published. The fixture expectation file is read only by the post-result evaluator, never the runtime parser. No financial records were seeded or repaired directly to make the sequence pass.
