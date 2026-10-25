/** Vendor invoice spellings share one identity across legacy and scoped AP paths. */
export function normalizeInvoiceNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(INVOICE|INV|NO)/, "").replace(/^0+/, "");
}
