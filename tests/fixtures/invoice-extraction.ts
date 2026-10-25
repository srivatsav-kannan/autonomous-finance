import type { Conclusion, SourceInput } from "../../src/invoice-mvp/contracts";
import type { CustomerIdentity } from "../../src/invoice-mvp/text-extraction";

/** Public development regressions. Authored with the extractor; NOT an unseen accuracy set. */
export const extractionCustomers: CustomerIdentity[] = [
  { customerId: "alpha", legalName: "Alpha Workshops LLC", aliases: ["Alpha Studio"] },
  { customerId: "beta", legalName: "Beta Research", aliases: [] },
];
const header = "INVOICE\nCustomer ID: alpha\nCustomer: Alpha Workshops LLC\nDocument Number: AW-701\nCurrency: USD";
const invoice = `${header}\nTotal: USD 1,045.25`;
const expected: Partial<Conclusion> = { treatment: "include_invoice", customerId: "alpha", documentNumber: "AW-701", amountCents: 104525 };
export type ExtractionFixture = { id: string; source: SourceInput; expected: Partial<Conclusion>; warning?: string; customers?: CustomerIdentity[] };
const fixture = (id: string, text: string, wanted: Partial<Conclusion>, options: { mimeType?: string; warning?: string; customers?: CustomerIdentity[] } = {}): ExtractionFixture => ({
  id, source: { externalId: id, name: `${id}.txt`, mimeType: options.mimeType ?? "text/plain", text }, expected: wanted, ...options,
});
const missing = { treatment: "needs_evidence" } as const;
export const extractionFixtures: ExtractionFixture[] = [
  fixture("routine", invoice, expected),
  fixture("pdf-packet", "=== Page 1 of 2 ===\nSupplier Services\nBilling department\nReference packet\nINVOICE AW-701\nCustomer\nAlpha Workshops LLC\nCustomer ID\nalpha\nInvoice Date\n2026-10-01\nStatus\nPARTIAL\nCurrency\nUSD\nSubtotal\n1000.00\nDiscount\n0.00\nTax\n45.25\nTotal\n$1,045.25\nAmount due\n$45.25\n=== Page 2 of 2 ===\nService logs\nHours 12\nReference AW-701", expected, { mimeType: "application/pdf" }),
  fixture("letterhead", "Example Vendor\nAccounts receivable\n200 Example Street\nSuite 8\nService department\nReference copy\nTax Invoice AW-701\nBill To: Alpha Studio\nCurrency: USD\nGrand Total: 1045.25", expected),
  fixture("column-spaces", "INVOICE AW-701\nCustomer ID    alpha\nCustomer    Alpha Workshops LLC\nCurrency    USD\nInvoice Total    1,045.25", expected),
  fixture("alias-match", "INVOICE AW-701\nBill To: Alpha Studio\nCurrency: USD\nGrand Total: $1045.25", expected),
  fixture("registered-id-only", "INVOICE AW-701\nCustomer ID: alpha\nCurrency: USD\nTotal: 1045.25", expected),
  fixture("paid-total", `${invoice}\nStatus: PAID\nAmount Paid: USD 1045.25\nBalance Due: USD 0.00`, expected),
  fixture("credit-minus", invoice.replace("INVOICE", "CREDIT NOTE").replace("USD 1,045.25", "-USD 1,045.25"), { ...expected, treatment: "include_credit" }),
  fixture("credit-parentheses", invoice.replace("INVOICE", "CREDIT MEMO").replace("USD 1,045.25", "(USD 1,045.25)"), { ...expected, treatment: "include_credit" }),
  fixture("credit-dollar-minus", invoice.replace("INVOICE", "CREDIT MEMO").replace("USD 1,045.25", "$-1,045.25"), { ...expected, treatment: "include_credit" }),
  fixture("currency-suffix", invoice.replace("USD 1,045.25", "1,045.25 USD"), expected),
  fixture("crlf-and-nbsp", invoice.replaceAll("\n", "\r\n").replace("USD 1,045.25", "USD\u00a01,045.25"), expected),
  fixture("safe-integer-boundary", invoice.replace("1,045.25", "90,071,992,547,409.91"), { ...expected, amountCents: Number.MAX_SAFE_INTEGER }),
  fixture("repeated-page-title", `${invoice}\n=== Page 2 of 2 ===\nINVOICE AW-701\nDelivery notes`, expected, { warning: "Repeated documentNumber" }),
  fixture("dollar-currency-review", invoice.replace("Currency: USD\n", "").replace("USD 1,045.25", "$1,045.25"), expected, { warning: "Confirm USD" }),
  fixture("arithmetic-review", `${invoice}\nSubtotal: USD 1000.00\nDiscount: USD 0.00\nTax: USD 40.00`, expected, { warning: "does not equal" }),
  fixture("revision-review", `${invoice}\nNotes: Replaces AW-700`, expected, { warning: "revision or conflict" }),
  fixture("void", "INVOICE AW-701\nStatus\nVOID", { treatment: "exclude", documentNumber: "AW-701" }),
  fixture("draft", "DRAFT INVOICE AW-701\nTotal: USD 1045.25", { treatment: "exclude" }),
  fixture("statement", "Vendor\nCustomer statement ST-1\nInvoice AW-701\nTotal: USD 1045.25", { treatment: "exclude" }),
  fixture("email-attachment-request", invoice, { treatment: "exclude" }, { mimeType: "message/rfc822" }),
  fixture("conflicting-totals", `${invoice}\nGrand Total: USD 999.00`, missing, { warning: "Conflicting total" }),
  fixture("alias-collision", "INVOICE AW-701\nBill To: Alpha Studio\nCurrency: USD\nTotal: 1045.25", missing, { customers: [...extractionCustomers, { customerId: "gamma", legalName: "Gamma", aliases: ["Alpha Studio"] }] }),
  fixture("id-name-disagree", invoice.replace("Alpha Workshops LLC", "Beta Research"), missing),
  fixture("unknown-customer-id", invoice.replace("Customer ID: alpha", "Customer ID: unknown"), missing),
  fixture("foreign-currency", invoice.replace("Currency: USD", "Currency\nEUR"), missing),
  fixture("mixed-currency", `${invoice}\nForeign total: EUR 980.00`, missing),
  fixture("two-invoices", `${invoice}\n=== Page 2 of 2 ===\nINVOICE AW-702\nTotal: USD 500.00`, missing),
  fixture("invoice-and-credit", `${invoice}\nCREDIT MEMO AW-701`, missing),
  fixture("negative-invoice", invoice.replace("USD 1,045.25", "USD -1045.25"), missing),
  fixture("ambiguous-decimal", invoice.replace("USD 1,045.25", "USD 1.045,25"), missing),
  fixture("ocr-digit-ambiguity", invoice.replace("USD 1,045.25", "USD 1,O45.25"), missing),
  fixture("balance-is-not-total", invoice.replace("Total: USD 1,045.25", "Balance Due: USD 1045.25"), missing),
  fixture("missing-number", invoice.replace("Document Number: AW-701\n", ""), missing),
  fixture("unsafe-integer", invoice.replace("1,045.25", "90,071,992,547,409.92"), missing),
  fixture("unknown-layout", "SERVICE RECAP\nAlpha Studio\nTotal USD 1045.25", missing),
];

export function matchesExtraction(actual: Conclusion, fixture: ExtractionFixture): boolean {
  return Object.entries(fixture.expected).every(([k, v]) => actual[k as keyof Conclusion] === v)
    && (!fixture.warning || actual.contradictions.some((w) => w.includes(fixture.warning!)));
}
