# INV-1001 sandbox bank reconciliation completed

On 25 October 2026 the user requested classification of the exact USD678.60 simulated funding deposit and completion of bank reconciliation. The existing authenticated Auth0 browser recorded the classification through the normal protected gateway and Convex human mutation. No new payment or funding transfer was created.

## Actual accounting and bank result

- Funding transaction `sandbox_transaction_7in7uo3dooxz3307i4cu`: posted inbound ACH +USD678.60, originally produced by the official Increase simulator. Its category was preserved.
- Journal `rx73vfsg1t42av182g987kn3c58gytxg`: Dr1000 bank / Cr3000 test contributed capital, USD678.60; one exact stable funding key and retained reason.
- Supplier payment debit `sandbox_transaction_02j4j1ax6a81pw5y034h`: -USD678.60 remains linked to its original settlement journal. One settled payment remains.
- Exactly two imported bank transactions, both posted and matched; zero unresolved bank/AP evidence blockers. Three journals total: original bill recognition, original settlement, one funding journal.
- Local cash GL0 equals fresh Increase current balance0 and available balance0. Evidence-worker replay returns posted0/errors[]; no duplicate journal or payment.

## Fix and verification

The existing funding mutation accepted only inbound wire. It now also accepts an explicitly classified positive posted inbound ACH in Increase sandbox. Exact amount, authenticated human, run/account scope, retained reason, USD, no payment/return linkage and stable journal idempotency remain enforced. Other ACH collections and return categories remain ineligible. A protected bank-evidence view and classification form expose the actual journals and current unresolved count.

26 focused tests passed in three files, including real HTTP → request-bound service → Convex-test authorization, malformed/foreign authority inputs, amount mismatch and repeat submission. Application, backend and test typechecks, console build and design check passed. Actual browser classification and provider/ledger readback are retained. CI remains deferred by the user.

## Scope retained

This completes the bank-to-local-ledger reconciliation for this synthetic sandbox run. It does not freeze the accounting month: the business-policy/statement/opening-review period-close workflow was not executed in this live run. The test capital journal has not been exported to QBO; Bill145 and BillPayment146 remain the previously verified external AP flow, so this report does not claim QBO bank-account reconciliation. Claude independent model review is pending; no practitioner sign-off is claimed. Production, real supplier data and broader external failure scenarios remain outside this bounded proof.

[Structured actual records](C4-funding-reconciliation.json) · [Authenticated browser result](C4-funding-reconciliation.jpg) · [Earlier invoice/payment/QBO evidence](C4-live-happy-path.md)
