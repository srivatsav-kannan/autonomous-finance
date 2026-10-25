# AP capability and verification matrix

This is the live implementation matrix for issue #97. A capability is not integrated-verified until the same uploaded source case passes its dependent gates. Canonical task status: plan.json.

| Capability | Current status | Evidence / remaining gate |
| --- | --- | --- |
| Isolated worktree/backend and source/spec baseline | verified-local | P0-evidence.json, adoption.json; main d24f220 |
| Shared source/evidence/review/payment contracts | verified-local | C0-acceptance.json; independent readiness review; six boundary tests |
| Golden State original PDF/PO/receipt/contract | implemented, verified-local packet | A1-packet.md; five hashes, reproducible rendering; V1 independent agent review passed |
| Direct LlamaParse original ingestion | implemented, live component-verified | A2-ingestion.md; four genuine parser jobs on synthetic originals; I1 HTTP upload reused hash-verified cache |
| Native/raw-word/local-OCR/unresolved grounding | implemented, component-verified | Preserve per-method provenance, unresolved denominator; no universal OCR reliability claim |
| PO matching and owned exceptions | clean case integrated-verified; negative cases independently verified | B1/V1/I1/V2; missing/conflicting evidence and quantity variants remain held |
| Field review → bill → payable recognition | integrated-verified locally | I1; exact source/review binding, separate decisions and one recognition journal |
| Separate payment authorization and durable engine handoff | integrated-verified locally | V-C1.md and I1; proposal waits for independent local simulated-human approval |
| Source session/hash validation and original serving | integrated-verified locally | I1 original HTTP downloads match four hashes; native original highlight visually inspected |
| Unified case workspace | integrated-verified locally, D1 corrections verified | I1 same settled case; D1-live-layout responsive evidence; cold gateway restart/deep-link screenshot |
| Same-case PDF → FakeBank → settlement reconciliation | integrated-verified locally | I1-integrated.md/json; one transfer, bank debit and settlement entry; zero AP outstanding |
| Negative cases and crash/recovery | independently verified component-to-bank path | V2: 34/34 tests; 15 integrated negative/recovery tests re-run after A3/C3; no external/practitioner claim |
| Increase sandbox | auth/resource-read verified only; Auth0 implementation underway | User selected Auth0 development tenant; registration and real browser login pending; no outbound payment yet |
| Broader suppliers/non-PO/partial receipt/credits/allocations | implementation underway | B3 domain policies, supplier verification, approvals, allocations and credits |
| Business initiation scheduling and explicit partial payments | component-verified; integrated UI/API acceptance underway | C3-scheduling.md; frozen UTC date, separate retry clock, explicit allocations and renewals |
| Period close and unpaid AP carryforward | planned | B4; accounting correctness and locked-period gates |
| QuickBooks Online US sandbox | credential-independent connector implementation underway | QUICKBOOKS-SETUP.md; external grant and live record round trip NOT_RUN |
| Polished audit/recovery presentation | planned | D2 after V2/B3; source-to-journal same-case evidence required |
| AP practitioner review | external acceptance pending | No reviewer available; PRACTITIONER-REVIEW.md; agent review is distinct |

No production deployment, main merge or real-money operation is part of this goal. The original Desktop checkout and existing previews remain outside this goal's ownership.

Section 4 A3 format coverage is accepted for the declared strict UBL profile and measured representative scanned PDF/JPEG/PNG/multipage TIFF. Eight format controls passed; 164/175 visual grounding fields are exact, 11 explicitly unresolved; all eight offline replays were byte-identical. Unsupported profiles remain held. A parsed positive-tax XML also stayed held at backend approval without trusted supplier/PO/receipt authority. Local OCR source/traineddata are pinned; Docker image build/deployment remains unverified. Original storage was measured at 1.2MB and 8MiB with byte-perfect round trips and zero economic effects; 8MiB+1 was rejected. See evidence/storage-capacity.json.
