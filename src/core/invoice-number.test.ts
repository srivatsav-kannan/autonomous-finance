import { describe, expect, it } from "vitest";
import { normalizeInvoiceNumber } from "../../convex/ap";

describe("invoice number normalization", () => {
  it.each(["42", "00042", "INV-00042", "inv 42", "INVOICE-00042", "invoice 42", "NO-0042"])(
    "identifies %s as the same invoice",
    (value) => expect(normalizeInvoiceNumber(value)).toBe("42"),
  );

  it.each(["INV-00042", "INVOICE-00042", "NO-0042"])(
    "does not collapse distinct invoice numbers after %s",
    (value) => expect(normalizeInvoiceNumber(value)).not.toBe(normalizeInvoiceNumber("INVOICE-00043")),
  );

  it("preserves supplier-specific identifiers", () => {
    expect(normalizeInvoiceNumber("NCD-5001")).toBe("NCD5001");
    expect(normalizeInvoiceNumber("HYD-5-R")).toBe("HYD5R");
  });
});
