import type { Conclusion, EvidenceRef, SourceInput } from "./contracts";

/** A deliberately narrow parser, not a model or a learned document extractor. */
export interface ParseResult {
  conclusion: Conclusion;
  supported: boolean;
  customers: { customerId: string; customerName: string; aliases: string[] }[];
}

export function decimalCents(value: string): number | undefined {
  const m = /^(?:USD\s*|\$)?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replaceAll(",", "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** RFC4180-style quoted fields, including doubled quotes and embedded newlines. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let field = "", quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else field += c;
    } else if (c === '"' && field === "" && !afterQuote) quoted = true;
    else if (c === ",") { row.push(field); field = ""; afterQuote = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row.splice(0)); field = ""; afterQuote = false;
    } else {
      if (afterQuote || c === '"') throw new Error("Malformed quoted CSV field");
      field += c;
    }
  }
  if (quoted) throw new Error("Unclosed quoted CSV field");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const key = (s: string) => s.trim().toLowerCase().replace(/[ _-]/g, "");

export function parseSupportedSource(source: SourceInput, ref: EvidenceRef): ParseResult {
  const text = source.text.trim();
  const evidence = [{ ...ref, quote: text.slice(0, 500) || undefined }];
  const missing = (reason: string, details: string[] = []): ParseResult => ({
    supported: false, customers: [], conclusion: {
      treatment: "needs_evidence", reason, evidence, contradictions: [], missingEvidence: details.length ? details : ["A supported invoice or credit memo with explicit customer, number, currency and total"],
      question: `Please supply the issued invoice or credit memo for “${source.name}” with its customer ID, document number, USD currency and final total, or exclude this source if it is only supporting evidence.`,
    },
  });
  if (!["text/plain", "application/json", "text/csv", "application/pdf"].includes(source.mimeType)) return missing("This source type is supporting evidence or requires an explicit supported-text import.");
  if (!text) return missing("No extracted text is available. Original bytes alone are not verified invoice evidence.");
  let fields: Record<string, unknown> = {}, title = text.split(/\r?\n/)[0]!.trim();
  const contradictions: string[] = [];
  if (source.mimeType === "application/json" || text.startsWith("{")) {
    try {
      const object: unknown = JSON.parse(text);
      if (!object || typeof object !== "object" || Array.isArray(object)) return missing("Expected one structured document per source.");
      for (const [k, v] of Object.entries(object)) fields[key(k)] = v;
      title = String(fields.kind ?? fields.type ?? "");
      contradictions.push("Structured JSON extraction requires human review; it is outside the backend routine text grammar");
    } catch { return missing("Malformed JSON requires corrected source evidence."); }
  } else if (source.mimeType === "text/csv") {
    try {
      const rows = csvRows(text);
      const headers = rows[0]?.map(key) ?? [];
      const customerIndex = headers.indexOf("customerid");
      const nameIndex = headers.findIndex((h) => ["legalname", "customername", "name"].includes(h));
      if (rows.length >= 2 && customerIndex >= 0 && nameIndex >= 0 && !headers.some((h) => ["documentnumber", "invoicenumber", "amountcents", "total"].includes(h))) {
        if (new Set(headers).size !== headers.length || rows.slice(1).some((r) => r.length !== headers.length)) return missing("Customer CSV fields are ambiguous or duplicated.");
        const customers = rows.slice(1).map((r) => ({ customerId: r[customerIndex]!.trim(), customerName: r[nameIndex]!.trim(), aliases: (r[headers.indexOf("aliases")] ?? "").split(/[;|]/).map((a) => a.trim()).filter(Boolean) }));
        if (customers.some((c) => !c.customerId || !c.customerName) || new Set(customers.map((c) => c.customerId)).size !== customers.length) return missing("Customer CSV needs a unique ID and a name on every row.");
        return { supported: true, customers, conclusion: { treatment: "exclude", reason: "Customer registry CSV establishes customer identities, including customers with zero invoice totals; it is not a billing document.", evidence, contradictions: [], missingEvidence: [], category: "customer_record" } };
      }
      if (rows.length !== 2) return missing("A CSV source must contain one header and one document row; import a batch for multiple documents.");
      if (rows[0]!.length !== rows[1]!.length || new Set(rows[0]!.map(key)).size !== rows[0]!.length) return missing("CSV fields are ambiguous or duplicated.");
      rows[0]!.forEach((k, i) => { fields[key(k)] = rows[1]![i]; });
      title = String(fields.kind ?? fields.type ?? "");
      contradictions.push("Structured CSV extraction requires human review; it is outside the backend routine text grammar");
    } catch { return missing("Malformed CSV requires corrected source evidence."); }
  } else {
    for (const line of text.split(/\r?\n/).slice(1)) {
      const m = /^([^:]+):\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const k = key(m[1]!);
      if (fields[k] !== undefined) contradictions.push(`Repeated ${m[1]!.trim()} fields in source`);
      fields[k] = m[2]!;
    }
  }
  const str = (...names: string[]) => names.map((n) => fields[n]).find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  const kind = key(title);
  const invoice = kind === "invoice";
  const credit = ["creditmemo", "creditnote"].includes(kind);
  if (source.mimeType !== "application/json" && source.mimeType !== "text/csv" && invoice && title !== "INVOICE") contradictions.push("Invoice title is outside the exact routine text grammar");
  if (source.mimeType !== "application/json" && source.mimeType !== "text/csv" && credit && title !== "CREDIT MEMO") contradictions.push("Credit title is outside the exact routine text grammar");
  const customerId = str("customerid"), customerName = str("customername", "customer");
  if (["customer", "customerrecord"].includes(kind)) {
    if (!customerId || !customerName) return missing("Customer records require explicit customer ID and name.");
    const aliases = Array.isArray(fields.aliases) && fields.aliases.every((v) => typeof v === "string") ? fields.aliases as string[] : (str("aliases") ?? "").split(/[;|]/).map((a) => a.trim()).filter(Boolean);
    return { supported: true, customers: [{ customerId, customerName, aliases }], conclusion: { treatment: "exclude", reason: "Customer registry evidence; it is not a billing document.", evidence, contradictions: [], missingEvidence: [], category: "customer_record" } };
  }
  if (["statement", "bankexport", "email", "supportingdocument"].includes(kind)) return {
    supported: true, customers: [], conclusion: { treatment: "exclude", reason: "Supporting evidence is not an issued invoice or credit memo.", evidence, contradictions, missingEvidence: [], category: "supporting_document" },
  };
  if (!invoice && !credit) return missing("Unfamiliar document layout; deterministic parsing cannot establish its accounting treatment.");
  const documentNumber = str("documentnumber", "invoicenumber", "creditmemonumber", "creditnumber", "number");
  const currency = str("currency") ?? (/^USD\s+/.test(str("total") ?? "") ? "USD" : undefined);
  const rawCents = fields.amountcents;
  const amountCents = typeof rawCents === "number" && Number.isSafeInteger(rawCents) && rawCents > 0 ? rawCents
    : typeof rawCents === "string" && /^\d+$/.test(rawCents) && Number.isSafeInteger(Number(rawCents)) && Number(rawCents) > 0 ? Number(rawCents)
    : decimalCents(str("total", "amount") ?? "");
  const gaps = [!customerId && "customer ID", !customerName && "customer name", !documentNumber && "document number", currency !== "USD" && "explicit USD currency", amountCents === undefined && "unambiguous positive total in cents"].filter((s): s is string => Boolean(s));
  if (gaps.length) return missing(`Cannot safely record this ${invoice ? "invoice" : "credit memo"}: ${gaps.join(", ")} required.`, gaps);
  if (rawCents !== undefined && str("total", "amount") && decimalCents(str("total", "amount")!) !== amountCents) contradictions.push("Printed total disagrees with amountCents");
  const status = str("status")?.toLowerCase();
  if (status && !["issued", "final", "void", "voided", "cancelled", "canceled"].includes(status)) contradictions.push(`Document status “${status}” is not a verified issued status`);
  if (str("supersedes", "replaces", "revisionof") || /\b(?:supersed(?:e|es|ed)|replaces?|revised|contradict\w*|disputed|unconfirmed)\b/i.test(text)) contradictions.push("Source contains a revision or conflict claim requiring a human decision; it does not authorize replacement");
  const voided = ["void", "voided", "cancelled", "canceled"].includes(status ?? "");
  return { supported: true, customers: [], conclusion: {
    treatment: voided ? "exclude" : invoice ? "include_invoice" : "include_credit", customerId, customerName, documentNumber, amountCents,
    reason: voided ? "Source explicitly marks this document void or cancelled." : `Explicit ${invoice ? "invoice" : "credit memo"} fields parsed by deterministic supported-format rules.`,
    evidence, contradictions, missingEvidence: [], ...(contradictions.length ? { question: `Should ${documentNumber} for ${customerName}, USD ${(amountCents! / 100).toFixed(2)}, count as printed despite these conflicts? Confirm this exact proposed treatment, exclude it, or request corrected evidence.` } : {}),
  } };
}
