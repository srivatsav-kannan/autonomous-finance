# AP capability and verification matrix

This is the live implementation matrix for issue #97. A capability is not integrated-verified until the same uploaded source case passes its dependent gates. Canonical task status: plan.json.

| Capability | Current status | Evidence / remaining gate |
| --- | --- | --- |
| Isolated worktree/backend and source/spec baseline | verified-local | P0-evidence.json, adoption.json; main d24f220 |
| Shared source/evidence/review/payment contracts | verified-local | C0-acceptance.json; independent readiness review; six boundary tests |
| Golden State original PDF/PO/receipt/contract | implemented, verified-local packet | A1-packet.md; five hashes, reproducible rendering; V1 outcome review pending |
| Direct LlamaParse original ingestion | implemented, live component-verified | A2-ingestion.md; four synthetic source jobs, actual I1 pending |
| Native/raw-word/local-OCR/unresolved grounding | implemented, component-verified | Preserve per-method provenance, unresolved denominator; no universal OCR reliability claim |
| PO matching and owned exceptions | implemented, component-verified | B1; original amounts, missing receipt/SKU/unit and authority gates |
| Field review → bill → payable recognition | implemented, component-verified | B2; exact case/source/review snapshot and atomic entries |
| Separate payment authorization and durable engine handoff | implemented, component-verified | C1-component.json, V-C1.md; independent component pass, I1 pending |
| Source session/hash validation and original serving | implemented, component-verified | ap-system-server.test.ts; integrated browser path pending |
| Unified case workspace | implemented, component-verified | D1; actual linked runtime I1 pending |
| Same-case PDF → FakeBank → settlement reconciliation | planned integration | I1; all upstream gates required |
| Negative cases and crash/recovery | existing engine component tests, connected cases pending | V2; source/review and possible-send controls must be exercised together |
| Increase sandbox | auth/resource-read verified only | C2 after V2; no outbound payment yet |
| Broader suppliers/non-PO/partial receipt/credits/allocations | planned | B3 after V2 |
| Business due-date scheduling | planned | C3 after V2; independent of ERP access |
| Period close and unpaid AP carryforward | planned | B4; accounting correctness and locked-period gates |
| QuickBooks Online US sandbox | selected, access pending | Credential-free implementation authorized; QUICKBOOKS-SETUP.md; external sync NOT_RUN |
| Polished audit/recovery presentation | planned | D2 after V2/B3; source-to-journal same-case evidence required |
| AP practitioner review | external acceptance pending | No reviewer available; PRACTITIONER-REVIEW.md; agent review is distinct |

No production deployment, main merge or real-money operation is part of this goal. The original Desktop checkout and existing previews remain outside this goal's ownership.

Remaining section 4 format coverage is tracked explicitly as A3 (XML profile and representative scanned PDF/JPEG/PNG/multipage TIFF), included in FINAL dependencies. Local OCR source/traineddata are pinned; Docker image build/deployment remains unverified. Original storage was measured at 1.2MB and 8MiB with byte-perfect round trips and zero economic effects; 8MiB+1 was rejected. See evidence/storage-capacity.json.
