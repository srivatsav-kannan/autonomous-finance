import { formatMoney } from "../core/money";

export interface InvoiceLine {
  sku: string;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

export interface InvoiceDoc {
  vendorName: string;
  vendorEmail: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  storeId: string;
  storeName: string;
  deliveryId?: string;
  lines: InvoiceLine[];
  totalCents: number;
  remitBank: string;
  remitLast4: string;
  termsNetDays: number;
  note?: string;
}

const money = (c: number) => formatMoney(c).replace("$", "");

function usDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Each vendor sends its own layout. Agents get raw text, exactly like an AP inbox. */
export function renderInvoice(doc: InvoiceDoc, layout: "columnar" | "keyvalue" | "narrative" | "pipe"): string {
  switch (layout) {
    case "columnar": {
      const rows = doc.lines
        .map((l) => `${l.sku.padEnd(14)}${l.description.padEnd(34)}${String(l.quantity).padStart(5)}${money(l.unitCents).padStart(10)}${money(l.amountCents).padStart(12)}`)
        .join("\n");
      return [
        doc.vendorName.toUpperCase(),
        `Accounts Receivable  ${doc.vendorEmail}`,
        `INVOICE                                   Invoice #: ${doc.invoiceNumber}`,
        `Bill To: Sweetgreen - ${doc.storeName} (${doc.storeId})`,
        `Invoice Date: ${doc.invoiceDate}     Due Date: ${doc.dueDate}`,
        doc.deliveryId ? `Delivery: ${doc.deliveryId}` : "",
        "",
        `${"SKU".padEnd(14)}${"DESCRIPTION".padEnd(34)}${"QTY".padStart(5)}${"UNIT".padStart(10)}${"AMOUNT".padStart(12)}`,
        rows,
        "",
        `${"TOTAL DUE".padStart(63)}${money(doc.totalCents).padStart(12)}`,
        `Remit to: ${doc.remitBank}  acct ****${doc.remitLast4}`,
        doc.note ?? "",
      ].filter((l) => l !== "").join("\n");
    }
    case "keyvalue": {
      const items = doc.lines
        .map((l, i) => `Item ${i + 1}: ${l.sku} | ${l.description} | qty ${l.quantity} | ${formatMoney(l.unitCents)} | ${formatMoney(l.amountCents)}`)
        .join("\n");
      return [
        `Vendor: ${doc.vendorName}`,
        `Invoice Number: ${doc.invoiceNumber}`,
        `Invoice Date: ${usDate(doc.invoiceDate)}`,
        `Terms: Net ${doc.termsNetDays}`,
        `Ship To: Sweetgreen #${doc.storeId}`,
        doc.deliveryId ? `Delivery Ref: ${doc.deliveryId}` : "",
        items,
        `Amount Due: ${formatMoney(doc.totalCents)}`,
        `Pay to: ${doc.remitBank} account ending ${doc.remitLast4}`,
        doc.note ?? "",
      ].filter((l) => l !== "").join("\n");
    }
    case "narrative": {
      const items = doc.lines
        .map((l) => ` - ${l.quantity} x ${l.description} (${l.sku}) at ${formatMoney(l.unitCents)} each (${formatMoney(l.amountCents)})`)
        .join("\n");
      return [
        `${doc.vendorName}: Invoice ${doc.invoiceNumber}`,
        "",
        `Hello Sweetgreen AP team,`,
        `Please find charges for your ${doc.storeName} location (${doc.storeId})${doc.deliveryId ? `, delivery ${doc.deliveryId}` : ""}, dated ${longDate(doc.invoiceDate)}:`,
        items,
        "",
        `Total: ${formatMoney(doc.totalCents)}, due within ${doc.termsNetDays} days (by ${longDate(doc.dueDate)}).`,
        `Payment details on file: ${doc.remitBank}, account ending ${doc.remitLast4}.`,
        doc.note ?? "",
        `Thank you, ${doc.vendorName} billing`,
      ].filter((l) => l !== "").join("\n");
    }
    case "pipe": {
      // A vendor that changed systems mid-month: a format no existing parser knows.
      const items = doc.lines.map((l) => `L|${l.sku}|${l.quantity}|${l.unitCents}|${l.amountCents}|${l.description}`).join("\n");
      return [
        `H|${doc.vendorName}|${doc.invoiceNumber}|${doc.invoiceDate.replaceAll("-", "")}|${doc.dueDate.replaceAll("-", "")}|${doc.storeId}|${doc.deliveryId ?? ""}`,
        items,
        `T|${doc.totalCents}|USD|${doc.remitBank}|${doc.remitLast4}`,
      ].join("\n");
    }
  }
}

export function renderCreditMemo(o: { vendorName: string; memoNumber: string; date: string; storeId: string; amountCents: number; reason: string; refInvoice: string }): string {
  return [
    `${o.vendorName.toUpperCase()}: CREDIT MEMO ${o.memoNumber}`,
    `Date: ${o.date}`,
    `Customer: Sweetgreen (${o.storeId})`,
    `Reference invoice: ${o.refInvoice}`,
    `Credit amount: ${formatMoney(o.amountCents)}`,
    `Reason: ${o.reason}`,
    `This credit will be applied against your next invoice.`,
  ].join("\n");
}

export function renderLeaseInvoice(o: { landlord: string; storeId: string; storeName: string; period: string; baseRentCents: number; camCents: number; invoiceNumber: string; date: string; dueDate: string }): string {
  return [
    `${o.landlord}: Rent Statement ${o.invoiceNumber}`,
    `Tenant: Sweetgreen - ${o.storeName} (${o.storeId})`,
    `Period: ${o.period}    Statement date: ${o.date}    Due: ${o.dueDate}`,
    `Base rent: ${formatMoney(o.baseRentCents)}`,
    `Common area maintenance (CAM): ${formatMoney(o.camCents)}`,
    `Total due: ${formatMoney(o.baseRentCents + o.camCents)}`,
  ].join("\n");
}
