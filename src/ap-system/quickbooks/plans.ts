import { caseDetailSchema } from "../contracts";
import { recognitionLines, sumCents } from "../accounting";
import { hash, QboError, canonical } from "./private-store";
import type {
  AccountingExport,
  ExportRequest,
  Mappings,
  Operation,
  Plan,
  CreditExport,
} from "./types";
export function validateMappings(m: Mappings, realm: string) {
  if (
    m.country !== "US" ||
    m.realmId !== realm ||
    !m.version ||
    !m.accounts[m.apAccount] ||
    m.accounts[m.apAccount]!.type !== "Accounts Payable" ||
    !m.accounts[m.bankAccount] ||
    m.accounts[m.bankAccount]!.type !== "Bank"
  )
    throw new QboError("invalid_account_mappings");
  const ids = Object.values(m.accounts).map((a) => a.id);
  if (
    new Set(ids).size !== ids.length ||
    Object.values(m.vendors).some(
      (v) => !v.displayName || !/^\d{1,32}$/.test(v.id),
    ) ||
    Object.values(m.accounts).some(
      (a) => !a.name || !a.type || !/^\d{1,32}$/.test(a.id),
    )
  )
    throw new QboError("mapping_conflict");
}
const money = (c: number) => {
  if (!Number.isSafeInteger(c) || Math.abs(c) > 999999999999)
    throw new QboError("unsupported_amount");
  return c / 100;
};
function line(account: string, amount: number, m: Mappings) {
  const a = m.accounts[account];
  if (!a) throw new QboError("account_mapping_missing");
  return {
    Amount: money(amount),
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: a.id },
      BillableStatus: "NotBillable",
    },
  };
}
export function assertExport(e: AccountingExport, request: ExportRequest) {
  const d = caseDetailSchema.parse(e.detail),
    c = d.candidate;
  const recognized = e.recognizedInvoice;
  if (recognized) {
    if (
      e.version !== "ap-qbo-export-v1" ||
      !e.authorizedSubject ||
      !e.billRecordHash ||
      d.caseId !== request.caseId ||
      recognized.caseId !== d.caseId ||
      recognized.billId !== d.links.billId ||
      recognized.journalId !== d.links.recognitionJournalId ||
      d.states.business !== "approved" ||
      d.states.document !== "reviewed" ||
      d.states.accounting !== "recognized" ||
      d.amounts.acceptedCents !== recognized.amountCents ||
      !recognized.approvalId ||
      !Number.isSafeInteger(recognized.sourceRevision) ||
      recognized.sourceRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(recognized.sourceSnapshotHash) ||
      recognized.amountCents <= 0 ||
      !recognized.allocations.length
    )
      throw new QboError("approved_recognition_required");
    let total = 0n;
    for (const a of recognized.allocations) {
      if (!Number.isSafeInteger(a.amountCents) || a.account === "2000")
        throw new QboError("recognition_allocation_mismatch");
      total += BigInt(a.amountCents);
    }
    if (total !== BigInt(recognized.amountCents))
      throw new QboError("recognition_allocation_mismatch");
    const expected = [
      ...recognized.allocations.map((a) => ({
        account: a.account,
        debit: Math.max(0, a.amountCents),
        credit: Math.max(0, -a.amountCents),
      })),
      { account: "2000", debit: 0, credit: recognized.amountCents },
    ];
    const journal = d.journals.find(
      (j) => j.entryId === recognized.journalId && j.kind === "recognition",
    );
    if (!journal || canonical(journal.lines) !== canonical(expected))
      throw new QboError("recognition_journal_mismatch");
    if (
      request.paymentVersionId &&
      e.settlement?.paymentVersionId !== request.paymentVersionId
    )
      throw new QboError("verified_settlement_required");
    return d;
  }
  if (
    e.version !== "ap-qbo-export-v1" ||
    !e.authorizedSubject ||
    !e.billRecordHash ||
    d.caseId !== request.caseId ||
    !c ||
    c.kind !== "invoice" ||
    !c.supplierId ||
    d.states.business !== "approved" ||
    d.states.document !== "reviewed" ||
    d.states.accounting !== "recognized" ||
    !d.links.billId ||
    !d.links.recognitionJournalId ||
    d.amounts.acceptedCents !== c.totalCents ||
    d.exceptions.some((x) => x.blocking && x.status === "open")
  )
    throw new QboError("approved_recognition_required");
  const approval = d.decisions.find(
    (x) =>
      x.kind === "bill_approval" &&
      x.outcome === "approved" &&
      x.actorKind === "human" &&
      x.candidateRevision === d.revision &&
      x.snapshotHash === d.snapshotHash,
  );
  const journal = d.journals.find(
    (x) =>
      x.entryId === d.links.recognitionJournalId && x.kind === "recognition",
  );
  const expected = recognitionLines(c).map(({ account, debit, credit }) => ({
    account,
    debit,
    credit,
  }));
  if (!approval || !journal || canonical(journal.lines) !== canonical(expected))
    throw new QboError("recognition_journal_mismatch");
  if (
    request.paymentVersionId &&
    e.settlement?.paymentVersionId !== request.paymentVersionId
  )
    throw new QboError("verified_settlement_required");
  return d;
}
export function billPlan(e: AccountingExport, m: Mappings): Plan {
  const d = assertExport(e, { caseId: e.detail.caseId }),
    c = d.candidate!;
  validateMappings(m, m.realmId);
  if (m.apAccount !== "2000") throw new QboError("local_ap_account_mismatch");
  const r = e.recognizedInvoice;
  const vendor = m.vendors[r?.supplierId ?? c.supplierId!];
  if (!vendor) throw new QboError("vendor_mapping_missing");
  const lines = r
    ? r.allocations.map((a) => ({
        account: a.account,
        debit: Math.max(0, a.amountCents),
        credit: Math.max(0, -a.amountCents),
      }))
    : recognitionLines(c).filter((l) => l.account !== "2000");
  if (r?.allocations.some((a) => a.amountCents < 0))
    throw new QboError("signed_cost_allocation_requires_review");
  const net = lines.reduce(
    (n, l) => n + BigInt(l.debit) - BigInt(l.credit),
    0n,
  );
  if (net !== BigInt(r?.amountCents ?? c.totalCents))
    throw new QboError("bill_amount_mismatch");
  const identity = `Bill:${d.scope.organizationId}:${d.scope.runId}:${d.links.billId}`;
  return {
    version: "ap-qbo-operation-v1",
    realmId: m.realmId,
    minorVersion: 75,
    entity: "Bill",
    identity,
    mappingHash: hash(m),
    links: {
      caseId: d.caseId,
      billId: d.links.billId!,
      recognitionJournalId: d.links.recognitionJournalId!,
      paymentVersionId: null,
      commandId: null,
      bankTransactionId: null,
      settlementJournalId: null,
      creditId: null,
    },
    payload: {
      VendorRef: { value: vendor.id },
      APAccountRef: { value: m.accounts[m.apAccount]!.id },
      CurrencyRef: { value: "USD" },
      TxnDate: r?.date ?? c.invoiceDate,
      ...(!r && c.dueDate ? { DueDate: c.dueDate } : {}),
      DocNumber: `AP${hash(identity).slice(0, 18)}`,
      PrivateNote: `ap-sync:${hash(identity)}; invoice ${r?.reference ?? c.invoiceNumber}; recognition ${d.links.recognitionJournalId}`,
      Line: lines.map((l) => line(l.account, l.debit - l.credit, m)),
      TotalAmt: money(r?.amountCents ?? c.totalCents),
    },
  };
}
export function paymentPlan(
  e: AccountingExport,
  m: Mappings,
  bill: Operation,
): Plan {
  const s = e.settlement;
  if (!s) throw new QboError("verified_settlement_required");
  const d = assertExport(e, {
    caseId: e.detail.caseId,
    paymentVersionId: s.paymentVersionId,
  });
  const b = billPlan(e, m);
  if (
    d.scope.provider !== "increase" ||
    d.scope.environment !== "sandbox" ||
    d.states.execution !== "settled" ||
    d.states.reconciliation !== "matched" ||
    bill.state !== "succeeded" ||
    bill.entity !== "Bill" ||
    bill.identity !== b.identity ||
    bill.realmId !== m.realmId ||
    bill.mappingHash !== hash(m) ||
    !bill.externalId ||
    canonical(bill.payload) !== canonical(b.payload)
  )
    throw new QboError("settlement_or_bill_conflict");
  const p = d.payments.find((p) => p.versionId === s.paymentVersionId);
  const journal = d.journals.find(
    (j) => j.entryId === s.journalId && j.kind === "settlement",
  );
  if (
    !p ||
    p.status !== "settled" ||
    p.amountCents !== s.amountCents ||
    p.commandId !== s.commandId ||
    p.providerTransferId !== s.providerTransferId ||
    !s.requestHash ||
    !journal ||
    journal.bankTransactionId !== s.bankTransactionId ||
    !d.links.bankTransactionIds.includes(s.bankTransactionId) ||
    !d.links.settlementJournalIds.includes(s.journalId) ||
    journal.lines.length !== 2 ||
    journal.lines.find((l) => l.account === m.apAccount)?.debit !==
      s.amountCents ||
    journal.lines.find((l) => l.account === m.bankAccount)?.credit !==
      s.amountCents
  )
    throw new QboError("settlement_link_mismatch");
  const identity = `BillPayment:${d.scope.organizationId}:${d.scope.runId}:${s.paymentVersionId}:${s.bankTransactionId}`;
  return {
    ...b,
    entity: "BillPayment",
    identity,
    links: {
      ...b.links,
      paymentVersionId: s.paymentVersionId,
      commandId: s.commandId,
      bankTransactionId: s.bankTransactionId,
      settlementJournalId: s.journalId,
    },
    payload: {
      VendorRef: b.payload.VendorRef,
      APAccountRef: b.payload.APAccountRef,
      CurrencyRef: { value: "USD" },
      TxnDate: s.date,
      DocNumber: `AP${hash(identity).slice(0, 18)}`,
      PrivateNote: `ap-sync:${hash(identity)}; Increase settlement ${s.bankTransactionId}`,
      PayType: "Check",
      CheckPayment: {
        BankAccountRef: { value: m.accounts[m.bankAccount]!.id },
        PrintStatus: "NotSet",
      },
      TotalAmt: money(s.amountCents),
      Line: [
        {
          Amount: money(s.amountCents),
          LinkedTxn: [{ TxnId: bill.externalId, TxnType: "Bill" }],
        },
      ],
    },
  };
}
/** B3 hook: caller must load approved credit evidence from an authenticated authoritative source.
 * Creates VendorCredit recognition only; applying credits/refunds is a separate future operation. */
export function creditPlan(
  credit: CreditExport,
  m: Mappings,
  bill: Operation,
): Plan {
  validateMappings(m, m.realmId);
  if (
    bill.state !== "succeeded" ||
    bill.entity !== "Bill" ||
    bill.realmId !== m.realmId ||
    bill.mappingHash !== hash(m) ||
    bill.links.billId !== credit.billId ||
    !bill.externalId ||
    !credit.journalId ||
    !credit.creditId ||
    credit.amountCents <= 0 ||
    sumCents(credit.allocations.map((a) => a.amountCents)) !==
      credit.amountCents
  )
    throw new QboError("approved_credit_required");
  const vendor = m.vendors[credit.supplierId];
  if (
    !vendor ||
    canonical(bill.payload.VendorRef) !== canonical({ value: vendor.id })
  )
    throw new QboError("credit_vendor_mismatch");
  const identity = `VendorCredit:${credit.creditId}:${credit.journalId}`;
  return {
    version: "ap-qbo-operation-v1",
    realmId: m.realmId,
    minorVersion: 75,
    identity,
    entity: "VendorCredit",
    mappingHash: hash(m),
    links: {
      ...bill.links,
      caseId: credit.caseId,
      creditId: credit.creditId,
      recognitionJournalId: credit.journalId,
    },
    payload: {
      VendorRef: { value: vendor.id },
      APAccountRef: { value: m.accounts[m.apAccount]!.id },
      CurrencyRef: { value: "USD" },
      TxnDate: credit.date,
      DocNumber: `AP${hash(identity).slice(0, 18)}`,
      PrivateNote: `ap-sync:${hash(identity)}; credit ${credit.reference}; original bill ${bill.externalId}`,
      TotalAmt: money(credit.amountCents),
      Line: credit.allocations.map((a) => line(a.account, a.amountCents, m)),
    },
  };
}
