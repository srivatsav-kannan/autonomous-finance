# C4 accounting-only processing guard

The official [BillPayment schema](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment), checked 2026-10-25, describes ProcessBillPayment as optional merchant processing for credit-card-enabled companies. It does not document an assumed default in that field description.

Both generated BillPayment plans use Check, explicit APAccountRef and TxnDate, nonnegative TotalAmt, and omit merchant processing. Restored-payable plans inherit those base plans. This checkpoint preserves existing payload bytes, request IDs and operation hashes; it does not add a new field to immutable historical requests.

The client now rejects any present ProcessBillPayment value other than boolean false before token lookup or HTTP. Read verification, reconciliation and initial response matching also reject true or malformed processing flags, even if an expected payload itself requests them. An absent flag or explicit false on a returned object is compatible with an original omitted flag. Unrelated provider metadata remains additive. This is a local guard, not evidence of any live provider behavior.

Validation: 14 QBO files / 110 PASS; all three TypeScript configurations PASS. Four new protocol tests cover rejected outgoing values, unchanged saved bytes, explicit false, and processing rejection during initial response, readback and recovery. The authoritative settlement export test also asserts explicit AP account/date and absence of a processing request. No provider calls, credential reads or policy changes occurred.
