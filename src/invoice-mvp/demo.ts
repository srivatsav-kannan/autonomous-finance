import type { SourceInput } from "./contracts";

/** Public synthetic teaching data. No benchmark or held-out expectations. */
export function demoBatch(stage: "initial" | "late" = "initial"): { label: string; documents: SourceInput[] } {
  const invoice = "INVOICE\nCustomer ID: demo-acorn\nCustomer: Acorn Design\nDocument Number: AC-100\nCurrency: USD\nTotal: USD 1000.00\nStatus: issued";
  const source = (externalId: string, name: string, text: string): SourceInput => ({ externalId, name, mimeType: "text/plain", text });
  if (stage === "late") return { label: "Late corrected Birch invoice", documents: [source("demo-revision", "Birch corrected.txt", "INVOICE\nCustomer ID: demo-birch\nCustomer: Birch Studio\nDocument Number: BI-20\nCurrency: USD\nTotal: USD 450.00\nStatus: issued")] };
  return { label: "Synthetic invoice review demo", documents: [
    source("demo-customer-acorn", "Acorn customer.txt", "CUSTOMER\nCustomer ID: demo-acorn\nCustomer: Acorn Design"),
    source("demo-customer-birch", "Birch customer.txt", "CUSTOMER\nCustomer ID: demo-birch\nCustomer: Birch Studio"),
    source("demo-invoice", "Acorn invoice.txt", invoice),
    source("demo-credit", "Acorn credit.txt", "CREDIT MEMO\nCustomer ID: demo-acorn\nCustomer: Acorn Design\nDocument Number: AC-C10\nCurrency: USD\nTotal: USD 125.00\nStatus: issued"),
    source("demo-duplicate", "Acorn invoice scan copy.txt", invoice),
    source("demo-revision", "Birch original.txt", "INVOICE\nCustomer ID: demo-birch\nCustomer: Birch Studio\nDocument Number: BI-20\nCurrency: USD\nTotal: USD 400.00\nStatus: issued"),
    source("demo-ambiguous", "Acorn disputed invoice.txt", "INVOICE\nCustomer ID: demo-acorn\nCustomer: Acorn Design\nDocument Number: AC-101\nCurrency: USD\nTotal: USD 200.00\nStatus: disputed\nNote: Customer disputes whether this additional service was authorized."),
    source("demo-unfamiliar", "Unfamiliar service recap.txt", "SERVICE RECAP — preliminary\nAcorn Design\nTwo possible totals: USD 75.00 or USD 95.00\nPlease obtain the final issued billing document before counting this recap."),
  ] };
}
