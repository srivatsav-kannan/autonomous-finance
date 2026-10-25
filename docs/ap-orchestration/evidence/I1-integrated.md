# I1 — original PDF to reviewed AP and FakeBank outcome

**PASS: one locally integrated original-source case at code `a13b131`.** This is a measured integration milestone, not completion of issue97, external Increase/QBO verification or practitioner sign-off. See [structured evidence](I1-integrated.json) and [browser result](I1-settled.png).

Actual multipart upload preserved four original PDFs (invoice, PO, receipt, contract) and created case `js7dsh0qwptbgg2ngm9vgbt6bs8gy13s`, revision1. Its four invoice lines total67860 cents. All22 frozen expected fields passed against the V1 independent original derivation; all35 extracted fields were inspected, with33 native locations and2 explicitly unresolved locations. Original HTTP downloads matched all four source hashes. The native Kale description highlight was visually inspected on the original PDF. No answer key is imported by runtime services.

The LlamaParse adapter reused four genuine completed `agentic_plus` jobs requested at version2026-09-28;13 referenced artifacts were hash-verified before import into the private runtime cache. I1 made no new parsing request. Requested version is recorded; provider-resolved version remains unavailable. The upload route records user-upload provenance without pretending to authenticate the supplier; fixture documents themselves are visibly synthetic.

Three separate decisions were observed: field review created no bill; bill approval created one recognition entry but no payment authorization; a payment proposal remained awaiting approval with no command until independent local simulated-human authorization. A premature payment request was rejected. Exact payment snapshot hash is saved in the private phase evidence.

The existing dispatcher and evidence worker executed the authorized FakeBank payment with an explicit settlement simulation. Two consecutive worker runs left **one intended transfer, one posted bank debit, one recognition journal and one settlement journal**. Recognition is Dr5000 67860 / Cr2000 67860 (four reviewed line allocations); settlement is Dr2000 67860 / Cr1000 67860. Outstanding AP is0. Bank transaction and both journal identities are in the structured evidence. This establishes per-case AP/payment/bank matching, not a full cash statement balance reconciliation.

The initial upload request was retried after the server restart; the saved response and case identity were returned unchanged. A changed request under the same key returned409 `intake_key_conflict`. A renamed copy under a new key associated to the same case, added four delivery history events, and changed none of the revision, snapshot, states, amounts, bill/payment links or journals. The response's `replayed:false` value is the original persisted response, not a newly computed replay flag.

Reproduction (owned local FakeBank scope only):

- `scripts/ap-system/verify-first-case.ts` checks originals, stages and journals. Initial preparation is intentionally a one-time phase; after settlement use `--settled`.
- `scripts/ap-system/worker.ts --once --simulate-settlement`, repeated twice, produced one transfer/debit and no evidence errors.
- `scripts/ap-system/verify-intake-replay.ts` verifies durable upload retry and renamed delivery.
- `npx tsc --noEmit -p tsconfig.tests.json` passed.

The browser displayed the same settled case, $0 outstanding, separate recognition/settlement entries and “External accounting: Not connected / not run.” It also exposed a direct-link session initialization race and an overly long field panel; D is fixing these. V2 will independently exercise negative paths, B/C revision invalidation, lost responses and interrupted posting. No real money, production writes, Increase transfer or QuickBooks sync occurred.
