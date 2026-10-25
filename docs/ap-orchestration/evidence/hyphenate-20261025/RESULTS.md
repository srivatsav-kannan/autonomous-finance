# Hyphenate demo — verified result, 2026-10-25

Branch: `codex/ap-system-live-auth0`. Runtime: `ap97-b3-hyphenate-20261025-v3`, FakeBank/local, browser5196, gateway8827, Convex3254/3255. This is an isolated synthetic demonstration, separate from the earlier real-authentication Increase/QBO sandbox acceptance.

## Verified path

- Same case `kd71y1v3ytahfa7drqewcsj94d8gygt6`, same work `kx78hv254wntmy4c6e4zndhmbd8gy0dj`: revision1 lacks the receipt and waits with owner `receiving_owner`; revision2 supplies it and resumes to `field_review`, owner `human_field_reviewer`. [Arrival proof](work-arrival.json).
- Browser simulated governor paused and resumed the same record. The nine retained work transitions form a continuous before/after chain. [Saved work/diffs](work.json), [checks](checks.json). Source delivery/revision events retain their existing audit summaries and are labelled as such; this is not uniform diff coverage of every AP/payment table.
- One actual OpenAI `gpt-6.1-sol` request returned `wait`, correctly preserving missing source review/business approval. It was applied through the fenced backend mutation, not merely previewed: model run `3a495e65-bc3c-4f7f-b076-713f37794fa7`, revision2, latency2787ms,2939 input/43 output tokens. Configured cost estimate $0.006308; this is not an invoice from the provider. [Visible model proof](model-decision.png). No specific field evidence IDs were cited because the decision concerned outstanding workflow reviews.
- Synthetic historical correction A generated a deterministic scoped rule. Browser baseline: B held, C held. After independent simulated governor review: B recommended GL5000,100%`sf-hayes-valley`; C(capital renovation) remained held. Four persisted evaluations, one approved rule. [Learning records](learning.json), [visible results](learning-results.png).
- No bill, journal, payment proposal or bank command was created for this new work case. Independent bill review and payment authorization remain required.

## Findings, fixes and checks

The first two local setup attempts exposed missing supplier governance and a real stage-ordering defect: `business_plan_required` hid the missing receipt and blocked display of field review. Fixed through normal independent simulated supplier governance plus explicit current receipt validation and stage ordering. V3 then passed. Those failed runtime databases/diagnostics remain private and are not labelled successful evidence.

Independent code review found stale-source selection in model context and duplicate null-claim/review-retry behavior. Fixed exact current-source binding, idempotent no-work claim receipts and identical reviewed-rule replay. The regression suite also now counts the actual payment version/command tables. [Final local validation](validation.md). CI remains intentionally skipped.

Desktop light-mode browser checks covered learning, source PDF, shared work and model diff views. Dark-mode verification was attempted through Chrome rendering controls but was not completed reliably; it remains a visual follow-up, not a claimed pass. The user excluded phone support from this round.

## What this does and does not demonstrate

| Workshop idea | Demonstrated | Remaining broader work |
| --- | --- | --- |
| Tools operate on shared work | Same authoritative work ID; inspect, claim, wait, resume, pause; real bounded model decision | More exception types, communication delivery/reply lifecycle, repeated operating evidence |
| Transition diffs | Atomic work-state/diff writes, immutable event projection, policy/source/operation binding, denied stale controls tested | Uniform diff inventory across source reviews, journals, bank recovery, supplier/delegation changes |
| Humans and agents share authority | Record/version-bound human controls and independent payment boundaries retained | New feature's Auth0 identity replay and broader record visibility policy |
| Correction becomes precedent | Imported synthetic correction, separate scoped approval, persisted B/C recommendation results | Capture a real AP correction automatically; apply reviewed coding into later AP proposals; supersession/retirement UX; repeated measured cycles |
| Learn during onboarding | Nonposting typed historical import and scoped candidates with support/contradiction checks | Coherent authorized real history and independently held-out evaluation; model-derived practices |

B/C are two authored demo checks, not a blind evaluation benchmark or proof of real-world learning accuracy. The expected correction is supplied in A's synthetic history; no production history was inferred. No new Claude independent model review or practitioner sign-off occurred in this run. The team-owned Claude review remains a separate handoff item.

The prior $77 Increase settlement and QBO Bill147/BillPayment148 evidence remains in [the external flow result](../agent-live-20261025/ROLLOUT.md); it was not rerun or altered by this demonstration. Public hosting, multi-currency and production readiness remain outside this delivery.
