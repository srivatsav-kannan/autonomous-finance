# AP agent sandbox — minimal synthetic full flow passed

**The requested minimal end-to-end sandbox flow passed. Issue 108 remains incomplete.**

The new **$77.00 USD** synthetic case (`INV-AGENT-20261025-01`) completed missing-receipt wait → evidence revision 2 → review → bill approval → separate user payment authorization → Increase settlement → QuickBooks BillPayment → bank reconciliation. The agent work item is **complete / reconciled**, with one payment and **$0.00** outstanding. The user performed bill approval and the separate payment authorization.

| Final evidence | Result |
| --- | --- |
| Increase transfer | `sandbox_ach_transfer_8mguyq0upoyjbjoa0516`, $77, settlement present |
| Settled debit | `sandbox_transaction_r8hbiuowvzm2dq0o7s7g` |
| QBO Bill | **147**, total $77, balance **$0** |
| QBO BillPayment | **148**, total $77, linked to Bill **147**; independently read back and verified in the UI |
| Case accounting | Recognition Dr 5000 / Cr 2000 $77; settlement Dr 2000 / Cr 1000 $77 |
| Test funding | `sandbox_transaction_oy9m8onuj9jyvcxbpgik`, classified as contributed test capital; journal `rx7e33cyp8s2a5b2asbthrr89n8gz3m8`, Dr 1000 / Cr 3000 $77 |
| Bank reconciliation | All **4** imported transactions matched and posted; cash ledger **$0**, imported net **$0**, unresolved **0** |

Independent provider readback at **2026-10-25 14:37:58 UTC (07:37:58 PDT)** confirmed the new transfer, QBO records, zero bank balance and preserved prior $678.60 transfer. The evidence preparer independently read the saved final provider result and reconciliation text and visually inspected the final QBO and reconciliation screenshots. `flow-summary.json` retains sanitized results and hashes. Raw local/provider receipts with identities remain private and must not be committed. This is bank reconciliation, not a claim of formal period close.

## Limits and remaining work

The sandbox serves a forensic recovery copy. The original malformed database remains preserved. Exactly five orphan index versions were removed while 1,672 surviving documents and unaffected audited rows were unchanged; checked dangling references became zero and four PDF hashes matched. This does not prove SQLite `.recover` retained completely missing records.

The current agent progression is **deterministic**. Issue 108 still requires the real model decision/tool loop, the adapter consuming issue107's shared APEX packet, remaining crash/retry/duplicate/denial evidence, and before/after model/tool traces with handoff. The new external-flow requirement is now complete; see `ISSUE-108-REMAINING.md`.

CI is skipped at the user's request. These are synthetic native PDFs, not a fresh LlamaParse validation. No Claude independent model review or practitioner sign-off is claimed.
