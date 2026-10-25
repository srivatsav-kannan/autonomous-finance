import type {
  Allocation,
  APIntake,
  Candidate,
  CandidateLine,
  FieldEvidence,
  SourceDocument,
  PurchasingEvidence,
  SourceBinding,
} from "../contracts";
import { candidateSchema } from "../contracts";
import type { ProviderOutput, Json } from "./provider";
import {
  providerGrounding,
  groundText,
  normalize,
  decode,
  type NativeRegion,
  type GroundingData,
} from "./grounding";
import { localOcr, type OcrOptions } from "./ocr";
import { sha256 } from "./storage";
export type TrustedContext = {
  documents?: SourceDocument[];
  purchasingEvidence?: PurchasingEvidence[];
  supplier?: { supplierId: string; legalName: string; aliases?: string[] };
  coding?: Omit<Allocation, "amountCents" | "period">;
};
export type ExtractedTableLine = {
  sku: string;
  description: string;
  quantity: string;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  page: number;
  cells: Map<string, { text: string; hint?: NativeRegion }>;
};
export function money(value: string): number | null {
  const m =
    /^(?:USD\s*|\$\s*)?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/.exec(
      decode(value).trim(),
    );
  if (!m) return null;
  const n =
    BigInt(m[1]!.replaceAll(",", "")) * 100n +
    BigInt((m[2] ?? "").padEnd(2, "0"));
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
function labelKey(s: string) {
  return normalize(s).replace(/[^a-z0-9]/g, "");
}
const headerAliases: Record<string, string[]> = {
  sku: ["sku", "itemcode", "item"],
  description: ["description"],
  quantity: ["qty", "quantity"],
  unit: ["uom", "unitofmeasure"],
  unitPriceCents: ["unitusd", "unitprice", "unitpriceusd", "price", "rate"],
  amountCents: ["amountusd", "amount", "lineamount", "linetotal"],
};
export function tableLines(
  output: ProviderOutput,
  issues: string[] = [],
): ExtractedTableLine[] {
  const result: ExtractedTableLine[] = [];
  for (const page of output.result.items?.pages ?? []) {
    for (const [ii, item] of (page.items ?? []).entries()) {
      if (item.type !== "table" || !item.rows?.length) continue;
      const headers = (item.rows[0] as unknown[]).map((v) =>
        labelKey(String(v)),
      );
      const columns = new Map<string, number>();
      for (const [field, aliases] of Object.entries(headerAliases)) {
        const i = headers.findIndex((h: string) => aliases.includes(h));
        if (i >= 0) columns.set(field, i);
      }
      if (columns.size !== 6) {
        if (
          columns.has("quantity") &&
          (columns.has("sku") || columns.has("description"))
        )
          issues.push("unsupported_line_table_columns");
        continue;
      }
      const grounded = output.grounded.find(
        (p) => p.page_number === page.page_number,
      )?.items?.[ii];
      for (let ri = 1; ri < item.rows.length; ri++) {
        const row = item.rows[ri] as unknown[],
          cells = new Map<string, { text: string; hint?: NativeRegion }>();
        for (const [field, ci] of columns) {
          const text = decode(String(row[ci] ?? "")).trim();
          const b = grounded?.grounding?.rows?.[ri]?.[ci]?.bbox;
          const hint =
            b &&
            normalize(String(grounded?.rows?.[ri]?.[ci] ?? "")) ===
              normalize(text)
              ? {
                  text,
                  page: page.page_number,
                  regions: (Array.isArray(b) ? b : [b]).map((v: Json) => ({
                    x: v.x,
                    y: v.y,
                    width: v.w,
                    height: v.h,
                    granularity: "cell" as const,
                    tokenRefs: [],
                  })),
                }
              : undefined;
          cells.set(field, { text, hint });
        }
        const val = (k: string) => cells.get(k)!.text;
        // Some providers include the explicitly labeled summary footer in the line table.
        if (
          ["sku", "description", "quantity", "unit"].every((k) => !val(k)) &&
          [
            "subtotal",
            "tax",
            "freight",
            "discount",
            "total",
            "totaldue",
          ].includes(labelKey(val("unitPriceCents")))
        )
          continue;
        const qty = val("quantity"),
          price = money(val("unitPriceCents")),
          amount = money(val("amountCents"));
        if (
          !val("sku") ||
          !val("description") ||
          !/^\d+(\.\d{1,6})?$/.test(qty) ||
          price === null ||
          amount === null ||
          !val("unit")
        ) {
          issues.push(`unparsed_line_row_page_${page.page_number}_row_${ri}`);
          continue;
        }
        result.push({
          sku: val("sku"),
          description: val("description"),
          quantity: qty,
          unit: val("unit"),
          unitPriceCents: price,
          amountCents: amount,
          page: page.page_number,
          cells,
        });
      }
    }
  }
  return result;
}
export function headerFields(output: ProviderOutput) {
  const text = String(output.result.markdown_full ?? "")
    .replace(/\*\*/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");
  const find = (label: string) => {
    const re = new RegExp(
      `(?:^|\\n|\\|)\\s*(?:${label})\\s*:?\\s*(?:\\|\\s*)?([^\\n|]+)`,
      "gim",
    );
    const values = [...text.matchAll(re)]
      .map((m) => m[1]!.trim())
      .filter(Boolean);
    return [...new Set(values)].length === 1 ? values[0]! : null;
  };
  return {
    extractedSupplierName: find("Supplier"),
    invoiceNumber: find("Document Number|Invoice (?:Number|#)"),
    invoiceDate: find("Invoice Date"),
    dueDate: find("Due Date"),
    terms: find("Terms"),
    currency: find("Currency"),
    subtotalCents: find("Subtotal"),
    taxCents: find("Tax"),
    freightCents: find("Freight"),
    discountCents: find("Discount"),
    totalCents: find("Invoice Total|Grand Total|Total"),
    reference: find("Document Number"),
    delivery: find("Delivery Reference"),
    acceptedBy: find("Receiving owner"),
    acceptedAt: find("Acceptance recorded"),
    text,
  };
}
function headerHint(
  output: ProviderOutput,
  field: string,
  value: string,
): NativeRegion | undefined {
  const labels: Record<string, string> = {
    extractedSupplierName: "supplier",
    invoiceNumber: "documentnumber",
    invoiceDate: "invoicedate",
    dueDate: "duedate",
    terms: "terms",
    currency: "currency",
    subtotalCents: "subtotal",
    taxCents: "tax",
    freightCents: "freight",
    discountCents: "discount",
    totalCents: "total",
  };
  const matches: NativeRegion[] = [];
  for (const page of output.grounded)
    for (const [ii, item] of (page.items ?? []).entries()) {
      for (const [ri, row] of (item.rows ?? []).entries()) {
        const labelIndex = row.findIndex(
          (x: unknown) => labelKey(String(x)) === labels[field],
        );
        if (labelIndex < 0) continue;
        for (let ci = labelIndex + 1; ci < row.length; ci++)
          if (normalize(String(row[ci])) === normalize(value)) {
            const b = item.grounding?.rows?.[ri]?.[ci]?.bbox;
            if (b)
              matches.push({
                text: value,
                page: page.page_number,
                regions: (Array.isArray(b) ? b : [b]).map((v: Json) => ({
                  x: v.x,
                  y: v.y,
                  width: v.w,
                  height: v.h,
                  granularity: "cell",
                  tokenRefs: [],
                })),
              });
          }
      }
      const md = Buffer.from(String(item.md ?? item.value ?? ""), "utf8");
      for (const [li, line] of (item.grounding?.lines ?? []).entries()) {
        const text = md.subarray(line.span?.[0], line.span?.[1]).toString();
        if (!labelKey(text).startsWith(labels[field] ?? "!")) continue;
        const words = (line.words ?? []).map((w: Json, wi: number) => ({
          text: md.subarray(w.span?.[0], w.span?.[1]).toString(),
          b: w.bbox,
          ref: `native:${page.page_number}:${ii}:${li}:${wi}`,
        }));
        const q = normalize(value).split(" ");
        for (let start = 0; start <= words.length - q.length; start++) {
          const selected = words.slice(start, start + q.length);
          if (
            selected.every(
              (w: Json, i: number) => normalize(w.text) === q[i] && w.b,
            )
          )
            matches.push({
              text: value,
              page: page.page_number,
              regions: selected.map((w: Json) => ({
                x: w.b.x,
                y: w.b.y,
                width: w.b.w,
                height: w.b.h,
                granularity: "word",
                tokenRefs: [w.ref],
              })),
            });
        }
      }
    }
  return matches.length === 1 ? matches[0] : undefined;
}
export async function extractCandidate(
  source: SourceDocument,
  output: ProviderOutput,
  storageRoot: string,
  context: TrustedContext = {},
  ocrOptions: OcrOptions | false = {},
): Promise<{
  candidate: Candidate | null;
  extraction: APIntake["extraction"];
}> {
  const reasons: string[] = [];
  const fields = headerFields(output),
    table = tableLines(output, reasons),
    data = providerGrounding(output),
    evidence: FieldEvidence[] = [];
  let ocr: Promise<GroundingData> | undefined;
  const fallback =
    ocrOptions === false
      ? undefined
      : () => (ocr ??= localOcr(source, storageRoot, ocrOptions));
  const bind: SourceBinding = {
    sourceId: source.sourceId,
    revision: source.revision,
    sha256: source.sha256,
  };
  async function add(
    fieldPath: string,
    rawValue: string,
    normalizedValue: string | number | null,
    page?: number,
    hint?: NativeRegion,
  ) {
    const grounding = await groundText(rawValue, data, {
      page,
      nativeHint: hint,
      localOcr: fallback,
    });
    const e: FieldEvidence = {
      evidenceId: "e-" + sha256(`${source.sha256}:${fieldPath}`).slice(0, 24),
      source: bind,
      fieldPath,
      rawValue,
      normalizedValue,
      contentStatus: "supported",
      quote: rawValue,
      grounding,
    };
    evidence.push(e);
    return e.evidenceId;
  }
  for (const key of [
    "extractedSupplierName",
    "invoiceNumber",
    "invoiceDate",
    "dueDate",
    "currency",
    "terms",
  ] as const) {
    const value = fields[key];
    if (value)
      await add(key, value, value, undefined, headerHint(output, key, value));
    else if (!["dueDate", "terms"].includes(key))
      reasons.push(`missing_${key}`);
  }
  const amounts: Record<string, number> = {};
  for (const key of [
    "subtotalCents",
    "taxCents",
    "freightCents",
    "discountCents",
    "totalCents",
  ] as const) {
    const raw = fields[key],
      value = raw === null ? null : money(raw);
    if (value === null) reasons.push(`missing_or_ambiguous_${key}`);
    else {
      amounts[key] = value;
      await add(key, raw!, value, undefined, headerHint(output, key, raw!));
    }
  }
  if (fields.currency !== "USD")
    reasons.push("unsupported_or_missing_currency");
  if (!table.length) reasons.push("missing_supported_line_table");
  if (source.pageStatus.some((p) => p.status !== "complete"))
    reasons.push("incomplete_pages");
  const lines: CandidateLine[] = [];
  for (const [i, row] of table.entries()) {
    const lineId = `line-${i + 1}`,
      evidenceIds: string[] = [];
    for (const [field, cell] of row.cells)
      evidenceIds.push(
        await add(
          `lines.${lineId}.${field}`,
          cell.text,
          field === "amountCents"
            ? row.amountCents
            : field === "unitPriceCents"
              ? row.unitPriceCents
              : cell.text,
          row.page,
          cell.hint,
        ),
      );
    const allocations: Allocation[] =
      context.coding && fields.invoiceDate
        ? [
            {
              ...context.coding,
              amountCents: row.amountCents,
              period: fields.invoiceDate.slice(0, 7),
            },
          ]
        : [];
    lines.push({
      lineId,
      sku: row.sku,
      description: row.description,
      quantity: { decimal: row.quantity, unit: row.unit },
      unitPriceCents: row.unitPriceCents,
      amountCents: row.amountCents,
      taxCents: 0,
      evidenceIds,
      poLineId: null,
      receiptLineIds: [],
      allocations,
    });
  }
  // Tax allocation is explicit: non-zero header tax needs reviewed line allocation; no invented split.
  if ((amounts.taxCents ?? 0) !== 0)
    reasons.push("line_tax_allocation_requires_review");
  if (reasons.length)
    return {
      candidate: null,
      extraction: { status: "incomplete", evidence, reasons },
    };
  const value = {
    candidateId: "candidate-" + source.sourceId,
    revision: source.revision,
    sources: [bind],
    extractedSupplierName: fields.extractedSupplierName,
    supplierId: matchesTrustedSupplier(fields.extractedSupplierName!, context)
      ? context.supplier!.supplierId
      : null,
    invoiceNumber: fields.invoiceNumber,
    invoiceDate: fields.invoiceDate,
    dueDate: fields.dueDate,
    terms: fields.terms,
    currency: "USD",
    kind: "invoice",
    appliesToBillId: null,
    lines,
    freightAllocations: [],
    discountAllocations: [],
    ...amounts,
    evidence,
    parseWarnings: [
      "LlamaParse resolved parser version not exposed; requested concrete version retained.",
    ],
  };
  const parsed = candidateSchema.safeParse(value);
  if (!parsed.success)
    return {
      candidate: null,
      extraction: {
        status: "incomplete",
        evidence,
        reasons: ["candidate_schema_validation_failed"],
      },
    };
  return {
    candidate: parsed.data,
    extraction: { status: "complete", evidence: [], reasons: [] },
  };
}
function matchesTrustedSupplier(name: string, context: TrustedContext) {
  return Boolean(
    context.supplier &&
    [context.supplier.legalName, ...(context.supplier.aliases ?? [])].some(
      (allowed) => normalize(allowed) === normalize(name),
    ),
  );
}
export function supportingEvidence(
  source: SourceDocument,
  output: ProviderOutput,
  candidate: Candidate,
  context: TrustedContext,
): PurchasingEvidence | null {
  if (
    !["purchase_order", "receipt", "contract"].includes(source.kind) ||
    !context.supplier
  )
    return null;
  const header = headerFields(output);
  if (
    !header.extractedSupplierName ||
    !matchesTrustedSupplier(header.extractedSupplierName, context)
  )
    return null;
  const issues: string[] = [];
  const rows = tableLines(output, issues);
  if (issues.length) return null;
  const kind = source.kind as "purchase_order" | "receipt" | "contract",
    prefix = kind === "purchase_order" ? "po" : kind;
  const lines: PurchasingEvidence["lines"] = [];
  for (const [i, row] of rows.entries()) {
    const matching = candidate.lines.filter(
      (l) => l.sku === row.sku && l.quantity.unit === row.unit,
    );
    if (matching.length !== 1) continue;
    const line = matching[0]!,
      lineId = `${prefix}-line-${i + 1}`;
    lines.push({
      lineId,
      sku: row.sku,
      quantity: { decimal: row.quantity, unit: row.unit },
      unitPriceCents: row.unitPriceCents,
      invoiceLineId: line.lineId,
    });
  }
  if (!header.reference || !lines.length) return null;
  return {
    supplierId: context.supplier.supplierId,
    source: {
      sourceId: source.sourceId,
      revision: source.revision,
      sha256: source.sha256,
    },
    kind,
    reference: header.reference,
    lines,
    acceptedBy: kind === "receipt" ? header.acceptedBy : null,
    acceptedAt: kind === "receipt" ? header.acceptedAt : null,
  };
}
