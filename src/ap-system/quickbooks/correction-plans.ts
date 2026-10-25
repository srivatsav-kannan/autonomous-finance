import type {
  BankReturnCorrection,
  PaymentAllocationCorrection,
  Plan,
  Operation,
  Mappings,
  AccountingExport,
} from "./types";
import { hash, canonical, QboError } from "./private-store";
import { paymentPlan, validateMappings } from "./plans";
const money = (c: number) => {
  if (!Number.isSafeInteger(c) || c <= 0 || c > 999999999999)
    throw new QboError("invalid_correction_amount");
  return c / 100;
};
export const returnIdentity = (
  organizationId: string,
  runId: string,
  c: BankReturnCorrection,
) => `BankReturn:${organizationId}:${runId}:${c.returnTransactionId}`;
export function returnPlan(
  e: AccountingExport,
  m: Mappings,
  payment: Operation,
): Plan {
  const c = e.correction;
  if (
    c?.kind !== "bank_return" ||
    e.detail.caseId !== c.caseId ||
    !e.authorizedSubject ||
    !c.correctionId ||
    !/^[a-f0-9]{64}$/.test(c.proposalHash) ||
    !/^[a-f0-9]{64}$/.test(c.policyHash) ||
    !Number.isSafeInteger(c.approvedAt)
  )
    throw new QboError("approved_return_correction_required");
  validateMappings(m, m.realmId);
  const vendor = m.vendors[c.supplierId];
  if (
    !vendor ||
    m.apAccount !== c.apAccount ||
    m.bankAccount !== c.bankAccount ||
    c.currency !== "USD" ||
    c.amountCents !== c.original.amountCents ||
    payment.entity !== "BillPayment" ||
    payment.state !== "succeeded" ||
    !payment.externalId ||
    payment.realmId !== m.realmId ||
    payment.mappingHash !== hash(m) ||
    payment.links.caseId !== c.caseId ||
    payment.links.billId !== c.billId ||
    payment.links.paymentVersionId !== c.original.paymentVersionId ||
    payment.links.commandId !== c.original.commandId ||
    payment.links.bankTransactionId !== c.original.bankTransactionId ||
    payment.links.settlementJournalId !== c.original.journalId ||
    payment.payload.TotalAmt !== money(c.amountCents) ||
    canonical(payment.payload.VendorRef) !== canonical({ value: vendor.id })
  )
    throw new QboError("return_payment_binding_conflict");
  const identity = returnIdentity(
    e.detail.scope.organizationId,
    e.detail.scope.runId,
    c,
  );
  return {
    version: "ap-qbo-operation-v1",
    minorVersion: 75,
    realmId: m.realmId,
    identity,
    entity: "JournalEntry",
    mappingHash: hash(m),
    links: {
      ...payment.links,
      correctionId: c.correctionId,
      settlementJournalId: c.returnJournalId,
      bankTransactionId: c.returnTransactionId,
    },
    payload: {
      CurrencyRef: { value: "USD" },
      TxnDate: c.date,
      DocNumber: `AP${hash(identity).slice(0, 18)}`,
      PrivateNote: `ap-sync:${hash(identity)}; approved return ${c.correctionId}; original BillPayment ${payment.externalId}; return journal ${c.returnJournalId}`,
      Line: [
        {
          Amount: money(c.amountCents),
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: m.accounts[m.bankAccount]!.id },
          },
        },
        {
          Amount: money(c.amountCents),
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { value: m.accounts[m.apAccount]!.id },
            Entity: { Type: "Vendor", EntityRef: { value: vendor.id } },
          },
        },
      ],
    },
  };
}
export function assertRestoredOperation(
  c: BankReturnCorrection,
  op: Operation,
  m: Mappings,
) {
  if (
    op.entity !== "JournalEntry" ||
    op.state !== "succeeded" ||
    !op.externalId ||
    op.realmId !== m.realmId ||
    op.mappingHash !== hash(m) ||
    op.links.caseId !== c.caseId ||
    op.links.billId !== c.billId ||
    op.links.correctionId !== c.correctionId ||
    op.links.bankTransactionId !== c.returnTransactionId ||
    op.links.settlementJournalId !== c.returnJournalId
  )
    throw new QboError("verified_return_correction_required");
  const lines = op.payload.Line as any[];
  const vendor = m.vendors[c.supplierId];
  if (
    !vendor ||
    !Array.isArray(lines) ||
    canonical(lines) !==
      canonical([
        {
          Amount: money(c.amountCents),
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: m.accounts[m.bankAccount]!.id },
          },
        },
        {
          Amount: money(c.amountCents),
          DetailType: "JournalEntryLineDetail",
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { value: m.accounts[m.apAccount]!.id },
            Entity: { Type: "Vendor", EntityRef: { value: vendor.id } },
          },
        },
      ])
  )
    throw new QboError("return_journal_payload_conflict");
}
export function allocatedPaymentPlan(
  e: AccountingExport,
  m: Mappings,
  bill: Operation,
  credits: Operation[],
  restored: Operation[],
): Plan {
  const c = e.correction;
  if (
    c?.kind !== "payment_allocation" ||
    c.caseId !== e.detail.caseId ||
    !e.settlement ||
    canonical(c.settlement) !== canonical(e.settlement) ||
    !c.correctionId ||
    !/^[a-f0-9]{64}$/.test(c.proposalHash)
  )
    throw new QboError("approved_payment_allocation_required");
  const base = paymentPlan(e, m, bill, credits);
  const gross = e.settlement.grossAppliedCents ?? e.settlement.amountCents;
  if (
    !Number.isSafeInteger(c.originalBillCents) ||
    c.originalBillCents < 0 ||
    restored.length !== c.restoredPayables.length ||
    new Set(c.restoredPayables.map((r) => r.correction.correctionId)).size !==
      restored.length ||
    BigInt(c.originalBillCents) +
      c.restoredPayables.reduce((n, r) => n + BigInt(r.amountCents), 0n) !==
      BigInt(gross)
  )
    throw new QboError("payment_allocation_sum_mismatch");
  const linked = [];
  if (c.originalBillCents)
    linked.push({
      Amount: money(c.originalBillCents),
      LinkedTxn: [{ TxnId: bill.externalId, TxnType: "Bill" }],
    });
  for (const item of c.restoredPayables) {
    const op = restored.find(
      (o) => o.links.correctionId === item.correction.correctionId,
    );
    if (
      !op ||
      item.amountCents > item.correction.amountCents ||
      item.correction.billId !== c.billId ||
      item.correction.supplierId !== c.supplierId
    )
      throw new QboError("restored_payable_binding_conflict");
    assertRestoredOperation(item.correction, op, m);
    linked.push({
      Amount: money(item.amountCents),
      LinkedTxn: [{ TxnId: op.externalId, TxnType: "JournalEntry" }],
    });
  }
  const creditLines = (base.payload.Line as any[]).filter(
    (l) => l.LinkedTxn?.[0]?.TxnType === "VendorCredit",
  );
  return {
    ...base,
    links: {
      ...base.links,
      correctionId: c.correctionId,
      restoredCorrectionIds: c.restoredPayables.map(
        (r) => r.correction.correctionId,
      ),
    },
    payload: {
      ...base.payload,
      PrivateNote: `${base.payload.PrivateNote}; approved payable allocation ${c.correctionId}`,
      Line: [...linked, ...creditLines],
    },
  };
}
