# Demo: from supplier evidence to an accountable payment

Cal Hacks 13.0 · Hyphenate track · Narrative updated for [issue #97](https://github.com/srivatsav-kannan/autonomous-finance/issues/97).

**Positioning:** Autonomous Finance carries an accounts payable case from the original supplier documents through review, authorized payment and reconciliation, with evidence explaining each decision.

This is the current AP narrative. Use [the synchronized three-person pitch](../submission/PITCH.md) for the timed English script, speaker handoffs and screen cues. This document provides the fuller walkthrough and evidence boundaries. Current implementation evidence takes precedence over the issue's original planning baseline.

## The opening

> A supplier sends an invoice. Before anyone pays it, the finance team has to establish what was ordered, what arrived, what the company actually owes, and who can authorize the payment. Then it has to prove what happened at the bank and in the books.
>
> We're building Autonomous Finance to carry that work forward as one traceable AP case. Agents prepare and explain the work. The system enforces the controls, and people retain the decisions their company policy requires.

**The question to keep answering on screen:** “Why do we owe this amount, who approved it, and what happened to the money?”

Start with the original document and the business decision. Reveal the infrastructure when it explains why the decision is trustworthy. The larger ambition is a finance system that maintains context across documents, people, time and failures; AP is the first workflow in which we are proving it.

## The story: one obligation, several distinct decisions

**Original documents → reviewed facts → accepted obligation → authorized payment → bank evidence → reconciled accounting.**

An invoice is the supplier's claim. The PO records the order, the receipt records delivery, and the approved supplier master supplies the payment destination. A model's interpretation cannot replace those authorities.

The strongest current business example is the [I2 partial-payment case](ap-orchestration/evidence/I2-business-flow.md):

| Record | Amount | Meaning |
| --- | ---: | --- |
| Original Golden State invoice | $678.60 | What the supplier billed; the original stays intact. |
| Explicitly accepted portion | $285.60 | The obligation accepted through the recorded business review. |
| Disputed portion | $393.00 | Still unresolved; it was not silently erased or declared forgiven. |
| Settled payment | $100.00 | A separately authorized partial payment through local FakeBank. |
| Accepted AP still outstanding | $185.60 | The unpaid portion of the recognized payable. |

Use these amounts together only for I2. The separate [I1 clean case](ap-orchestration/evidence/I1-integrated.md) recognizes and settles $678.60, leaving $0 outstanding. The issue's proposed UI mockups use an illustrative $662.90 invoice; those images are design concepts, not evidence from either run.

## Three-minute live narrative

Keep one operator on the laptop. A second presenter can explain the accounting and reliability evidence. Use the recorded I2 case for the business walkthrough; it has simulated human identities and local FakeBank execution. Show actual Auth0 access separately if needed. Do not present an already-recorded decision as a new approval.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:25 | Original invoice beside the case. | “A supplier sends a $678.60 invoice. Paying it correctly means connecting the document to what was ordered, what arrived, and who can approve it. This case keeps those records together.” |
| 0:25–0:50 | Click an extracted line to highlight its source. Open the linked PO and receipt. | “LlamaParse reads the document; our adapter turns the result into reviewable fields. You can inspect where a value came from. If a location is uncertain, we keep that uncertainty visible. Reading the invoice doesn't authorize it.” |
| 0:50–1:20 | I2's original, accepted and disputed amounts; recorded approval stages. | “Here, the authorized review accepted $285.60 and left $393 in dispute. The original invoice hasn't changed. The system records the decision and its evidence. It doesn't assume the agent has permission to pay less just because it calculated a difference.” |
| 1:20–1:45 | Recognition journal, then the separate $100 payment approval. | “Approving the bill records what we owe. Authorizing payment is another decision, tied to an exact amount and destination. We paid $100, so $185.60 remains in the AP subledger. The requester cannot approve its own payment.” |
| 1:45–2:15 | A labeled recording of the payment engine's crash/recovery test, with original operation and recovered transfer. | “Now the failure test: the bank accepts a request, but the response is lost and the worker crashes. The outcome stays unknown. Recovery reuses the saved operation instead of inventing another payment. In this test, that produced one transfer, one bank debit and one settlement posting.” |
| 2:15–2:40 | Return to I2: bank evidence, settlement journal, AP-to-GL check and remaining close blockers. | “We can trace the payment back to its approval and documents. Recording settlement reduces AP and cash; it doesn't expense the purchase again. The AP subledger and general ledger agree, while unresolved close requirements remain visible.” |
| 2:40–3:00 | Case history and the next-step roadmap. | “That's the foundation: carry the obligation forward, preserve the evidence, and recover without losing control. Next, we're extending the shared agent-and-human work queue and turning reviewed corrections into scoped, testable precedents.” |

The new [I3 same-case laptop walkthrough](ap-orchestration/I3-RUNBOOK.md) now verifies one uploaded case from missing-receipt hold through later receipt, actual worker SIGKILL and settled reconciliation. Use its recorded phases or a fresh isolated rehearsal for that complete story. Keep it distinct from the I2 partial-payment narrative.

The recovery clip is a **separate local verification**, not a claim that I2 crashed. If replacing it with a live run, use the isolated runbook below and allow the real lease wait. Only call the entire sequence one live case after rehearsing and recording that exact source-to-crash-to-reconciliation run.

**Two-minute cut:** shorten the source and accounting explanation, retain the approval boundary and recovery proof, and finish on outstanding AP. **Five-minute version:** add the duplicate upload, actual Auth0 workspace access, and the accounting walkthrough below. Use a separate labeled case for any additional exception.

## What to highlight, and why it matters

The issue's hard parts should each have a concrete on-screen answer:

| Hard part | The visible answer | Current boundary |
| --- | --- | --- |
| Sources disagree | Original invoice, ordered/received quantities, accepted/disputed amounts, resolution evidence. | A discrepancy needs an authorized resolution. A note saying “Vendor notified” does not prove communication occurred. |
| Time matters | Source revisions, approval history, due/scheduled dates, unpaid balance and close blockers. | I2 verified a future-date payment produced no transfer before its date. This is not a months-long production study. |
| People and agents share work | Distinct field review, business review and payment authorization; owner and next permitted action. | The new AP agent-runner/shared-follow-up loop is a separate acceptance item. API calls under agent credentials alone do not prove autonomous orchestration. |
| Access has limits | Exact reviewed version, amount and destination; backend rejection of prohibited approvals. | I2 identities are simulated. Real Auth0 login and scoped case access have separate evidence. |
| Decisions remain accountable | Source version → decision → approval → payment → bank record → journal. | A complete field-level transition-diff system and correction-to-precedent learning need their own verification. |

For the duplicate moment, show the same file delivered again under a new name. The [I1 replay check](ap-orchestration/evidence/I1-integrated.md) preserved the existing case and economic records while recording the additional delivery. Say: “A new delivery doesn't become a new debt.”

## Accounting walkthrough for the longer demo

Use the terms where the audience can see the relevant records, rather than reading a glossary.

1. **System of record:** show which source is authoritative for each fact: supplier master for the approved destination, receipt for delivery, ledger for posted accounting, and verified bank records for execution. The invoice does not override all of them.
2. **Chart of accounts, journal entry and double-entry bookkeeping:** open I2's recognition entry. Its reviewed allocations debit account 5000 by $285.60 in total and credit AP 2000 by $285.60. This is the fixture's declared treatment; other purchases may be inventory, assets or prepayments. Balanced debits and credits are necessary, but do not by themselves prove correct coding or period.
3. **Subledger and general ledger:** show the supplier's $185.60 unpaid accepted balance, then the matching AP control-account balance. Name this AP-subledger-to-GL reconciliation. It is distinct from matching a bank transaction to a payment.
4. **Internal controls and segregation of duties:** point to the independent payment authorization and its exact snapshot. A change to material payment terms requires renewed review; an unknown bank outcome cannot simply be replaced with another payment.
5. **Controller and materiality:** explain the Controller's responsibility for accounting accuracy and exception/close review. A software controller role is not an independent human professional. Show the explicit matching tolerance where applicable; it is not a substitute for audit materiality and never excuses unauthorized payment or suspicious bank changes.
6. **Reconciliation, period close and audit trail:** show the $100 settlement entry, debit AP / credit cash, and its bank evidence. I2's AP-to-GL difference is $0, but six close blockers remained in the recorded check. Agreement on one balance does not mean the period is ready to close. Trace one posting backward to the source and decision.

## Proof card: what we can substantiate now

Local evidence snapshot: 25 October 2026, inspected at integration revision `764701b7400561313f22a18b1f70fe45dc9f5283`. Each report below retains its own tested revision and scope. These are separate verification runs, not one cumulative production score. Recheck the [capability matrix](ap-orchestration/CAPABILITIES.md) before presenting newly completed integration work.

| Claim | Measured evidence | Label on screen |
| --- | --- | --- |
| Original documents connect to an AP outcome | I1: four original PDFs preserved; field review, bill recognition and payment authorization separated; one transfer, one bank debit, one recognition journal and one settlement journal. Renamed delivery did not duplicate the obligation. [Report](ap-orchestration/evidence/I1-integrated.md) | Synthetic business documents · local FakeBank · simulated human authority |
| Partial acceptance and payment retain the right balances | I2: $678.60 invoiced; $285.60 accepted; $393 disputed; $100 paid; $185.60 accepted AP outstanding. AP subledger and GL agree; six close blockers remain. [Report](ap-orchestration/evidence/I2-business-flow.md) | Separate recorded local integration case |
| Parser output is reviewable beyond one layout | Two new synthetic supplier layouts, native and scan variants: 4/4 complete candidates; 104/104 checked fields; 102/104 accepted source locations, with two explicitly unresolved. Independent repair verification replayed the original cached provider results. [Report](ap-orchestration/evidence/V7-parser-repair.md) | Four controlled files · not a blind or representative production benchmark |
| Failure recovery preserves the authorized operation | Independently verified local negative/recovery paths; retain the exact test/run and observed economic counts. [V2 evidence](ap-orchestration/evidence/V2.md), [recovery runbook](ap-demo/README.md) | Local FakeBank failure test · separate from I2 |
| A real person can enter the scoped workspace | Actual Auth0 login, explicit workspace binding and authenticated case/original preview verified. [Report](ap-orchestration/evidence/C2-auth0-live.md) | Real identity-provider login · this report does not establish a human-approved external transaction |
| QuickBooks sandbox connectivity and mappings work | OAuth/read-only connection and eight reference-record writes verified: one vendor, six accounts and one Class. Replay created no new records. [Report](ap-orchestration/evidence/C4-live-mappings.md) | Historical setup checkpoint; see the subsequent sandbox transaction report below |

Subsequent external evidence: one synthetic $678.60 case on the dedicated Auth0 runtime reached QuickBooks Bill 145 / BillPayment 146, Increase settlement and local bank reconciliation. Provider GETs reconfirmed the records; this branch repairs the merged-main missing-AP-reference verifier failure. See [sandbox acceptance](../submission/SANDBOX-ACCEPTANCE.md) for exact runtime, IDs and limits. No fresh full-flow run on this branch or signed webhook acceptance is claimed. Do not combine this case with I2 or the local crash test. The format work includes a declared XML profile and measured image/TIFF cases, not every document format. Packaged OCR build and the bounded two-scan runtime smoke have passed; this does not establish full application OCR integration or production accuracy. See the [packaging report](ap-orchestration/evidence/A4-ocr-packaging-review.md). Broader real-document evaluation and practitioner review remain separate open gates.

The older simulator and public-task comparisons remain in [RESULTS.md](RESULTS.md). Use them only with their original sample definitions and denominators. They are supplementary evidence, not the headline proof for the new AP workflow. Cost savings and reduced human workload need their own measurements.

## Ambition: the next layer of the product

> We want the system to carry a finance team's work across time: request missing evidence, resume the same case when it arrives, learn proposed practices from reviewed history, and make every change explainable.

The [workshop follow-up in #97](https://github.com/srivatsav-kannan/autonomous-finance/issues/97#issuecomment-6396167295) proposes concrete future experiments:

- **Shared work:** a running agent requests a missing receipt, assigns the follow-up, waits, and resumes the same case after an authorized person supplies it.
- **Explainable change:** saved transitions show the relevant before/after values, actor, reason, evidence and policy version, including denied actions.
- **Reviewed learning:** a human correction becomes a proposed, narrowly scoped precedent. An authorized reviewer approves it; a later qualifying case uses it; an out-of-scope counterexample does not.
- **History-based onboarding:** historical documents and final decisions support proposed company practices. Past behavior does not automatically create policy or payment authority.

These are separately proposed extensions with suggested acceptance tests; they are not additions to the adopted frozen delivery scope without an explicit scope decision. An older parser-spec proposal or a seeded company memory does not establish that the new AP system learns from every correction. The existing wider finance simulator can illustrate the direction after AP is clear; it does not establish department-wide production readiness.

## Before presenting

1. Select the primary case and verify its source, amounts and provider/identity labels. Keep I1, I2, the Auth0 case and recovery run visibly distinct.
2. Prepare the original document, business review, approval history, journal and reconciliation tabs for that case. Rehearse the actual navigation and source highlight; a proposed UI mockup is not a product screenshot.
3. Open the linked recovery evidence or save a recording locally. If using a live failure run, reserve enough time for the lease and verify the final IDs/counts before the audience arrives.
4. Check the latest Auth0/QBO/Increase evidence. Promote a pending integration claim only after its named external write/readback or execution gate passes. Successful login alone is insufficient.
5. Keep a local video of the same verified workflow. Label recordings, simulated identities, FakeBank, sped-up waits and any design concepts. Do not include tokens, private provider responses or credentials.

### Optional live crash demonstration

The established [browser-approval recovery runbook](ap-demo/README.md#browser-approval-then-crash-recovery-one-flow-for-judges) remains useful on its **own isolated local backend**:

```bash
npm run demo:local -- --browser-approval --lease-wait-seconds 40
```

Follow that guide's backend and console setup first. It uses a loopback test identity and `/ap-demo`, not the real Auth0 `/ap-system` session. It changes that backend's demo auth configuration, so do not run it against Master's active Auth0/QuickBooks environment. Each new rehearsal needs a new run; preserve the bank and backend state during recovery.

At the fault, say “the bank accepted the request; the response was lost.” Acceptance is not proof of settlement. While waiting, explain the saved operation, reservation and next permitted recovery action. When the test finishes, show its actual transfer, posted-debit and settlement-entry counts. Report a failed or unknown outcome as such.

## Questions to be ready for

The [Claude independent model review](../submission/review-105/REVIEW.md) found three open high-severity controls/lifecycle gaps (F1–F3), plus medium findings. I2's disputed $393 remains visible but cannot yet become payable on its original invoice. Separate approval stages do not currently guarantee separate human approvers; the sandbox success does not resolve those findings.

- **“Is this real data?”** The connected business cases use authored synthetic documents. LlamaParse and Auth0 were exercised against real services. FakeBank simulates bank execution. One separate synthetic case also completed the real QuickBooks and Increase sandbox APIs with simulated money ([report](../submission/SANDBOX-ACCEPTANCE.md)). Real company source packets and human practitioner review remain unverified.
- **“Does the agent decide to pay less?”** It can propose a treatment. The accepted amount must follow explicit company policy or an authorized decision. The supplier's original claim and unresolved disputed balance remain visible.
- **“What if the model is wrong?”** Extracted fields remain inspectable. Backend controls enforce the supported arithmetic, authority, version and payment boundaries. Domain judgment still needs policy, review and outcome evaluation; balanced books alone do not prove correctness.
- **“What is novel?”** The product ties evidence, business decisions, authorization and recovery to the same obligation. We can inspect why it moved forward, why it stopped, and what financial effects actually happened. Shared work and reviewed learning extend that foundation.
- **“Do you guarantee exactly once?”** In the specified local failure test, recovery reused the authorized operation and produced one intended transfer, one bank debit and one settlement effect. That is an observed invariant under the tested provider protocol, not a universal network guarantee.
- **“Can it run the entire finance department?”** The broader simulator explores that direction. The present product work is an AP system with explicit supported paths and verification gates. Full enterprise deployment, every accounting policy and autonomous onboarding are not established by this demo.
- **“What does it cost?”** We are prioritizing correct outcomes, useful automation and review latency. The older simulator's cost figures are not an estimate for this document/OCR/approval workflow.

**Closing line:** “For every payment, we want a clear answer: what we owe, why we owe it, who authorized it, and what happened next.”
