import { z } from "zod";
import { CHART, isDebitNormal } from "../core/accounts";
import type { WorldTruth } from "../world/generate";

export interface BookMetric { metric: string; expected: number; actual: number; diff: number }
export interface BooksStatus { status: "passed" | "failed" | "incomplete"; reasons: string[] }
interface Bill {
  _id: string; documentEventId?: string; vendor: string; invoiceNumber: string;
  totalCents: number; status: string; entryId?: string; paymentIntentId?: string;
  exceptions: string[];
}
interface Intent { _id: string; status: string; amountCents: number; payee: string; bankRef?: string; billIds: string[] }
interface Document { _id: string; externalId: string; payload?: unknown }

const cents = z.number().int().safe();
const accountingSchema = z.object({
  version: z.literal(1), start: z.iso.date(), end: z.iso.date(),
  netByAccount: z.record(z.string(), cents),
  obligations: z.array(z.object({
    documentExternalId: z.string(), vendor: z.string(), invoiceNumber: z.string(),
    amountCents: cents.nonnegative(), expenseAccount: z.string(),
  })),
  duplicateDocuments: z.array(z.object({ documentExternalId: z.string(), originalDocumentExternalId: z.string() })),
});
const receiptsSchema = z.array(z.object({
  intentId: z.string().min(1), bankRef: z.string().min(1), payee: z.string().min(1),
  amountCents: cents.positive(), sentOn: z.iso.date(),
}));
const normalizedInvoice = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(INVOICE|INV|NO)/, "").replace(/^0+/, "");
const isBooked = (b: Bill) => b.status === "approved" || b.status === "paid";

/** Independent oracle: private generated obligations plus external simulator receipts.
 * The company's ledger, payment status and recommendations never define expected costs.
 * Net changes are used because generated scenarios begin with no opening balances.
 */
export function evaluateBooks(input: {
  truth: WorldTruth; bills: Bill[]; intents: Intent[]; documents: Document[];
  trialBalance: { code: string; net: number }[]; blockedDocuments: ReadonlySet<string>;
  outgoingPayments: unknown; bankReadError?: string;
}): { books: BookMetric[]; booksStatus: BooksStatus; unresolvedDocuments: string[] } {
  const books: BookMetric[] = [];
  const failures: string[] = [];
  const incomplete: string[] = [];
  const unresolved = new Set<string>();
  const metric = (name: string, expected: number, actual: number) => {
    books.push({ metric: name, expected, actual, diff: actual - expected });
    if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(actual)) failures.push(`${name}: unsafe or invalid cents`);
    else if (expected !== actual) failures.push(`${name}: differs by ${actual - expected} cents`);
  };
  const parsed = accountingSchema.safeParse(input.truth.accounting);
  if (!parsed.success) {
    return { books, booksStatus: { status: "incomplete", reasons: ["Independent accounting truth is missing or invalid; regenerate the scenario to verify all accounts."] }, unresolvedDocuments: [] };
  }
  const oracle = parsed.data;
  const expectedNet = { ...oracle.netByAccount };
  const documentByExternalId = new Map(input.documents.map((d) => [d.externalId, d]));
  const obligations = new Map(oracle.obligations.map((o) => [o.documentExternalId, o]));
  const duplicateIds = new Set(oracle.duplicateDocuments.map((d) => d.documentExternalId));
  const billsByDocument = new Map<string, Bill[]>();
  for (const b of input.bills) {
    const key = b.documentEventId ?? "";
    billsByDocument.set(key, [...(billsByDocument.get(key) ?? []), b]);
  }
  const rowsFor = (externalId: string) => {
    const doc = documentByExternalId.get(externalId);
    return doc ? billsByDocument.get(doc._id) ?? [] : [];
  };
  if (obligations.size !== oracle.obligations.length || duplicateIds.size !== oracle.duplicateDocuments.length) {
    incomplete.push("Independent accounting truth contains duplicate document identities.");
  }
  const obligationTotal = oracle.obligations.reduce((sum, o) => sum + o.amountCents, 0);
  if (Object.values(expectedNet).reduce((sum, n) => sum + n, 0) !== 0 || -(expectedNet["2000"] ?? 0) !== obligationTotal) {
    incomplete.push("Independent accounting truth does not balance or reconcile to its obligations.");
  }
  for (const o of oracle.obligations) {
    const rows = rowsFor(o.documentExternalId);
    const booked = rows.filter(isBooked);
    const actual = booked.reduce((sum, b) => sum + b.totalCents, 0);
    if (actual !== o.amountCents) metric(`Obligation ${o.vendor}/${o.invoiceNumber}`, o.amountCents, actual);
    if (booked.length !== 1 || !booked[0]?.entryId) unresolved.add(o.documentExternalId);
    if (booked.length > 1) failures.push(`${o.documentExternalId}: multiple booked bills for one obligation`);
    if (booked.some((b) => b.vendor !== o.vendor || normalizedInvoice(b.invoiceNumber) !== normalizedInvoice(o.invoiceNumber))) {
      failures.push(`${o.documentExternalId}: booked bill identity does not match independent obligation`);
    }
  }
  for (const duplicate of oracle.duplicateDocuments) {
    const doc = documentByExternalId.get(duplicate.documentExternalId);
    const rows = rowsFor(duplicate.documentExternalId);
    const actual = rows.filter(isBooked).reduce((sum, b) => sum + b.totalCents, 0);
    if (actual !== 0) metric(`Duplicate obligation ${duplicate.documentExternalId}`, 0, actual);
    const rejection = rows.some((b) => b.status === "rejected" && b.exceptions.some((e) => /^duplicate_(invoice|delivery):/.test(e))) || Boolean(doc && input.blockedDocuments.has(doc._id));
    if (!rejection || unresolved.has(duplicate.originalDocumentExternalId) || !obligations.has(duplicate.originalDocumentExternalId)) unresolved.add(duplicate.documentExternalId);
  }
  for (const doc of input.documents) {
    const kind = (doc.payload as { kind?: string } | undefined)?.kind;
    if ((kind === "invoice" || kind === "lease_invoice") && !obligations.has(doc.externalId) && !duplicateIds.has(doc.externalId)) {
      unresolved.add(doc.externalId);
      incomplete.push(`${doc.externalId}: received invoice has no independent expected disposition`);
    }
  }

  const receipts = receiptsSchema.safeParse(input.outgoingPayments);
  if (input.bankReadError || !receipts.success) {
    incomplete.push("Simulator bank receipts are unreadable or invalid; cash and settlement checks are incomplete.");
  } else {
    const intentIds = new Set<string>();
    const bankRefs = new Set<string>();
    const billsById = new Map(input.bills.map((b) => [b._id, b]));
    let totalSent = 0;
    for (const receipt of receipts.data) {
      if (intentIds.has(receipt.intentId) || bankRefs.has(receipt.bankRef)) failures.push("Simulator bank receipts contain a duplicate transfer identity.");
      intentIds.add(receipt.intentId); bankRefs.add(receipt.bankRef);
      if (receipt.sentOn < oracle.start || receipt.sentOn > oracle.end) {
        incomplete.push(`Bank transfer ${receipt.bankRef} falls outside the scored scenario window.`);
        continue;
      }
      totalSent += receipt.amountCents;
      const intent = input.intents.find((p) => p._id === receipt.intentId);
      if (!intent || intent.amountCents !== receipt.amountCents || intent.payee !== receipt.payee || intent.bankRef !== receipt.bankRef || intent.status !== "settled") {
        failures.push(`Bank transfer ${receipt.bankRef} has no matching settled payment with the same identity, payee and amount.`);
        continue;
      }
      const paidBills = intent.billIds.map((id) => billsById.get(id));
      if (new Set(intent.billIds).size !== intent.billIds.length || paidBills.some((b) => !b || b.status !== "paid" || b.vendor !== receipt.payee || b.paymentIntentId !== intent._id) || paidBills.reduce((sum, b) => sum + (b?.totalCents ?? 0), 0) !== receipt.amountCents) {
        failures.push(`Bank transfer ${receipt.bankRef} does not match its paid bill allocations.`);
      }
    }
    const settled = input.intents.filter((i) => i.status === "settled");
    for (const intent of settled) if (!intentIds.has(intent._id)) failures.push(`Settled payment ${intent._id} has no simulator bank receipt.`);
    metric("Bank-confirmed payments vs settled payment subledger", totalSent, settled.reduce((sum, i) => sum + i.amountCents, 0));
    expectedNet["1000"] = (expectedNet["1000"] ?? 0) - totalSent;
    expectedNet["2000"] = (expectedNet["2000"] ?? 0) + totalSent;
  }

  const actualNet = new Map(input.trialBalance.map((a) => [a.code, a.net]));
  const accounts = new Map(CHART.map((a) => [a.code, a]));
  const allCodes = new Set([...accounts.keys(), ...Object.keys(expectedNet), ...actualNet.keys()]);
  for (const code of [...allCodes].sort()) {
    // Without a receipt source, report only independently known accrual accounts.
    if ((!receipts.success || input.bankReadError) && (code === "1000" || code === "2000")) continue;
    const sign = accounts.has(code) && !isDebitNormal(code) ? -1 : 1;
    metric(`${code} ${accounts.get(code)?.name ?? "Unrecognized account"} (net change)`, sign * (expectedNet[code] ?? 0), sign * (actualNet.get(code) ?? 0));
  }
  const bookedBills = input.bills.filter(isBooked);
  metric("Accrued bill subledger vs independent obligations", obligationTotal, bookedBills.reduce((sum, b) => sum + b.totalCents, 0));
  metric("AP ledger vs unpaid approved bill subledger", input.bills.filter((b) => b.status === "approved").reduce((sum, b) => sum + b.totalCents, 0), -(actualNet.get("2000") ?? 0));
  if (unresolved.size) incomplete.push(`${unresolved.size} invoice document(s) lack a complete, supported disposition: ${[...unresolved].slice(0, 10).join(", ")}${unresolved.size > 10 ? ", …" : ""}`);
  return {
    books,
    booksStatus: { status: failures.length ? "failed" : incomplete.length ? "incomplete" : "passed", reasons: [...failures, ...incomplete] },
    unresolvedDocuments: [...unresolved],
  };
}
