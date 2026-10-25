# Hyphenate AP demonstration

This demonstration connects persistent AP work, readable transition evidence and a narrow correction-to-precedent experiment. It uses the existing AP workspace and authority checks. The learning experiment is synthetic and produces coding recommendations; it does not post journals or authorize payments.

## Open the demo

Open <http://127.0.0.1:5196/ap-system?apWorkspace=learning> and select **Simulated governor** from **Simulated human**. The displayed actor name may include the configured seat label. This is an isolated local identity, not an Auth0 login or a real-person sign-off.

The isolated demo uses FakeBank on backend `3254` / site `3255`, gateway `8827` and browser `5196`. Admission requires `simulated_human`, a `fake` / `local` scope, a matching run ID beginning `ap97-b3-hyphenate-`, and the exact loopback browser origin. The existing Auth0/Increase workspace on `5192` remains separate.

For an already provisioned local backend, launch with a private mode-0600 config:

```sh
npx tsx scripts/ap-system/hyphenate-demo-server.ts --config /absolute/private/hyphenate.json --work-packet fixtures/ap-system/hyphenate-v1/work-packet.json
AP_SYSTEM_GATEWAY_URL=http://127.0.0.1:8827 npm run console -- --port 5196 --strictPort
```

The private config supplies `localRoot`, `kernelAdminSecret` and a fresh `runId`. Reuse the configured local runtime instructions rather than copying these credentials into Git. The helper refuses external provider scopes, retains a first-run work summary and creates source/identity/governance fixtures through ordinary scoped APIs. It starts no bank dispatch or bank evidence worker. Optional `--walkthrough` records a clearly simulated governor review and B/C results; omit it when presenting the review interactively.

## Present the work lifecycle

1. Open **Cases**, select the synthetic work case identified by `workCaseId` in the helper's private summary, and inspect **Shared case work**. Owner, next stage, requirements and wait times are saved state.
2. The supplied work packet is first ingested without its receipt. The AP worker records a missing-evidence wait. The helper then supplies the receipt as a revision of the same case, and the worker reaches field review. It does not approve that bill or payment.
3. In **Human control of agent progression**, enter a reason and acknowledge the scope before pausing. Refresh to inspect the paused state, then explicitly resume. Stale generation/revision/snapshot controls are denied with retained audit evidence.
4. Open **History** or **Traceability** and expand **Recorded state changes** to see field-level before/after values, actor, authority, operation ID and source bindings. Old events without a diff are labelled **Legacy summary**. Source-version comparisons are comparisons of retained evidence, not proof of a historical extracted candidate that was never saved.
5. A pause stops AP agent progression. It does not cancel an already authorized bank transfer. Bank cancellation, bill approval and exact payment authorization keep their separate controls.

## Present the learning experiment

1. Open **Learning & demo**. The helper seeds history A; **Load synthetic learning packet** also supports an explicit seed through the API. Inspect the retained original text, hash, supplier/category/location, original coding and correction reason.
2. A records routine cleaning changed from inventory `1200` to expense `5000`, preserving the SF Hayes Valley allocation. The candidate is restricted to that supplier, category, location and effective dates. It cites support, contradictions and missing context.
3. Before review, evaluate **B** and **C** to record the baseline. A proposed rule is inactive.
4. As the separate simulated governor, inspect the candidate and choose **Accept proposed scope**, **Narrow scope and accept**, or **Reject rule**. Enter a reason and explicitly confirm the exact version. The backend checks current governance, independence, scope and supported accounting codes. A missing policy keeps the rule inactive.
5. Evaluate B and C again after an accepted review. B is routine cleaning in the approved scope; the expected result is a coding recommendation. C is capital renovation for the same supplier; the expected result is a hold rather than reuse of the cleaning rule. Compare saved results and rule references, not a pre-rendered success assertion.
6. The recommendation still requires human bill review and independent payment authorization. Neither a correction nor a learned rule grants payment permission.

Expected B/C outcomes describe the experiment's acceptance criteria. Only persisted results and the run evidence establish whether a particular run passed.

## Optional model-backed AP decisions

The AP worker remains deterministic unless its private config includes the validated `decision` configuration. The model adapter supports the configured OpenAI or Anthropic provider, a named model, explicit price inputs, persistent request/cost limits, token limits and timeouts. Provider credentials and the budget file stay server-only. No model access is needed for the synthetic learning lab.

```sh
npm run agents:ap -- --config /absolute/private/ap-agent.json --once
```

For model mode, the worker inspects the current shared case and accepts only `advance`, `wait` or `handoff` decisions with a concise reason and known evidence IDs. The authoritative backend rechecks role, lease, source revision, snapshot and human approvals. It cannot use the decision to authorize or dispatch a bank transfer. Saved model decisions expose the provider/model, run ID, inspected revision, input hash, evidence IDs, token/cost usage and latency in the transition view.

`--inspect-decision --case <case-id>` is a read-only model preview. It makes an actual provider request when configured, but performs no work mutation. Do not describe a preview as an executed autonomous transition. Mock transport tests prove adapter behavior; they do not prove a real provider call. Absence of a saved model decision is labelled explicitly in the UI.

## Evidence and boundaries

[Verified run results](evidence/hyphenate-20261025/RESULTS.md) contain the actual identifiers and boundaries.

| Proof | Verified result |
| --- | --- |
| Same case missing receipt → resumed field review | [V3 arrival record](evidence/hyphenate-20261025/work-arrival.json) |
| Human pause/resume and diffs | [Nine continuous saved transitions](evidence/hyphenate-20261025/work.json) |
| Rule A; B/C before and after | [Four saved evaluations](evidence/hyphenate-20261025/learning.json) |
| Actual model decision | gpt-6.1-sol wait, applied to revision2; [screenshot](evidence/hyphenate-20261025/model-decision.png) |
| Desktop visual check | Light mode passed; dark-mode check incomplete due browser-control instability |
| Local checks | [136 tests plus types/build/design](evidence/hyphenate-20261025/validation.md); CI skipped |

The existing $77 Increase/QBO transaction has separate external proof and is not repeated by this demo. FakeBank evidence is not Increase evidence. This demonstration does not establish a general autonomous accounting policy engine, full transition coverage across every financial subsystem, complete APEX support, real historical learning effectiveness, production hosting readiness, or Claude/practitioner sign-off. Reviewers must distinguish synthetic seats, deterministic precedent matching, mocked provider tests and actual provider records. CI is intentionally skipped at the user's request; local tests/build checks are separate.
