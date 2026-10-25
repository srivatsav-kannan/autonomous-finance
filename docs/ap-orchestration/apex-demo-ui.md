# APEX demo UI

Use one frontend at `http://127.0.0.1:5192`. The workspace navigation opens the operations inbox, connected AP workspace, and APEX demo on that same origin. The frontend uses a strict port so another instance cannot silently open on a different port.

Start the backend services and the isolated APEX replay described in [the replay runbook](APEX-107-RUNBOOK.md), then run `AP_SYSTEM_GATEWAY_URL=http://127.0.0.1:8825 npm run console` with the existing inbox Vite environment configured. The connected AP proxy retains its own authentication; `/api/apex` routes to the local replay gateway on 8847. Open `http://127.0.0.1:5192/ap-system?view=ap-system&apRuntime=apex` and select a simulated actor explicitly. Runtime switches use a full navigation and discard the previous in-memory session. No additional frontend on 5173 or 5197 is needed.

The task selector links to exact current invoice originals from PR #111:

- **AVILA-202412-A6:** review the $3,000 invoice, supporting agreement and service acceptance, approvals, accounting, payment and reconciliation. The displayed outcome comes from the running case, not a scripted success label.
- **AVILA-202403-A1:** inspect the $3,500 historical source-paid invoice. The walkthrough offers historical evidence instead of new payment controls. This is presentation logic for this exact dataset and run, not a new backend payment policy.

Source & fields opens the stored PDF automatically. The gateway session, exact source revision and SHA-256 are checked before an object URL is created. The viewer supports continuous vertical scrolling, page navigation, zoom, fit to width and downloading the same bytes. Supporting PDFs are available from the source selector. **Field citation** retains the existing grounded page highlights and provenance. Other source formats retain their citation and original-download access.

The parser label comes from the source record. This replay uses local Poppler text extraction; documents processed by LlamaParse retain their own provider metadata. The PDF viewer does not change ingestion, parser configuration, approvals or payment execution.

Workspace totals, source history and technical case details are collapsible. The case list, five review tabs, payment runs, supplier/policy workspace and period close remain available. Both phone and desktop layouts support light and dark mode.

Validation: typecheck, test typecheck, production console build, full Vitest suite, Hallmark checks, and browser verification of source hashes, supporting-file switching, citation highlights, both APEX tasks, review tabs, mobile overflow and multipage scrolling. Source PDFs and local replay outputs stay outside Git.

## Traceability

Open the **Traceability** case tab, or add `apView=traceability` to a case URL.
The view compares source bindings from recorded review snapshots, opens either
original PDF revision, and shows extracted-text additions/removals. Matching
SHA-256 hashes are labelled as unchanged bytes even when the document revision
increases. The APEX example shows two supporting documents added and unchanged
invoice bytes between the first review and the current revision.

Retained business proposal requests have field-level diffs. Payment snapshots
show their authorization, command, provider transfer, bank observations and
transactions; journal rows show the resulting debit/credit entries. The existing
decision and audit timeline is included. **Copy trace link** opens the same case
and tab; **Export trace JSON** downloads the available records without embedded
original bytes or local original-file paths.

Coverage is explicit: the current API does not expose all historical extracted
candidates, deleted records, model prompts or model reasoning. Those are not
reconstructed or presented as exact diffs. Source text comparisons describe
recorded parser output, while byte identity is established by the original hash.
