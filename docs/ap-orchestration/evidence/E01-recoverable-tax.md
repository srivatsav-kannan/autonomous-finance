# E01 — explicitly governed recoverable purchase tax

This is local engineering evidence under frozen issue #97/spec `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`. It is not a tax eligibility determination, practitioner signoff, live HTTP result, or external provider verification. No active operator policy, provider default, credentials or live backend was changed. The new chart account 1180 (Recoverable Purchase Taxes) is passive; it was unused in src/convex/company/tests before this change.

## Interfaces and authority

Existing `apBusiness.propose`/`vote` and policy proposal/activation APIs are used. There is no new endpoint/table. Additive typed contracts are in `src/ap-system/tax-contracts.ts` and `domain-contracts.ts`:

- `taxCodes[].recovery?`: version `ap-recoverable-tax-v1`, receivable account, jurisdiction label, allowed rates in basis points, `allowStatedAmount`, permitted `priceBases`, recoverable fraction in basis points, inclusive effective date interval, `approvalGroupId`, and explicit rounding rules. A recoverable code without this opt-in remains held.
- `acceptance.lines[].tax?`: rate or stated-amount calculation; jurisdiction, tax-point date, inclusive/exclusive basis, original taxable base/tax/gross, accepted recoverable cents, exact invoice fact citations, separately retained eligibility citations, and an explicit rationale. A stated-amount claim carries `rateBps: null` and no rate citation. The system does not reverse-engineer a rate.
- Citations retain source ID/revision/hash, page, start/end, exact quote and raw value; monetary citations specify major or minor currency units. Every numerical tax fact binds the original line-tax invoice source. Eligibility support must be separately retained `other`, `contract` or `correction` material, not the invoice asserting its own eligibility. Human judgment remains required.

The receivable must be a known noncash asset, configured with treatment `tax`; cash, AP/liability, expense, unknown accounts and absent approval groups are rejected. Existing policy immutability and independent activation remain authoritative. The configured tax review is an additional stage, even if a group also appears in another stage; current distinct human/principal seats are still required. There is no automatic synthetic policy installation.

A claim is bound to the complete business proposal/source snapshot and current policy. Final votes re-evaluate the same rule, evidence and remaining capacity before atomic posting. Existing replay, stale policy, seat-alias and retired-reviewer defenses remain intact. Recognition and payment remain separate.

## Arithmetic and preserved accounting

Supported calculated tax uses exact integer half-up rounding per line, explicitly selected by policy. Partial acceptance retains the original proportional tax rule; recovery uses the explicitly configured fraction. Fractional-cent evidence is rejected. Stated tax amounts can be accepted without a printed rate only when explicitly permitted and all other source/equation/approval requirements hold.

Tax and cost are separate allocation pools. Cost receives net plus nonrecoverable tax; treatment `tax` receives exactly the accepted recoverable amount at the policy's receivable account. Their sum remains full accepted AP. Current store/department/project controls apply to both pools. Under E02 `cost_and_settlement`, AP keeps the same approved homogeneous department.

Expected and measured synthetic full-recovery example, 7,700 net + 770 tax:

| Posting | Debit | Credit |
|---|---|---|
| Recognition | 5000 cost: 7,700; 1180 tax receivable: 770 | 2000 AP: 8,470 |
| Supplier tax-only credit | 2000 AP: 770 | 1180: 770 |
| Subsequent return after full tax reversal | 2000 AP: 3,850 | 5000: 3,850 |

With 50% recovery the original cost is 8,085 and receivable 385. Two half returns reverse tax receivable 193 then 192; total exactly 385. Cumulative net, tax and each original allocation share cannot be over-consumed. Two competing final tax-credit approvals of 500 against original tax 770 permit one. None of these actions creates a bank command or rebooks the original journal.

Cost reclassification cannot move value into/out of an original or current tax receivable. A later supplier credit following a cost reclassification uses an explicit current cost correction plan only for cost shares; its tax shares remain the original immutable ones. A tax-only credit does not need an unrelated cost plan. Original journal contents remain unchanged. The E01/E02 joint regression additionally verifies successive credits against a department-bearing AP original; cost-state verification now preserves the original AP dimensions instead of constructing a dimensionless expected leg.

## Validation

- Tax policy/evidence tests: **19 pass**.
- Governed tax API tests: **17 pass** (exclusive/inclusive; stated amount; partial recovery; missing/conflicting evidence/account/policy; source revision; future tax point; independent stage; retired/aliased reviewer; stale policy; tax-only and cumulative credits; concurrent final votes; cost correction; department-preserving successive credits).
- Combined AP/payment selection: **843 pass / 1 fail across 111 files** on the A41a1116 integration before its architecture follow-up. The sole failure is `tests/payments/architecture.test.ts`: the new E02 imports of `src/payments/accounting-binding` fall outside that test's allowed dependency paths. A/Master were notified; E01 does not weaken that boundary. All AP/tax tests passed.
- Rebased E01-only delivery atop A41a1116: tax + local/settlement dimension selection **50/50 pass**; all 14 E01-owned file contents match the previously tested integrated tree before this documentation/whitespace cleanup.
- `npm run typecheck`, `npm run typecheck:backend`, `npm run typecheck:tests`, and `git diff --check`: **pass**.

Commands:

```text
npx vitest run tests/ap-system/tax-policy.test.ts tests/ap-system/tax-business.test.ts
npx vitest run tests/ap-system tests/payments tests/demo-*.test.ts tests/payment-kernel.test.ts
npm run typecheck
npm run typecheck:backend
npm run typecheck:tests
```

The first independent helper checkpoint is `89296f0`; the first backend checkpoint is `065e979`. Final delivery is rebased onto A's `41a1116575f98460209e4164776363a0fa4e6e50` so its frozen settlement authority is preserved. Master records the final contribution SHA in the canonical registry.

## Explicit remaining bounds and next actions

- Operator/practitioner must supply actual jurisdiction, eligibility fraction, allowed rates or stated-amount policy, effective dates, receivable account and review responsibility. Synthetic test rules are not approval to enable those settings.
- USD only. FX remains a separate engineering increment.
- One declared tax treatment/rate per line. Compound/multiple rates on one line, withholding, reverse-charge/self-assessed tax, returns/filings and tax refunds are not implemented by this increment.
- Freight/discount affecting taxable base is held pending explicit supported line distribution. A pre-invoice accrual cannot invent recoverability.
- A supplier credit can reverse original recoverable tax. A non-supplier correction of post-recognition eligibility or filing-period entitlement needs a separate governed tax-adjustment design; it is an engineering follow-up, not merely external signoff.
- Exact citation parsing currently accepts major/minor USD values, printed percentages, ISO tax-point dates and explicit `tax inclusive`/`tax exclusive` basis text. Other source representations need a reviewed normalization extension; they remain held rather than guessed.
- Backend contracts are ready for D's UI forms/read display. This increment does not claim a completed human tax workflow in the browser or QBO statutory-tax integration. Existing authoritative GL export retains the exact tax receivable allocation, but external tax returns and provider-specific tax-code/TaxLine semantics are separate.
- Next: integrate, replay adversarial tests independently, add UI/operator configuration review, then conduct actual policy/practitioner acceptance before enabling a tax rule.
