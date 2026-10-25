# Autonomous Finance — three-minute team pitch

Based on the [current AP narrative](../docs/DEMO.md) and [issue #97](https://github.com/srivatsav-kannan/autonomous-finance/issues/97). Read only the blockquotes aloud. Screen directions and evidence notes are for the team.

**One story:** original evidence → reviewed obligation → separate payment authorization → recovery → reconciled accounting.

| Time | Speaker | Responsibility |
| --- | --- | --- |
| 0:00–0:55 | **Srivatsav** | The problem, product and source evidence. |
| 0:55–1:55 | **Arav** | Business review, approval boundaries and the failure scenario. |
| 1:55–3:00 | **JJ** | Recovery result, accounting and the ambition. |

**Arav operates the laptop throughout.** Keep the recorded I2 case open for live navigation. Its documents and reviewer identities are synthetic, and its bank is local FakeBank. Use the separate recovery test's saved evidence at the marked handoff; a labeled recording can replace that evidence once prepared. Do not click a new financial approval during this script.

## 0:00–0:55 — Srivatsav: why this work matters

*Screen: I2's original Golden State invoice and case. Arav highlights a source-backed line, then opens its PO and receipt. Leave any unresolved source location visibly unresolved.*

> Before a company pays a supplier, someone has to connect what was ordered, what arrived, what is owed, and who can approve it. Then they have to prove what happened to the money.
>
> We're building Autonomous Finance to carry that work through one traceable accounts payable case, with agents preparing the work and people retaining the decisions their policy requires.
>
> This example uses synthetic documents and a local bank simulator. LlamaParse reads the files; our adapter links reviewable fields to their sources. You can inspect the invoice, purchase order and receipt together, with uncertainty visible.
>
> Arav will show how evidence becomes a controlled decision.

## 0:55–1:55 — Arav: a decision is not permission to pay

*Screen: I2's accepted/disputed amounts and recorded review stages. Then show its recognition journal and separate $100 payment authorization. Keep the amount card below visible; there is no need to read every number.*

> Here, review accepted part of the invoice and kept the rest in dispute. The original claim stays intact. An agent's calculation alone cannot authorize a reduced payment.
>
> Reviewing fields, approving the bill and authorizing payment are separate decisions. Bill approval records the payable. Payment authorization binds an exact amount and destination, and the requester cannot approve its own payment.
>
> This case received a separately authorized one-hundred-dollar payment. The remaining accepted balance is still owed.

*At about 1:40, switch to the recovery evidence. Label it **Separate local recovery test**; it is not the I2 case. If using a clip, mute its audio and label any accelerated wait.*

> Now, a separate failure test: the bank accepts the request, but the response is lost before the worker records the result. The outcome stays unknown.
>
> JJ, show how it recovers.

## 1:55–3:00 — JJ: prove the outcome, then show the ambition

*Screen: recovery evidence showing the original operation and transfer, then return to I2's settlement journal, AP-to-GL comparison and close blockers.*

> Recovery reuses the saved operation. In this test, it produced one transfer, one bank debit and one settlement posting.
>
> Back in our AP case, settlement reduces the payable and cash; it doesn't expense the purchase again. The AP subledger and general ledger agree. Unresolved close requirements remain visible. The audit trail connects the bank result to the approval and original evidence.
>
> Our next step is a shared workflow where agents request missing evidence, resume the same case, and propose reusable rules from reviewed corrections. Those rules must be approved and tested before reuse.
>
> That's Autonomous Finance: for every payment, a clear answer to what we owe, why we owe it, who authorized it, and what happened next.

## The amount card — I2 only

| Original invoice | Accepted | Disputed | Paid | Accepted AP outstanding |
| ---: | ---: | ---: | ---: | ---: |
| $678.60 | $285.60 | $393.00 | $100.00 | $185.60 |

The $185.60 excludes the separately disputed $393.00. This is a partially paid case, not a fully cleared invoice. Its recorded AP-to-GL difference is $0, with six close blockers remaining. [I2 evidence](../docs/ap-orchestration/evidence/I2-business-flow.md)

Do not substitute I1's fully paid $678.60 case, the mockups' illustrative $662.90 invoice, or another run's bank/journal IDs while narrating these amounts.

## Rehearsal and screen setup

Target a calm **125–135 spoken words per minute**, with the remaining time for clicks and handoffs. The time slots are rehearsal targets, not a measured recording. Rehearse once with a stopwatch and the actual tabs.

Before each judge:

1. Open I2's source review, recorded business/payment approvals, and accounting/reconciliation views. Test the source highlight and keep the provider/identity labels visible. Navigate the persisted case live; describe its approvals in the past tense.
2. Open the [independent recovery report](../docs/ap-orchestration/evidence/V2.md) at its lost-response scenario and result. It verifies state/recovery using `convex-test` and SQLite FakeBank; it is not a video of a live worker being killed. If using an actual worker-crash recording, identify that separate run and its evidence. Avoid an unrehearsed live lease wait in the three-minute slot.
3. Prepare the bank/settlement links and AP-to-GL comparison before JJ's turn. Return to I2 explicitly after the separate failure test.
4. Save a backup recording locally before presenting. A recording or a screenshot should be identified as such; a UI design mockup is not a completed feature.
5. Keep [DEMO.md](../docs/DEMO.md) ready for the longer accounting explanation, extra scenarios and technical questions. It covers all thirteen requested accounting terms; do not rush through that glossary in the opening pitch.

For an optional live crash demonstration outside this script, follow the [isolated recovery runbook](../docs/ap-demo/README.md#browser-approval-then-crash-recovery-one-flow-for-judges). That flow uses a local test identity and changes its backend's auth configuration. Keep it separate from the active Auth0/QuickBooks environment.

**If running late:** Srivatsav can omit “You can inspect the invoice, purchase order and receipt together, with uncertainty visible.” JJ can omit “The AP subledger and general ledger agree. Unresolved close requirements remain visible.” Preserve the simulation label, separate-test transition and final sentence.

**If a screen stalls:** say, “This view isn't loading; I'll show the saved verification for this case.” Use the matching report or prepared recording. Do not call a stalled payment successful or replace an unknown operation with a new payment.

## Two-minute Q&A — who takes what

| Owner | Question | Short answer |
| --- | --- | --- |
| **Srivatsav** | Who is this for? | “Finance teams handling supplier invoices across locations, where evidence, approvals and payment outcomes need to stay connected.” |
| **Srivatsav** | What is new here? | “The obligation stays connected across documents, review, authorization, bank execution and accounting. We can explain both why work moved forward and why it stopped. Shared work and reviewed learning are the next layer.” |
| **Srivatsav** | Is this production-ready or self-learning today? | “We have verified supported local AP paths and are completing external integration and broader evaluation. Autonomous follow-up, historical onboarding and correction-to-rule learning have separate acceptance work.” |
| **Arav** | What if the model is wrong? | “Fields stay reviewable against their sources. Backend checks enforce the supported arithmetic, authority, version and payment boundaries. Business correctness also needs explicit policy and review.” |
| **Arav** | Do you guarantee exactly once? | “We verify the outcome under a specified failure: one intended transfer, one posted bank debit and one settlement effect. That is a tested invariant, not a universal network guarantee.” |
| **Arav** | Why not automatically short-pay a discrepancy? | “A proposed adjustment isn't authority. The company must have an applicable policy or an authorized decision, and the disputed amount and original evidence remain visible.” |
| **JJ** | How good is the parser? | “On two new synthetic supplier layouts in native and scan versions, the repaired adapter recovered all 104 checked fields across four files. Source locations passed for 102, with two explicitly unresolved. This used cached real provider results; it isn't a broad production benchmark.” |
| **JJ** | Are Auth0, QuickBooks and Increase live? | “A separate synthetic $678.60 case completed through Auth0, QuickBooks and Increase sandbox APIs, with one transfer and linked accounting records. We rechecked the records and repaired a QuickBooks readback difference. This uses simulated money; signed webhooks and a fresh complete flow on the updated branch remain unverified.” |
| **JJ** | What does it cost? | “We're prioritizing correct outcomes and useful automation. The old simulator's cost numbers don't estimate this document, review and payment workflow.” |

The external-integration answer follows the [sandbox acceptance report](SANDBOX-ACCEPTANCE.md). The [independent model review](review-105/REVIEW.md) still leaves F1–F3 high control/lifecycle findings open; do not imply separate buttons guarantee separate human approvers or that I2's disputed remainder can already be released. The sandbox case is separate from I2 and the crash/recovery test.

The local walkthrough follows the evidence snapshot in [DEMO.md](../docs/DEMO.md). Before changing it, check the [capability matrix](../docs/ap-orchestration/CAPABILITIES.md) and the named provider's actual transaction evidence. Configuration or login alone does not prove accounting synchronization or payment execution.

## Organizer logistics — retained from the previous pitch

The team's recorded organizer instructions are: arrive at the Palace of Fine Arts by **9:30 AM**, be at the assigned table by **10:30 AM**, and remain there for judging **10:30 AM–12:30 PM**. Expect at least three judges, with **five minutes maximum per judge**. Plan three minutes for this pitch and two for questions. A live demo is required, with a backup video saved on the laptop. Up to three teams share a table.

## Evidence at hand

- [I2: partial acceptance, independent approvals, payment and outstanding AP](../docs/ap-orchestration/evidence/I2-business-flow.md)
- [V2: independent negative and recovery verification](../docs/ap-orchestration/evidence/V2.md)
- [Parser repair: 104 checked fields, 102 accepted source locations](../docs/ap-orchestration/evidence/V7-parser-repair.md)
- [Actual Auth0 login and scoped workspace access](../docs/ap-orchestration/evidence/C2-auth0-live.md)
- [QuickBooks sandbox reference mappings](../docs/ap-orchestration/evidence/C4-live-mappings.md)
