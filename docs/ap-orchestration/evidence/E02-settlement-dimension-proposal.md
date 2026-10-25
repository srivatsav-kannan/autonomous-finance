# E02 proposed immutable settlement-location authority

Status: design for Root review, not implemented or active. The current policy supports cost allocations only. The new close/catalog checkpoint does not modify the payment kernel. This proposal extends only department-as-location; store/project stay cost dimensions and are not automatically assigned to cash or AP.

## Explicit policy and recognition

Add a discriminated, opt-in business dimension scope `cost_and_settlement` alongside existing `cost_allocations`, with a new explicit rule `settlementDepartment: "homogeneous_approved_department"`. Preserve explicit department/project allowlists. Use the existing authenticated controller proposal and independent current-human approval. No default, silent upgrade, or runtime environment flag may enable this scope.

For a new approval under this scope, all recognized cost allocations—including tax, freight and signed discounts—must carry the same explicit department, including null. Reject mixed departments before local recognition. Exact per-line store/project coordinates remain unchanged. Write the homogeneous department on the local recognition AP line as well as each cost line; do not add store/project to AP. Retain the department rule, policy hash and approval identity with immutable recognition authority. Linked credit AP reversals inherit the same original department; corrected cost accounts may not move that department. An invoice or credit recognized under cost-only scope cannot acquire settlement location by later changing policy.

## Frozen payment binding

Introduce a versioned, optional immutable `accountingBinding` on PaymentSnapshot:

```
{
  version: "ap-payment-accounting-v1",
  mode: "department_as_location",
  department: string | null,
  bills: [{ billId, recognitionEntryId, approvalId, approvalHash,
            policyHash, accountingAuthorityHash, appliedCents }],
  credits: [{ creditId, recognitionEntryId, approvalId, approvalHash,
              policyHash, accountingAuthorityHash, appliedCents }]
}
```

The backend derives it from recognized authority and exact posted journals, never caller-provided allocations. IDs must cover the payment snapshot's bills/credits exactly, amounts must match, all departments must agree, and recognition AP lines must prove those departments. Partial amounts are allowed within the existing reservation/capacity rules. Mixed legacy/governed scope or departments hold; no automatic splitting.

`accountingAuthorityHash` binds the original approval scope, supplier, currency, department and recognition journal. Snapshot hashing already includes every field. Add optional `accountingBindingHash` to BankCommand, its runtime/schema validators and the canonical command hash. It is the hash of the exact snapshot binding. Existing command canonicalization already retains all non-requestHash fields. The Increase body builder explicitly selects banking fields, so these local accounting additions must not change the saved provider body or amount. Every command use must also verify its binding against the immutable approval-version snapshot, not merely trust a valid command self-hash.

Request, human approval and first dispatch revalidate current authority, the binding and reservations. An already-attempted command uses its original binding and request bytes for every reconciliation or retry. Current-policy retirement must block a new first dispatch, but must not prevent recording and accounting for an already-posted bank fact.

## Posting, returns and restored payable

On a matched posted debit, `postVerifiedTransaction` writes the frozen department on both AP debit and bank credit. It must compare the command binding to the immutable version first. It must not derive dimensions from today's candidate or policy. A positive posted return reverses the exact original debit journal's account/department coordinates and amounts, checked against that same binding. Return posting does not choose a new department. Original entries, commands, transaction evidence and QBO IDs remain immutable.

The current controller-approved bank-return correction must retain and validate those local journal dimensions. External return JournalEntry then maps both exact line departments to DepartmentRef while preserving Vendor Entity. Replacement payment allocations can reference the restored JournalEntry only when their frozen department equals the restored payable's department and the existing approved capacity rules pass. Credits applied to a restored payable require the same dimension equality and existing distinct-human allocation authority. A zero-cash application retains its exact linked recognition/return authority and amount; it must not invent a new bank journal or cash dimension.

QBO BillPayment gets one DepartmentRef only from the authoritative frozen settlement/application binding. It is checked against every linked Bill, VendorCredit and restored JournalEntry; missing authority or any mismatch holds. ProjectRef is not fabricated on BillPayment: original recognized cost project/customer/billability remains on linked cost transactions. The approved policy must explicitly describe that separation before activation. Transaction location is supported by the official BillPayment schema, but live acceptance remains to be demonstrated.

## Compatibility and migration

All new fields are optional only for legacy records. Absence preserves existing serialized snapshots, request hashes, provider bodies and replay behavior byte-for-byte. A record that declares the new binding version must be complete and consistent; it cannot fall back to legacy. Existing cost-only dimension-bearing recognition is not backfilled or reinterpreted. Its external dimension-bearing settlement remains held until a separately approved migration/reclassification design exists. Already attempted payments never gain or lose dimensions. A merely queued old approval must be cancelled through the existing permitted path and reapproved if new authority is needed; do not mutate its snapshot in place.

New code should read old versions. Old workers must not accept new binding-bearing commands without the new strict schema support. Coordinate deployment/drain and executor compatibility before activating the policy; do not silently bump the immutable run configuration or rewrite running commands.

## Proposed implementation ownership and acceptance

Root review is needed before edits to `src/payments/contracts.ts`, `src/integrations/contracts.ts`, `src/payments/domain/validation.ts`, `convex/demoSchema.ts`, and `convex/lib/payments/{applyCommand,executionConfig,applyObservation}.ts`. The AP helper can own binding derivation/validation; posting consumes only its verified frozen result. Business recognition/credit and accounting export/correction helpers need narrow coordinated changes. B's current `accruals.ts` and `periodView.ts` physical-identity fixes are outside this proposal.

Required regressions: legacy hash/body replay; mixed/null departments and scope rejection before approval; partial cash and mixed cash/credit exact binding; tampered recognition/binding/command rejection; current-policy retirement before first attempt versus retained reconciliation after attempt; posted debit/return dimensions; approved replacement and restored credit-only capacity; original history retained; QBO unexpected/missing/changed DepartmentRef rejection and provider-free status. Protocol tests are necessary but do not replace independent review and real authorized sandbox readback.
