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
  AppliedCredit,
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
  if (e.holds?.length) throw new QboError(e.holds[0]!.code);
  if (
    [
      request.paymentVersionId,
      request.creditApplicationId,
      request.correctionId,
    ].filter(Boolean).length > 1
  )
    throw new QboError("ambiguous_application_request");
  if (
    request.creditApplicationId &&
    !e.creditApplication?.applicationIds.includes(request.creditApplicationId)
  )
    throw new QboError("verified_credit_application_required");
  if (
    request.correctionId &&
    e.correction?.correctionId !== request.correctionId
  )
    throw new QboError("approved_correction_required");
  if (e.correction?.kind === "bank_return") {
    if (
      !request.correctionId ||
      e.version !== "ap-qbo-export-v1" ||
      !e.authorizedSubject ||
      d.caseId !== request.caseId ||
      e.correction.caseId !== d.caseId
    )
      throw new QboError("approved_return_correction_required");
    return d;
  }
  if (e.recognizedCredit) {
    const r = e.recognizedCredit;
    if (
      e.version !== "ap-qbo-export-v1" ||
      !e.authorizedSubject ||
      d.caseId !== request.caseId ||
      r.caseId !== d.caseId ||
      d.states.business !== "approved" ||
      d.states.document !== "reviewed" ||
      d.states.accounting !== "recognized" ||
      r.journalId !== d.links.recognitionJournalId ||
      d.amounts.acceptedCents !== r.amountCents ||
      !r.approvalId ||
      !r.creditId ||
      !r.billId ||
      !Number.isSafeInteger(r.amountCents) ||
      !Number.isSafeInteger(r.sourceRevision) ||
      r.sourceRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(r.sourceSnapshotHash) ||
      r.amountCents <= 0 ||
      !r.allocations.length ||
      request.paymentVersionId ||
      request.creditApplicationId
    )
      throw new QboError("approved_credit_required");
    const expected = [
      ...r.allocations.map((a) => ({
        account: a.account,
        debit: Math.max(0, -a.amountCents),
        credit: Math.max(0, a.amountCents),
      })),
      { account: "2000", debit: r.amountCents, credit: 0 },
    ];
    const j = d.journals.find(
      (j) => j.entryId === r.journalId && j.kind === "credit",
    );
    if (!j || canonical(j.lines) !== canonical(expected))
      throw new QboError("credit_journal_mismatch");
    return d;
  }
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
      !Number.isSafeInteger(recognized.amountCents) ||
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
  creditOperations: Operation[] = [],
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
  const applied = s.credits ?? [];
  const creditLines = appliedCreditLines(applied, creditOperations, m, bill);
  const gross = s.grossAppliedCents ?? s.amountCents;
  if (
    !Number.isSafeInteger(gross) ||
    gross !== s.amountCents + sumCents(applied.map((c) => c.amountCents)) ||
    gross <= 0 ||
    s.amountCents <= 0 ||
    gross > Math.round(Number(b.payload.TotalAmt) * 100)
  )
    throw new QboError("payment_application_sum_mismatch");
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
      ...(applied.length
        ? { appliedCreditIds: applied.map((c) => c.recognition.creditId) }
        : {}),
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
          Amount: money(gross),
          LinkedTxn: [{ TxnId: bill.externalId, TxnType: "Bill" }],
        },
        ...creditLines,
      ],
    },
  };
}
/** B3 hook: caller must load approved credit evidence from an authenticated authoritative source.
 * VendorCredit recognition is separate from explicitly approved application. */
export function creditPlan(
  credit: CreditExport,
  m: Mappings,
  bill: Operation,
): Plan {
  validateMappings(m, m.realmId);
  if (
    credit.allocations.some(
      (a) => !Number.isSafeInteger(a.amountCents) || a.account === m.apAccount,
    )
  )
    throw new QboError("invalid_cost_allocation");
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

/** Bill and VendorCredit line amounts are positive applied amounts; their difference is cash. */
function appliedCreditLines(
  items: AppliedCredit[],
  operations: Operation[],
  m: Mappings,
  bill: Operation,
) {
  if (
    new Set(items.map((i) => i.recognition.creditId)).size !== items.length ||
    operations.length !== items.length
  )
    throw new QboError("credit_operation_mismatch");
  return items.map((item) => {
    const r = item.recognition;
    const op = operations.find((o) => o.links.creditId === r.creditId);
    if (
      !Number.isSafeInteger(item.amountCents) ||
      item.amountCents <= 0 ||
      item.amountCents > r.amountCents ||
      !op ||
      op.state !== "succeeded" ||
      op.entity !== "VendorCredit" ||
      op.realmId !== m.realmId ||
      op.mappingHash !== hash(m) ||
      op.links.caseId !== r.caseId ||
      op.links.recognitionJournalId !== r.journalId ||
      op.payload.TotalAmt !== money(r.amountCents) ||
      canonical(op.payload.VendorRef) !== canonical(bill.payload.VendorRef) ||
      !op.externalId
    )
      throw new QboError("credit_operation_mismatch");
    return {
      Amount: money(item.amountCents),
      LinkedTxn: [{ TxnId: op.externalId, TxnType: "VendorCredit" }],
    };
  });
}
export function applicationPlan(
  e: AccountingExport,
  m: Mappings,
  bill: Operation,
  credits: Operation[],
): Plan {
  const a = e.creditApplication;
  if (!a) throw new QboError("verified_credit_application_required");
  const d = assertExport(e, {
    caseId: e.detail.caseId,
    creditApplicationId: a.applicationId,
  });
  const b = billPlan(e, m);
  if (
    bill.state !== "succeeded" ||
    bill.entity !== "Bill" ||
    bill.identity !== b.identity ||
    bill.realmId !== m.realmId ||
    bill.mappingHash !== hash(m) ||
    !bill.externalId ||
    canonical(bill.payload) !== canonical(b.payload) ||
    a.billId !== bill.links.billId ||
    !Number.isSafeInteger(a.amountCents) ||
    a.amountCents <= 0 ||
    a.amountCents > Math.round(Number(b.payload.TotalAmt) * 100) ||
    a.amountCents !== sumCents(a.credits.map((c) => c.amountCents))
  )
    throw new QboError("credit_application_mismatch");
  const lines = appliedCreditLines(a.credits, credits, m, bill);
  const identity = `CreditApplication:${d.scope.organizationId}:${d.scope.runId}:${a.billId}:${a.requestKey}`;
  return {
    ...b,
    entity: "BillPayment",
    identity,
    links: {
      ...b.links,
      creditApplicationId: a.applicationId,
      appliedCreditIds: a.credits.map((c) => c.recognition.creditId),
    },
    payload: {
      VendorRef: b.payload.VendorRef,
      APAccountRef: b.payload.APAccountRef,
      CurrencyRef: { value: "USD" },
      TxnDate: a.date,
      DocNumber: `AP${hash(identity).slice(0, 18)}`,
      PrivateNote: `ap-sync:${hash(identity)}; explicit credit-only application ${a.applicationId}`,
      PayType: "Check",
      CheckPayment: {
        BankAccountRef: { value: m.accounts[m.bankAccount]!.id },
        PrintStatus: "NotSet",
      },
      TotalAmt: 0,
      Line: [
        {
          Amount: money(a.amountCents),
          LinkedTxn: [{ TxnId: bill.externalId, TxnType: "Bill" }],
        },
        ...lines,
      ],
    },
  };
}
