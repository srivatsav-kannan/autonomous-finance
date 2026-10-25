/** Inventory and reconciliation for every available World 9 contract-attorney original.
 * Ledger outcomes are compared after PDF parsing; they never supply parsed fields. */
import type { APCaseDetail, SourceDocument, SourceOutcome } from "../contracts";
import { mapContractAttorneyInvoice, type MappedInvoice } from "./apex-invoice";
import { APEX_FILES, APEX_SOURCE, cents, historicalPaymentChecks, type ApexWorld } from "./apex-sources";
import { readTextLayer } from "./text-layer";

type Row = Record<string, string>;
const normalized = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
export const apexSupplierId = (vendorId: string) => `apex-${vendorId.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

export type ApexCorpusEntry = {
  file: string; sha256: string; ledgerSha256: string; parsed: boolean; parseReason: string | null;
  invoiceNumber: string | null; supplierName: string | null; totalCents: number | null;
  supplierId: string | null; vendorId: string | null; billId: string | null; ledgerStatus: string | null;
  classification: "open" | "historical_paid" | "unresolved";
  ledgerChecks: { check: string; passed: boolean }[]; arithmeticExact: boolean | null;
  reconciliation: { status: "matched" | "unmatched" | "ambiguous" | "not_paid"; bankCandidates: string[]; checks: { check: string; passed: boolean }[]; statement: string | null; reference: string | null };
};
export type ApexCorpus = {
  dataset: typeof APEX_SOURCE; label: string; totalInvoices: number; parsedInvoices: number;
  sourcePaidInvoices: number; openInvoices: number; unresolvedInvoices: number; supplierCount: number;
  reconciledHistoricalInvoices: number; arithmeticExceptionInvoices: number; sourceHashes: Record<string, string>; entries: ApexCorpusEntry[];
};

/** Reject duplicate invoice numbers and mismatched vendor/amount/date before using a ledger outcome. */
export function matchApexLedger(invoice: Pick<MappedInvoice, "invoiceNumber" | "supplierName" | "invoiceDate" | "dueDate" | "terms" | "totalCents" | "matterReference">, ledger: Row[], vendors: Row[]) {
  const rows = ledger.filter(r => r.docnumber === invoice.invoiceNumber);
  const bill = rows.length === 1 ? rows[0] : undefined;
  const matchingVendors = bill ? vendors.filter(v => v["Vendor ID"] === bill.vendorref_value) : [];
  const vendor = matchingVendors.length === 1 ? matchingVendors[0] : undefined;
  const checks = [
    { check: "One AP ledger row matches the parsed invoice number", passed: rows.length === 1 },
    { check: "Parsed supplier matches the ledger and one vendor master record", passed: !!bill && !!vendor && normalized(invoice.supplierName) === normalized(bill.vendor_name ?? "") && normalized(invoice.supplierName) === normalized(vendor["Vendor Name"] ?? "") },
    { check: "Parsed amount equals the ledger bill amount", passed: !!bill && cents(bill.bill_amount) === invoice.totalCents },
    { check: "Parsed invoice date equals the ledger date", passed: !!bill && bill.txndate === invoice.invoiceDate },
    { check: "Parsed due date and terms equal the ledger", passed: !!bill && bill.due_date === invoice.dueDate && bill.payment_terms === invoice.terms },
    { check: "Parsed matter equals the ledger matter", passed: !!bill && bill.matter_number === invoice.matterReference },
  ];
  const matched = checks.every(c => c.passed);
  const classification: ApexCorpusEntry["classification"] = !matched || !bill ? "unresolved" : bill.payment_status === "Paid" && cents(bill.outstanding_balance) === 0 && cents(bill.amount_paid) === invoice.totalCents ? "historical_paid" : bill.payment_status === "Open" && cents(bill.amount_paid) === 0 && cents(bill.outstanding_balance) === invoice.totalCents ? "open" : "unresolved";
  return { bill: matched ? bill! : null, vendor: matched ? vendor! : null, classification, checks };
}

/** Same payee and amount alone is insufficient: dates must match, and ambiguity remains visible. */
export function historicalBankCandidates(bill: Row, bank: Row[]) {
  return bank.filter(b => b.type === "ap_payment" && normalized(b.payor_payee ?? "") === normalized(bill.vendor_name ?? "") && b.txn_date === bill.payment_date && cents(b.amount_out) === cents(bill.bill_amount));
}

export async function buildApexCorpus(world: ApexWorld, pdftotextPath = "pdftotext"): Promise<ApexCorpus> {
  const entries: ApexCorpusEntry[] = [];
  const statements = new Map<string, string>();
  for (const file of world.invoiceFiles) {
    const entry: ApexCorpusEntry = { file, sha256: world.hashes[`${APEX_FILES.invoices}/${file}`]!, ledgerSha256: world.hashes[APEX_FILES.apLedger]!, parsed: false, parseReason: null, invoiceNumber: null, supplierName: null, totalCents: null, supplierId: null, vendorId: null, billId: null, ledgerStatus: null, classification: "unresolved", ledgerChecks: [], arithmeticExact: null, reconciliation: { status: "not_paid", bankCandidates: [], checks: [], statement: null, reference: null } };
    entries.push(entry);
    const layer = await readTextLayer(world.invoicePath(file), pdftotextPath);
    const mapped = layer.pages.length === 1 ? mapContractAttorneyInvoice(layer.pages[0]!) : { ok: false as const, reason: "unsupported_page_count" };
    if (!mapped.ok) { entry.parseReason = mapped.reason; continue; }
    const invoice = mapped.invoice, match = matchApexLedger(invoice, world.apLedger, world.vendors);
    Object.assign(entry, { parsed: true, invoiceNumber: invoice.invoiceNumber, supplierName: invoice.supplierName, totalCents: invoice.totalCents, classification: match.classification, ledgerChecks: match.checks });
    entry.arithmeticExact = invoice.lines.every(l => Math.round(Number(l.hours) * l.rateCents) === l.amountCents) && invoice.lines.reduce((total, l) => total + l.amountCents, 0) === invoice.subtotalCents && invoice.subtotalCents === invoice.totalCents;
    if (!match.bill || !match.vendor) continue;
    const bill = match.bill;
    Object.assign(entry, { vendorId: bill.vendorref_value, supplierId: apexSupplierId(bill.vendorref_value!), billId: bill.bill_id, ledgerStatus: bill.payment_status });
    if (entry.classification !== "historical_paid") continue;
    const candidates = historicalBankCandidates(bill, world.bank);
    entry.reconciliation = { status: candidates.length > 1 ? "ambiguous" : "unmatched", bankCandidates: candidates.map(b => b.transaction_id!), checks: [], statement: null, reference: null };
    if (candidates.length !== 1) continue;
    const bank = candidates[0]!, statement = `${bill.payment_date!.slice(0, 7)}_operating_bank_statement.pdf`;
    entry.reconciliation.statement = statement; entry.reconciliation.reference = bank.reference!;
    const statementHash = world.hashes[`${APEX_FILES.statements}/${statement}`];
    if (!statementHash) { entry.reconciliation.checks.push({ check: "Monthly bank statement is available", passed: false }); continue; }
    if (!statements.has(statement)) { const text = await readTextLayer(world.statementPath(statement), pdftotextPath); statements.set(statement, text.pages.flatMap(p => p.words.map(w => w.text)).join(" ")); }
    const reconciled = historicalPaymentChecks(world, { billId: bill.bill_id!, bankTransactionId: bank.transaction_id!, reference: bank.reference!, statementText: statements.get(statement)! });
    entry.reconciliation.checks = reconciled.checks;
    entry.reconciliation.status = reconciled.passed ? "matched" : "unmatched";
  }
  return { dataset: APEX_SOURCE, label: "All available World 9 contract-attorney invoice PDFs", totalInvoices: entries.length, parsedInvoices: entries.filter(e => e.parsed).length, sourcePaidInvoices: entries.filter(e => e.classification === "historical_paid").length, openInvoices: entries.filter(e => e.classification === "open").length, unresolvedInvoices: entries.filter(e => e.classification === "unresolved").length, supplierCount: new Set(entries.flatMap(e => e.supplierId ? [e.supplierId] : [])).size, reconciledHistoricalInvoices: entries.filter(e => e.reconciliation.status === "matched").length, arithmeticExceptionInvoices: entries.filter(e => e.arithmeticExact === false).length, sourceHashes: { ...world.hashes }, entries };
}

/** Server-owned outcome from a byte-matched original and the separately loaded source ledger. */
export function sourceOutcomeForEntry(entry: ApexCorpusEntry, documents: Pick<SourceDocument, "sourceId" | "revision" | "sha256" | "kind">[]): SourceOutcome | undefined {
  if (entry.classification !== "historical_paid" || !entry.billId || entry.totalCents === null) return undefined;
  const invoices = documents.filter(d => d.kind === "invoice" && d.sha256 === entry.sha256);
  if (invoices.length !== 1) return undefined;
  const source = invoices[0]!;
  return { status: "historical_paid", amountCents: entry.totalCents, currency: "USD", sourceReference: entry.billId,
    evidence: [{ sourceId: source.sourceId, revision: source.revision, sha256: source.sha256 }],
    reason: `APEX World 9 source ledger records ${entry.invoiceNumber} as paid with zero outstanding. Ledger SHA-256 ${entry.ledgerSha256}. Historical dataset outcome only; no new settlement or payment authorization. Bank reconciliation: ${entry.reconciliation.status}.` };
}

/** Bind an original by bytes, not its mutable filename or invoice-number string. */
export function corpusEntryForCase(detail: Pick<APCaseDetail, "sources" | "currentSourceBindings">, corpus: Pick<ApexCorpus, "entries">) {
  const hashes = new Set(detail.currentSourceBindings.filter(b => detail.sources.some(s => s.kind === "invoice" && s.sourceId === b.sourceId && s.revision === b.revision && s.sha256 === b.sha256)).map(b => b.sha256));
  const matches = corpus.entries.filter(e => hashes.has(e.sha256));
  return matches.length === 1 ? matches[0] : undefined;
}
