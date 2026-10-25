# Claude 独立模型评审 — record template

Status: NOT_EXECUTED. The recipient will run Claude using their existing account. Do not fill a finding, fix or verification result before it occurs.

## Provenance and frozen derivation

- Review ID / operator / date:
- Claude product and displayed exact model/version (or "not exposed"):
- Claude conversation/export reference:
- Reviewed code and runtime revisions:
- Phase1 input manifest SHA-256 / uploaded file list:
- Prior exposure, repository connectors/tools/memory and contamination assessment:
- Complete unedited phase1 response path + SHA-256 + freeze time:
- Phase2 reveal time (must be after phase1 freeze) / manifest hash:
- Complete unedited comparison response path + SHA-256:
- Original PDFs actually read / records missing:
- Scope conclusion and explicitly unreviewed cases:

## Findings, fixes and re-review (one row per finding)

| ID | Case | Severity / category | Independent expected result and citation | Observed result and exact record | Gap / defect | Required remediation | Owner | Fix commit/evidence hash | Re-review model/date/response hash | Result and remaining limits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Keep original findings and failed evidence append-only. A fix is not verified merely because code changed or a test passed. Record Claude's re-review against the original finding and new exact record, including unsuccessful repairs. Separate model review from actual QBO/Increase receipts and operational user decisions. No AP practitioner sign-off is claimed.
