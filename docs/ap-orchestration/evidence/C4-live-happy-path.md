# Actual INV-1001 sandbox payment and accounting round trip

On 25 October 2026, the existing synthetic Golden State INV-1001 case completed the requested USD678.60 invoice-to-payment flow using real Auth0 login, Increase sandbox APIs and the QuickBooks Online US sandbox. This is a bounded happy-path PASS, not complete external-roadmap or bank-close acceptance.

## Actual results

- Case `kd7a1bytda9wteyr3ek1srj8qn8gy4xr`: reviewed, bill approved and recognized. The user clicked the final independent payment authorization.
- Increase transfer `sandbox_ach_transfer_spyd2r518l9gutry0hfn`: exactly one transfer and one matching posted debit `sandbox_transaction_02j4j1ax6a81pw5y034h`, USD678.60. Official sandbox submit/settle simulation was used. Provider status remains `submitted` with `settlement.settled_at`; the adapter corroborates the negative debit and normalizes this to `settled`.
- Local case: Settled / Matched / outstanding USD0.00. Recognition Dr5000/Cr2000 USD678.60; settlement Dr2000/Cr1000 USD678.60. Evidence worker posted1, replay posted0.
- QBO Bill145 and BillPayment146 each exist once under their stable operation markers. Payment146 links Bill145; authoritative Bill balance is0. Both operations retain one POST attempt. Browser BillPayment verification and separate API readback passed.

## Found, fixed, and rechecked

The first BillPayment POST created146, but QBO omitted its optional `APAccountRef`; strict response matching retained an `unknown` operation. Read-only marker lookup found exactly146 and identified only this missing field. The connector now verifies an omitted AP reference through every exact linked Bill/VendorCredit, including AP account, vendor and currency. Other economic fields and an explicitly returned AP reference remain strict; unsupported JournalEntry links fail closed. Recovery used the original unknown operation and GET lookup, preserving its request ID, original authorization and one POST attempt. No duplicate payment or accounting transaction was created.

Validation:49 local tests passed across7 focused files; application and test TypeScript checks passed. Only the isolated gateway8825 restarted. Runtime base remains b3c3bc6 with the exact client-file hash retained in the structured report. CI was not run.

## Limits retained

The test account was funded by an official +USD678.60 inbound ACH simulation. That setup deposit is retained as unmatched/non-AP bank activity, producing an explicit worker warning on each pass. The supplier-payment debit is matched and posted; full bank close and funding-capital classification are not complete. This report does not claim signed-webhook delivery, production/real-document acceptance, negative Auth0 cases, returns, credits or successive partial-payment acceptance. QBO advanced Bill145 SyncToken from0 to1 when payment applied; the original historical Bill receipt is preserved, and current readback confirms zero balance. Claude independent model review remains pending.

[Structured evidence](C4-live-happy-path.json) · [Verified QBO screen](C4-live-happy-path-qbo.jpg)
