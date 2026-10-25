# Durable HTTP intake preparation — worker handoff

Owner `/root/accounting`, parent `/root`. Branch `codex/ap-system-intake-retries`, source baseline `be98772`, spec SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`, contract `ap-evidence-v1` with `currentSourceBindings`. Canonical registry remains Master-only at `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/docs/ap-orchestration/plan.json`. No registry, shared contract, server, schema or script was edited. No backend/provider was started or called.

## Composition

`createDurableAPIntake({directory,loadCase,parse})` returns `APWorkspaceService['parseUploads']`. Master can compose it as:

```ts
const parseUploads = createDurableAPIntake({
  directory: runtime.storageRoot, // existing owned run directory
  loadCase: caseId => service.detail(caseId),
  parse: input => adapter.combineUploads({
    ...input,
    storageRoot: runtime.storageRoot,
    context,
  }),
});
```

The injected parser receives typed `PreparedUploadRequest`; each `PreparedUpload` includes optional `sourceId`, `revision`, `replaces`, `provenance` and `deliveryId`. A confirmed that combineUploads accepts and preserves these fields. Runtime context and secrets are supplied only in the external parse closure; they are not part of the fingerprint.

## Durable behavior

- Request fingerprint preserves ordered original byte hashes/lengths, names, MIME types, kinds and explicitRevisionOf. Different input under a prepared/in-progress key rejects with `intake_key_conflict`.
- Receipt path is `directory/intake-requests/SHA256(idempotencyKey).json`; the new directory is 0700, each file 0600. Write temporary file → fsync → atomic rename → directory fsync completes before returning the intake to the server's subsequent ingest call.
- Receipts retain the schema-validated exact APIntake and its checksum. Restarts and retries load this receipt before consulting current case state or invoking the parser. Returned objects are isolated copies.
- Same-process calls share one promise; exclusive filesystem locks coordinate other wrappers/processes. A completed receipt wins even if its owner died before lock cleanup. Locks include only PID and request fingerprint, without credentials.
- Parser rejection/invalid output leaves no completed receipt and releases its lock. A valid APIntake with failed extraction/null candidate remains a prepared result: its failed case is intentionally replayable. Corrupt, unreadable, mismatched-key or non-private receipts fail explicitly and never silently reparse.

## Revision behavior

When no receipt exists, an explicit revision loads the current case once. Current documents are resolved strictly through `currentSourceBindings`, excluding historical source rows. The uploaded packet is a full replacement; omitted supporting documents are never silently carried forward.

The primary preserves sourceId, uses current case revision + 1, and replaces the exact prior primary binding. Identical supporting bytes/kind reuse the source revision, replaces and provenance (including renamed deliveries); changed support can advance a uniquely matching name/kind source. New support is allowed; ambiguous or multiply mapped replacements reject. Reused known originals preserve their provenance; new/changed originals default to private user-upload provenance rather than claiming synthetic or authenticated-supplier status. Request-key hash plus upload ordinal provides stable, new delivery IDs so a same-byte primary revision does not collide with the previous revision's delivery.

The parser must preserve original bytes and prepared identities, and its candidate revision must equal the primary source revision. It cannot add historical documents or alter provenance. The wrapper does not override or manufacture extraction results.

## Verification

- `npm run typecheck`: PASS.
- `npm run typecheck:tests`: PASS.
- `npx vitest run tests/ap-system/intake-requests.test.ts`: 20 PASS.
- Full `npm test` before the final candidate-revision guard: 86 files passed / 1 skipped, 968 tests passed / 4 skipped, 8.80s. The final guard is covered by the final 20-test run and both repeated typechecks.
- `git diff --check`: PASS.

Coverage includes response loss after an applied revision whose case state advanced; restart replay with unavailable parser; byte/name/MIME/kind/order/revision conflicts; concurrent same-key calls; defensive returned-object copies; private file modes; current versus historical source binding; identical/changed/new/omitted support; ambiguity; thrown parsing failures; JSON/checksum corruption; completed receipt with orphan lock; filesystem-lock wait and abandoned-owner behavior; parser source drift; candidate/source revision mismatch. Tests use original text stand-ins and injected parsing, not PDF/provider fidelity or live Convex evidence.

## Explicit limits and next action

If a process dies **before** completing the receipt, a dead-owner lock reports `intake_preparation_abandoned`; an operator must inspect the owned request and remove that abandoned lock before retrying. No age-only lock stealing occurs; a live/unknown owner times out after 180 seconds with an explicit busy error. The wrapper never automatically causes a second parser to overlap the first. Completed receipts replay without this cleanup.

Identical supporting bytes preserve their bindings as required. If A's provider/config changes their immutable extraction metadata on a first explicit revision, the backend can reject it; this wrapper does not rewrite historical metadata. Source correction/reparse policy remains separate.

Master should integrate this component into the server parseUploads seam, then verify HTTP → preparation → backend response-loss retry on the owned local backend. This report does not claim I1/V1/V2 or independent acceptance. Only the three assigned files belong to this contribution.
