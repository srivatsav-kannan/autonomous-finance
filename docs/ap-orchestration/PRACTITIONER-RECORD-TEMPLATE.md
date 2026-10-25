# AP practitioner review record — unfilled template

Copy this template for each actual review. No real practitioner has completed it. Expected policy outcomes, engineering PASS results, workflow human approvals and the practitioner's judgment must remain separately labeled. Do not place credentials, tokens or private bank details in this record.

## Review identity and scope

| Field | Actual record |
| --- | --- |
| Reviewer name / professional role / relevant AP or accounting experience | **Unfilled** |
| Entity and jurisdiction to which the judgment applies | **Unfilled** |
| Reviewer independence / implementation involvement / potential conflicts | **Unfilled** |
| Review date, timezone and meeting/reference ID | **Unfilled** |
| Code SHA, spec SHA and contract versions reviewed | **Unfilled** |
| Policy version/hash, supplier revision and chart/mapping versions | **Unfilled** |
| Fixture/source hashes and casebook cases reviewed | **Unfilled** |
| Environment and identity mode (local simulated / real configured human) | **Unfilled** |
| Provider modes (FakeBank / Increase sandbox / QBO mock / QBO sandbox) | **Unfilled** |
| Materials actually inspected; materials unavailable | **Unfilled** |
| Explicit exclusions / unresolved engineering gates | **Unfilled** |

Start from the [casebook](PRACTITIONER-CASEBOOK.md) and [engineering audit](PRACTITIONER-ENGINEERING-AUDIT.md). Verify that a newer code or policy change has not superseded the referenced evidence. Preserve earlier findings and failed baselines; append a new review rather than editing historical conclusions.

## Record each case separately

- Casebook case / actual case ID / run ID: **Unfilled**.
- Source documents personally inspected (source ID, revision, SHA-256): **Unfilled**.
- Original invoice, accepted, disputed, recognized credit, applied credit, instructed cash, settled cash and outstanding amounts, with currency and period: **Unfilled**. Unknown values stay unknown.
- Expected policy result recorded before execution: **Unfilled**.
- Actual execution mode and evidence reference: **Unfilled**. State whether the reviewer ran it, witnessed it, or only inspected a prior report.
- Actual approvers and independent underlying roles/seats, authority validity, decisions and timestamps: **Unfilled**.
- Source → bill → approval → payment → bank → journal links personally followed: **Unfilled**.

| Posting date | Actual local journal ID / or “expected only” | Account and dimensions | Debit cents | Credit cents | Original evidence and reason |
| --- | --- | --- | ---: | ---: | --- |
| Unfilled | Unfilled | Unfilled | | | Unfilled |

For a no-posting control, record the exact rejection/hold and before/after bill, transfer and journal counts. For a retry, record the original request/command and bank identity; do not claim “exactly once” beyond the observed failure and effects. For a credit application, distinguish its allocation receipt from the earlier recognition journal. For close, retain the exact reconciliation/close snapshot, statement resolutions, opening proof and outstanding items.

| External system | Intended entity / operation | Actual external ID and verified readback reference | Observed writes / replay writes | Result |
| --- | --- | --- | --- | --- |
| Increase sandbox | Unfilled | Unfilled | Unfilled | **Not reviewed** |
| QBO sandbox | Unfilled | Unfilled | Unfilled | **Not reviewed** |

An empty external row must not inherit PASS from a local journal or mock response.

## Practitioner judgments

| Question | Judgment and rationale | Required policy or engineering change |
| --- | --- | --- |
| Does evidence establish the obligation, supplier and receipt/service acceptance? | **Unfilled** | **Unfilled** |
| Are accepted/disputed/credited amounts and remaining obligations correct? | **Unfilled** | **Unfilled** |
| Are recognition date, account, dimensions and tax treatment appropriate? | **Unfilled** | **Unfilled** |
| Are original/corrected credit and accrual allocations appropriate, not merely balanced? | **Unfilled** | **Unfilled** |
| Are the requester/approver/payment/supplier-change controls appropriate? | **Unfilled** | **Unfilled** |
| Are supplier statement, AP/GL, bank/cash and external readback reconciliations sufficient? | **Unfilled** | **Unfilled** |
| Are exceptions, materiality, cutoff, carryforward, reopening and communication responsibilities clear? | **Unfilled** | **Unfilled** |
| Are the accepted operating limits and follow-up priorities suitable for the intended entity? | **Unfilled** | **Unfilled** |

## Findings and resolution record

| Finding ID | Case / evidence | Expected versus observed or policy concern | Category (policy / implementation / setup / data / validation) | Consequence | Owner | Required action and acceptance test | Status / retest evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unfilled | Unfilled | Unfilled | Unfilled | Unfilled | Unfilled | Unfilled | Open / unreviewed |

A policy recommendation does not itself implement a missing workflow. A safe hold may be accepted as an explicit temporary operating limit, with owner and next step, but must not be relabeled as supported processing.

## Conclusion — do not complete on the reviewer's behalf

- Actual conclusion: **Unreviewed**. Reviewer may later choose accepted / conditionally accepted / rejected for the exact stated scope.
- Accepted scope and operating conditions: **Unfilled**.
- Explicit exclusions and unresolved findings: **Unfilled**.
- Required changes and next review date: **Unfilled**.
- Reviewer confirmation, actual date and retained confirmation artifact: **Unfilled**.
- Implementation owner's acknowledgment and separately verified resolution: **Unfilled**.

This record is a domain review, not an authorization to execute a particular payment. A payment continues to require its own current authenticated, amount/destination/date-bound authorization.
