# D1 case workspace contribution

Owner `/root/experience`, parent Master `/root`. Branch `codex/ap-system-experience`, worktree `/Users/junjiexiong/.codex/worktrees/ap-system-experience/calhacks`. Baseline `ac62854`; adopted source `d24f22007a36722831a521d7387ee8f5c92c5803`; specification SHA256 `b795ea7028c3e8eb91446dae5623e5e2183bcabb32447a54deefd9db238de565`; contract `ap-evidence-v1`.

Canonical registry remains `/Users/junjiexiong/.codex/worktrees/ap-system-integration/calhacks/docs/ap-orchestration/plan.json`; this worker did not edit either registry copy.

## Implemented

`/ap-system` and the sidebar entry preserve all existing invoice/simulation views. The case queue, original-source evidence, matching/owned holds, line allocations, accounting/payment detail, separate status dimensions, amounts and historical decisions consume APCaseDetail. Nullable failed extraction is visible and cannot enable approval. Source selection checks the candidate's current source bindings and original source revision/hash. The page raster must return matching source/revision/page headers and the expected transformed aspect ratio before overlays appear. Native/derived/unresolved labels remain separate from supported/conflicting content; derived multiline regions stay separate, and coarse context is never presented as precise field geometry. Original download hashes are checked before saving inert bytes.

Upload sends original files and document kinds to the server; the total original file limit is 8 MiB and 10 documents. Field review, bill approval, payment proposal and payment authorization use separate requests. Review requests retain source bindings, revision and snapshot. Payment release requires an explicit amount/destination confirmation and sends both AP and payment snapshot hashes. The read model must match the selected obligation and bank scope before authorization is displayed. Pending action retries retain the same idempotency key in the mounted action form. No source content grants authority.

## Checks

- `npm run typecheck`: passed.
- `npm run typecheck:tests`: passed.
- `npx vitest run tests/ap-system-ui.test.tsx`: 9 passed.
- `npm run build:console`: passed.
- `npm run design:check`: 0 FAIL, 0 WARN, 1 answered finish observation. Status badges intentionally share the existing console role.
- `npm run design:review -- --url http://127.0.0.1:5191/ap-system`: rendered 5 viewport screenshots; 0 FAIL, 0 WARN. This direct preview exercised the service-unavailable state because backend proxy wiring belongs to Master.
- `node --import tsx tests/ap-system-ui.browser.mjs`: passed. Uses fresh Playwright context, the real React UI and explicitly labeled synthetic component fixture responses. Full source hashes are pinned in the fixture. No Convex, provider or bank operation is run. See `browser-report.json`, which includes source-file hashes and observed request paths.

Browser checks: native source region; two separate derived line regions; unresolved coarse context; wrong raster hash hides every highlight; current-source binding; desktop 1440 and phone 390 in light/dark with no horizontal overflow; field review then bill approval produces no implicit payment request; independent payment confirmation carries both snapshots; zero uncaught browser exceptions. Manual screenshot inspection found mobile field text clipping on the first pass; it was fixed and the recorded screenshots were regenerated.

## Integration boundaries and remaining verification

Master must supply the session/authenticated HTTP server and Vite proxy `/api/ap-system` to port 8823. Endpoint additions for raster, multipart intake, payment proposal and authorization were agreed with Master during D1. The original/page routes and payment detail route are scoped on the server; UI checks supplement those controls.

This is component verification, not I1/V2, live LlamaParse or Increase acceptance. The images visibly say “UI component fixture only”; amounts and journal expectations are not used by runtime extraction or an AP answer key. The synthetic fixture's bank responses only verify interaction wiring. Actual Golden State source highlights, authority rejection, real same-case bill/payment/journal linkage and backend restart recovery remain for integrated independent acceptance. AP practitioner review is not performed.

No production deployment, unrelated preview restart, external communication or credential access occurred. UI preview uses dedicated port 5191 and no database. Shared manifests, schema, contracts and generated interfaces were not edited.
