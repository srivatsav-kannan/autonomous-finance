import { describe, expect, it } from "vitest";
import { apexSupplierId, corpusEntryForCase, historicalBankCandidates, matchApexLedger, sourceOutcomeForEntry, type ApexCorpusEntry } from "./apex-corpus";
import type { SourceDocument } from "../contracts";

const invoice = { invoiceNumber: "EXAMPLE-1", supplierName: "Example Counsel, LLC", invoiceDate: "2024-01-02", dueDate: "2024-02-01", terms: "Net 30", totalCents: 400000, matterReference: "M-1" };
const bill = { docnumber: "EXAMPLE-1", bill_id: "BILL-1", vendor_name: "Example Counsel, LLC", vendorref_value: "V-043", bill_amount: "4000.00", txndate: "2024-01-02", due_date: "2024-02-01", payment_terms: "Net 30", matter_number: "M-1", payment_status: "Paid", amount_paid: "4000.00", outstanding_balance: "0", payment_date: "2024-02-01" };
const vendors = [{ "Vendor ID": "V-043", "Vendor Name": "Example Counsel, LLC" }];
const bank = { transaction_id: "T-1", type: "ap_payment", payor_payee: "Example Counsel, LLC", amount_out: "4000", txn_date: "2024-02-01" };
const hash = "a".repeat(64);
const source = { sourceId: "s1", revision: 1, sha256: hash, kind: "invoice" as const };
const entry: ApexCorpusEntry = { file: "Example.pdf", sha256: hash, ledgerSha256: "b".repeat(64), parsed: true, parseReason: null, invoiceNumber: "EXAMPLE-1", supplierName: invoice.supplierName, totalCents: 400000, supplierId: "apex-v043", vendorId: "V-043", billId: "BILL-1", ledgerStatus: "Paid", classification: "historical_paid", arithmeticExact: true, ledgerChecks: [], reconciliation: { status: "matched", bankCandidates: ["T-1"], checks: [], statement: "2024-02.pdf", reference: "CHK-1" } };

describe("full APEX corpus identity and historical status", () => {
  it("requires a unique parsed invoice identity and independent vendor record", () => {
    expect(matchApexLedger(invoice, [bill], vendors).classification).toBe("historical_paid");
    expect(matchApexLedger(invoice, [bill, { ...bill, bill_id: "OTHER" }], vendors).classification).toBe("unresolved");
    expect(matchApexLedger({ ...invoice, supplierName: "Other Supplier" }, [bill], vendors).classification).toBe("unresolved");
    expect(matchApexLedger(invoice, [bill], [...vendors, vendors[0]!]).classification).toBe("unresolved");
    expect(apexSupplierId("V-043")).toBe("apex-v043");
  });
  it("never classifies mismatched money, dates or partially paid amounts as source-paid", () => {
    expect(matchApexLedger({ ...invoice, totalCents: 399300 }, [bill], vendors).classification).toBe("unresolved");
    expect(matchApexLedger({ ...invoice, invoiceDate: "2024-01-03" }, [bill], vendors).classification).toBe("unresolved");
    expect(matchApexLedger(invoice, [{ ...bill, amount_paid: "2000", outstanding_balance: "2000" }], vendors).classification).toBe("unresolved");
    expect(matchApexLedger(invoice, [{ ...bill, payment_status: "Open", amount_paid: "0", outstanding_balance: "4000" }], vendors).classification).toBe("open");
  });
  it("distinguishes equal recurring payments by payee, amount, date and transaction type", () => {
    const rows = [bank, { ...bank, transaction_id: "OTHER_MONTH", txn_date: "2024-03-01" }, { ...bank, transaction_id: "OTHER_VENDOR", payor_payee: "Different Counsel" }, { ...bank, transaction_id: "OTHER_AMOUNT", amount_out: "3993" }, { ...bank, transaction_id: "NOT_AP", type: "transfer" }];
    expect(historicalBankCandidates(bill, rows).map(r => r.transaction_id)).toEqual(["T-1"]);
    expect(historicalBankCandidates(bill, [...rows, { ...bank, transaction_id: "T-2" }])).toHaveLength(2);
  });
  it("binds corpus rows to current invoice bytes, including renamed originals", () => {
    const detail = { sources: [{ ...source, name: "renamed.pdf" }] as SourceDocument[], currentSourceBindings: [source] };
    expect(corpusEntryForCase(detail, { entries: [entry] })).toBe(entry);
    expect(corpusEntryForCase({ ...detail, currentSourceBindings: [{ ...source, revision: 2 }] }, { entries: [entry] })).toBeUndefined();
    expect(corpusEntryForCase({ ...detail, sources: [{ ...source, kind: "contract" }] as SourceDocument[] }, { entries: [entry] })).toBeUndefined();
  });
  it("attaches historical outcome only to its exact original and keeps accounting status separate", () => {
    const outcome = sourceOutcomeForEntry(entry, [source]);
    expect(outcome).toMatchObject({ status: "historical_paid", amountCents: 400000, currency: "USD", sourceReference: "BILL-1", evidence: [{ sourceId: "s1", revision: 1, sha256: hash }] });
    expect(outcome?.reason).toContain(entry.ledgerSha256);
    expect(sourceOutcomeForEntry(entry, [{ ...source, sha256: "c".repeat(64) }])).toBeUndefined();
    expect(sourceOutcomeForEntry({ ...entry, classification: "open" }, [source])).toBeUndefined();
    expect(sourceOutcomeForEntry(entry, [source, source])).toBeUndefined();
  });
});
