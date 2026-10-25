# AP capability and verification matrix

This is the live implementation matrix for issue #97. A capability is not integrated-verified until the same uploaded source case passes its dependent gates. Canonical task status: plan.json.

| Capability | Current status | Evidence / remaining gate |
| --- | --- | --- |
| Isolated worktree/backend and source/spec baseline | verified-local | P0-evidence.json, adoption.json; main d24f220 |
| Shared source/evidence/review/payment contracts | verified-local | C0-acceptance.json; independent readiness review; six boundary tests |
| Golden State original PDF/PO/receipt/contract | implemented, verified-local packet | A1-packet.md; five hashes, reproducible rendering; V1 independent agent review passed |
| Direct LlamaParse original ingestion | implemented, live component-verified | A2-ingestion.md; four genuine parser jobs on synthetic originals; I1 HTTP upload reused hash-verified cache |
| Native/raw-word/local-OCR/unresolved grounding | implemented, component-verified | Preserve per-method provenance, unresolved denominator; no universal OCR reliability claim |
| PO matching and owned exceptions | clean case integrated-verified; negative gate underway | B1/V1/I1; V2 independently exercises missing/conflicting evidence |
| Field review → bill → payable recognition | integrated-verified locally | I1; exact source/review binding, separate decisions and one recognition journal |
| Separate payment authorization and durable engine handoff | integrated-verified locally | V-C1.md and I1; proposal waits for independent local simulated-human approval |
| Source session/hash validation and original serving | integrated-verified locally | I1 original HTTP downloads match four hashes; native original highlight visually inspected |
| Unified case workspace | integrated-verified locally, usability corrections underway | I1 same settled case in browser; D fixes field-panel length and direct-link session race |
| Same-case PDF → FakeBank → settlement reconciliation | integrated-verified locally | I1-integrated.md/json; one transfer, bank debit and settlement entry; zero AP outstanding |
| Negative cases and crash/recovery | independent connected verification in progress | V2 at190201f; no inherited external or practitioner claim |
| Increase sandbox | auth/resource-read verified only | C2 after V2; genuine human OIDC configuration also absent; no outbound payment yet |
| Broader suppliers/non-PO/partial receipt/credits/allocations | planned | B3 after V2 |
| Business due-date scheduling | planned | C3 after V2; independent of ERP access |
| Period close and unpaid AP carryforward | planned | B4; accounting correctness and locked-period gates |
| QuickBooks Online US sandbox | selected, access pending | Credential-free implementation authorized; QUICKBOOKS-SETUP.md; external sync NOT_RUN |
| Polished audit/recovery presentation | planned | D2 after V2/B3; source-to-journal same-case evidence required |
| AP practitioner review | external acceptance pending | No reviewer available; PRACTITIONER-REVIEW.md; agent review is distinct |

No production deployment, main merge or real-money operation is part of this goal. The original Desktop checkout and existing previews remain outside this goal's ownership.

Remaining section 4 format coverage is tracked explicitly as A3 (XML profile and representative scanned PDF/JPEG/PNG/multipage TIFF), included in FINAL dependencies. Local OCR source/traineddata are pinned; Docker image build/deployment remains unverified. Original storage was measured at 1.2MB and 8MiB with byte-perfect round trips and zero economic effects; 8MiB+1 was rejected. See evidence/storage-capacity.json.
