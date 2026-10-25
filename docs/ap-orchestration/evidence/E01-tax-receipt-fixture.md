# Desktop historical tax receipt fixture

Base: integration `1a5dc70`. This addition changes only synthetic fixture files and tests. It is not a backend, provider, practitioner or financial acceptance result.

Open the experience preview at:

`http://127.0.0.1:5191/@fs/Users/junjiexiong/.codex/worktrees/ap-system-experience/calhacks/docs/ap-orchestration/evidence/D2-browser/tax-receipts.html?authority=historical_receipt_only&state=unknown&reads=true&theme=light`

The page visibly labels every authority, approval, journal and receipt as synthetic. It has controls for:

- Authority: `current` or `historical_receipt_only`.
- Saved receipt: `prepared`, `sending`, `unknown` or `succeeded`.
- Explicit read permission: `false` or `true`.
- Palette: `light` or `dark`.

Changes update the URL, so each desktop screenshot can be reproduced directly. After changing a scenario, select the sole “Tax adjustment / $4.25” journal. It binds the exact synthetic action and journal IDs, with no bank command or transaction link.

## Expected desktop checks

| Scenario | Expected controls |
| --- | --- |
| Current authority | Local plan preview available; any submission still blocked by the fixture. |
| Historical authority | Prominent no-current-write-authority notice; preview and submission unavailable even though saved company configuration is present. Historical mappings are deliberately absent. |
| Prepared receipt | No recovery action, regardless of read permission. |
| Sending or unknown, reads false | No recovery action. |
| Sending or unknown, reads true | “Recover existing external request” is available. |
| Succeeded, reads false | “Verify external record” is disabled. |
| Succeeded, reads true | “Verify external record” is available. |

A preview in current mode displays a synthetic balanced $4.25 tax JournalEntry. Verify/recover clicks are intercepted locally and return a deliberate `fixture_no_provider_read` message; the receipt stays unchanged. Submissions always return `fixture_no_financial_action`. Every fetch is handled by this fixture; there is no forwarding fallback. The banner reports the latest intercepted request and status. No server or preview was restarted by this change.

## Verification

- Ten fixture/period-receipt UI tests passed. The three new tests cover all 16 authority/state/read-permission combinations, valid typed tax actions, exact original selectors, no bank link, correct control visibility and local interception without state mutation.
- Full test TypeScript check passed.
- The standalone browser fixture entry passed its own TypeScript check.
- Browser visual acceptance is pending Master CUA, focused on desktop light/dark only.
