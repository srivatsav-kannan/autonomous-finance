// Hand-written parser specs for the two layouts no built-in parser reads. Tests use them as
// stand-ins for what the integrations engineer would write.
import type { ParserSpecInput } from "../parser-spec";

export type Cap = NonNullable<ParserSpecInput["fields"]["vendorName"]>;
export const cap = (pattern: string, as: Cap["as"] = "text", optional = false): Cap => ({ pattern, flags: "m", group: 1, as, optional });

export const PIPE_SPEC: ParserSpecInput = {
  fields: {
    vendorName: cap("^H\\|([^|]*)\\|"),
    invoiceNumber: cap("^H\\|[^|]*\\|([^|]*)\\|"),
    invoiceDate: cap("^H\\|[^|]*\\|[^|]*\\|(\\d{8})\\|", "compact_date"),
    dueDate: cap("^H\\|[^|]*\\|[^|]*\\|[^|]*\\|(\\d{8})\\|", "compact_date", true),
    storeId: cap("^H\\|[^|]*\\|[^|]*\\|[^|]*\\|[^|]*\\|([^|]*)\\|"),
    deliveryId: cap("^H\\|[^|]*\\|[^|]*\\|[^|]*\\|[^|]*\\|[^|]*\\|([^|]*)$", "text", true),
    totalCents: cap("^T\\|(\\d+)\\|", "cents"),
    remitBank: cap("^T\\|\\d+\\|[A-Z]{3}\\|([^|]*)\\|", "text", true),
    remitLast4: cap("^T\\|\\d+\\|[A-Z]{3}\\|[^|]*\\|(\\d{4})$", "text", true),
    note: null,
  },
  lines: {
    pattern: "^L\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|(.*)$", flags: "m",
    sku: { group: 1, as: "text" }, quantity: { group: 2, as: "number" }, unitCents: { group: 3, as: "cents" },
    amountCents: { group: 4, as: "cents" }, description: { group: 5, as: "text" },
  },
};

export const NARRATIVE_SPEC: ParserSpecInput = {
  fields: {
    vendorName: cap("^(.+?): Invoice \\S+$"),
    invoiceNumber: cap("^.+?: Invoice (\\S+)$"),
    invoiceDate: cap("dated ([A-Z][a-z]+ \\d{1,2}, \\d{4}):", "long_date"),
    dueDate: cap("\\(by ([A-Z][a-z]+ \\d{1,2}, \\d{4})\\)", "long_date", true),
    storeId: cap("location \\(([^)]+)\\)"),
    deliveryId: cap("\\), delivery ([^,]+), dated", "text", true),
    totalCents: cap("^Total: (\\$[\\d,]+\\.\\d{2})", "money"),
    remitBank: cap("^Payment details on file: (.+), account ending \\d{4}\\.$", "text", true),
    remitLast4: cap("account ending (\\d{4})\\.$", "text", true),
    note: cap("^(Balance forward:.*)$", "text", true),
  },
  lines: {
    pattern: "^ - (\\d+(?:\\.\\d+)?) x (.+) \\(([^()]+)\\) at (\\$[\\d,]+\\.\\d{2}) each \\((\\$[\\d,]+\\.\\d{2})\\)$", flags: "m",
    quantity: { group: 1, as: "number" }, description: { group: 2, as: "text" }, sku: { group: 3, as: "text" },
    unitCents: { group: 4, as: "money" }, amountCents: { group: 5, as: "money" },
  },
};
