# Live APEX document processing

The demo starts with **zero cases**. Select a simulated AP reviewer and click **Process invoice PDFs** at `http://127.0.0.1:5192/ap-system?view=ap-system&apRuntime=apex`.

That click starts a persisted server job. For each of the 21 available World 9 contract-attorney originals, the system reads and verifies the bytes, runs native PDF text extraction, binds the supplier, preserves citations and originals, creates the AP case, and reads the resulting control findings. The UI polls actual server progress. No timer fabricates work, and no bill approval or payment is seeded by this action.

## Start a fresh demo

Keep the isolated local Convex backend on 3460/3461 and the single frontend on 5192 running, as described in the replay runbook. Stop the current APEX gateway on 8847, then start:

```sh
APEX_WORLD_ROOT=/path/to/apex-world npm run demo:apex
```

The launcher prints a fresh run ID and starts the gateway with only the necessary local environment. Old runs, source originals, and financial records remain preserved. To resume an existing live run, pass its `APEX_RUN_ID`. Do not run two APEX gateways simultaneously. The connected AP gateway and inbox retain their own routes in the same frontend.

The live job is idempotent within its run. Repeated Start requests reuse the job; interrupted or failed processing resumes unfinished entries with the same intake keys. Completed rows link to their actual case IDs. Create a fresh run when another blank demonstration is required.

## What to show

1. The initial page has zero imported cases and an enabled processing button.
2. Click the button and watch actual originals become cases. Inspect any completed original and its extracted fields.
3. All 21 originals cover three suppliers. Eighteen have historical paid source records; they are not new payments in this run. Their backend guard blocks new recognition, authorization and first dispatch, including direct requests outside the UI.
4. The remaining three invoices are open in the source ledger. They require evidence and human review. Fifteen originals have printed hours-times-rate discrepancies; those values are preserved and held for review. Two have clipped description geometry; the text remains preserved without inventing a highlight.
5. Open Traceability to inspect retained source bindings and audit records. The corpus comparison exposes the historical ledger, bank, statement and accounting checks separately from new-run execution.
6. **Upload documents** can also parse separate invoice PDFs in a batch, or one invoice with supporting documents. Per-file failures remain visible and can be retried. Renaming an original does not create another obligation.

## Scope and verification

This is the complete available **World 9 contract-attorney invoice corpus**, not every task/world in the APEX benchmark. It is synthetic benchmark data. PDF parsing uses local Poppler native text; scans and unsupported layouts remain unapproved with explicit extraction failures. It makes no LlamaParse, LLM, QuickBooks, or Increase call. Human review and financial actions use the existing AP controls; processing itself does not approve or send money.

The previous two-case replay remains separately preserved, including its simulated settlement. The live demo does not copy that success into new cases. All source PDFs and private execution reports remain git-ignored.

Verification covers all original SHA-256 downloads, all supplier bindings, historical guards, renamed reimport idempotency, control exceptions, job coalescing/retry/restart isolation, and a browser-triggered empty-run-to-21-cases execution. The recorded verification run has zero payments and zero journals created by processing.
