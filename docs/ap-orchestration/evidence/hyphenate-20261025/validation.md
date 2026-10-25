# Hyphenate demo: local automated validation

Validated on 2026-10-25 in `codex/ap-system-live-auth0`. CI was intentionally skipped. These checks did not call bank, accounting or external model providers, and did not modify the running demo. Live browser/provider evidence is recorded separately; model-adapter tests use controlled responses and do not prove a real model run.

## Results

| Check | Result |
| --- | --- |
| Consolidated targeted suite | 17 files, 136 tests passed |
| Affected tests after fixture corrections | 2 files, 12 tests passed |
| Application, backend and test TypeScript checks | All passed |
| Console production build | Passed; 261 modules transformed |
| Static design check | 0 FAIL, 0 WARN, 1 ANSWERED across 48 files |

The governed-work regression verifies missing receipt → fresh field review → business-plan/approval gate, including rejection of a business proposal before field review. Receipt checks cover wrong hash, supplier, line, SKU, unit and absent receiving acknowledgment. Precedent tests verify independent approval, bounded reuse, out-of-scope holds, contradictions, stale authority and immutable evidence. Their financial side-effect assertion counts the actual `apCaseRecords`, `demoBills`, `journalEntries`, `demoVersions` and `demoCommands` tables. The test fixture originally named the nonexistent `demoPayments` table; this was corrected before the final affected-suite and test-typecheck pass. The UI transition fixture was also updated to include its required policy version.

The build emits a non-fatal warning for a minified application chunk above 500 kB. The static design check marks its shared status-container finding as ANSWERED. The UI tests are component/transport checks; they are not a substitute for recorded browser walkthroughs.

## Exact commands

Run from the repository root:

```sh
node node_modules/vitest/vitest.mjs run tests/ap-governed-work-stages.test.ts tests/ap-case-model.test.ts tests/ap-case-work.test.ts tests/ap-precedents.test.ts tests/ap-system-hyphenate-ui.test.tsx tests/ap-system-hyphenate-transport.test.ts tests/ap-system-auth.test.ts tests/ap-system-auth-http.test.ts tests/ap-system-auth-ui.test.tsx tests/ap-system-local-simulation-auth.test.ts tests/ap-system-ui.test.tsx tests/ap-case-payments.test.ts tests/ap-system/business.test.ts tests/ap-system/business-authority-regressions.test.ts tests/ap-system/business-payment-boundaries.test.ts tests/ap-system/business-payment-integration.test.ts tests/ap-system/business-timing-authority.test.ts
```

After the test-only corrections:

```sh
node node_modules/vitest/vitest.mjs run tests/ap-precedents.test.ts tests/ap-system-hyphenate-ui.test.tsx
```

Type checking (the test check was rerun after correcting the fixtures):

```sh
node node_modules/typescript/lib/tsc.js --noEmit --pretty false
node node_modules/typescript/lib/tsc.js --noEmit -p convex/tsconfig.json --pretty false
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.tests.json --pretty false
```

Build output is isolated in a temporary folder:

```sh
node node_modules/vite/bin/vite.js build --config console/vite.config.ts --outDir /private/tmp/hyphenate-console-validation-20261025 --emptyOutDir
node .agents/skills/hallmark/scripts/sloplint.mjs console --genre modern-minimal --scope app
```
