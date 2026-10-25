# Synthetic provider snapshots

These are sanitized saved LlamaParse results from the A1 Golden State originals, requested with agentic_plus / 2026-09-28. They retain actual returned items, markdown/text, metadata, native grounding, raw words and processor identities for offline adapter regression. They exclude signed download URLs, credentials and the private archival scan. `sourceSha256` binds each snapshot to the committed original PDF in `../golden-state-v1/input/`.

Snapshots are parser outputs, not independent expectations and not proof of current provider behavior. Tests separately assert the immutable original fixture amounts. The runtime never reads this folder. Original full results and their raw bytes/hashes remain in ignored private storage; artifact references in these snapshots are not a public artifact server.
