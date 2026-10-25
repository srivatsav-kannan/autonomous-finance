# Synthetic provider snapshots

These are sanitized saved LlamaParse results from the A1 Golden State originals, requested with agentic_plus / 2026-09-28. They retain actual returned items, markdown/text, metadata, native grounding, raw words and processor identities for offline adapter regression. They exclude signed download URLs, credentials and the private archival scan. `sourceSha256` binds each snapshot to the committed original PDF in `../golden-state-v1/input/`.

Snapshots are parser outputs, not independent expectations and not proof of current provider behavior. Tests separately assert the immutable original fixture amounts. The runtime never reads this folder. Original full results and their raw bytes/hashes remain in ignored private storage; artifact references in these snapshots are not a public artifact server.

## Larkfield source-reading regression

`larkfield.json` is the saved LlamaParse response from the live UI upload of the
Filedone fictional sample invoice (CC0 1.0, as printed in its footer):
https://filedone.ai/sample-files/sample-invoice-pdf

Original SHA-256: `545655fc231453aaf2a6c60b44b3b137d506db0d1d79bff12eeef86044aedb86`.
The request used `agentic_plus` and parser version `2026-09-28`. The snapshot keeps
items, markdown, native grounding and processor provenance, with URLs removed.
Raw OCR words are omitted so the regression establishes native cell grounding.
Expected strings in the test come from the independently reviewed original.

The regression requires nine source header values and all 30 cells to remain
visible even when AP mapping fails. Rupee amounts remain strings with their
printed currency; the sample cannot become a USD bill, identify a trusted
supplier, or authorize payment. Source headings and printed total due are
explicitly display-only, not a canonical supplier or original obligation total.
