# A1 packet evidence

Task A1; source baseline d24f22007a36722831a521d7387ee8f5c92c5803; contract ap-evidence-v1; policy golden-state-ap-v1; issue snapshot b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565. Worktree ap-system-evidence, run ap97-20261025-01a1722e-a. No backend/service was started.

Generated five actual PDFs under fixtures/ap-system/golden-state-v1/input: clean invoice, authored PO, exported receipt, authored contract, independent quantity-discrepancy invoice. Preserved original simulator invoice text/events and generation options. Frozen evaluator-only expected outcomes precede all provider requests and explicitly remain policy-derived, not practitioner reviewed.

Commands completed:

- AP_PYTHON=<bundled Python> node --import tsx scripts/ap-system/export-golden-state.ts
- Same exporter to var/ap97-20261025-01a1722e-a/reproduced; diff of manifests passed (all five PDF SHA256 values identical).
- pdftoppm -scale-to 1100 -png -singlefile for every PDF, then all five PNGs visually inspected. Headers, totals, table columns and footers are legible without clipping/overlap. Fontconfig emitted a missing-default-config warning; actual rasterized output rendered correctly.

Clean amount is 67860 cents; quantity discrepancy is 71710 cents. Four catalog prices and Net14 terms are reused. The one-case engineering packet is not an unseen-layout benchmark. V1 independent review, LlamaParse/A2, business gates, bank execution and integrated acceptance are not established by A1.
