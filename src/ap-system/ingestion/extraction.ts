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
  cellNativeRegions,
  groundText,
  normalize,
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
import {
  headerFields, tableLines, money, labelKey, FIELD_LABELS,
} from "./document-mapping";
export { headerFields, tableLines, money } from "./document-mapping";
export type { ExtractedTableLine } from "./document-mapping";
function headerHint(
  output: ProviderOutput,
  field: string,
  value: string,
): NativeRegion | undefined {
  const aliases = FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? [];
  const labels = aliases.map(labelKey);
  const matches: NativeRegion[] = [];
  for (const page of output.grounded)
    for (const [ii, item] of (page.items ?? []).entries()) {
      for (const [ri, row] of (item.rows ?? []).entries()) {
        const labelIndex = row.findIndex(
          (x: unknown) => labels.includes(labelKey(String(x))),
        );
        if (labelIndex < 0) continue;
        for (let ci = labelIndex + 1; ci < row.length; ci++)
          if (normalize(String(row[ci])) === normalize(value)) {
            const cell = item.grounding?.rows?.[ri]?.[ci];
            const regions = cell ? cellNativeRegions(String(row[ci]), cell) : undefined;
            if (regions) matches.push({text: value, page: page.page_number, regions});
          }
      }
      const md = Buffer.from(String(item.md ?? item.value ?? ""), "utf8");
      for (const [li, line] of (item.grounding?.lines ?? []).entries()) {
        const text = md.subarray(line.span?.[0], line.span?.[1]).toString();
        const plain = normalize(text.replace(/\*\*/g, "")).replace(/\s*:\s*/g, ":");
        if (!aliases.some(alias => plain.startsWith(normalize(alias) + ":") || plain === normalize(alias) + " " + normalize(value))) continue;
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
  reasons.push(...fields.issues);
  for (const key of ["invoiceDate", "dueDate"] as const) {
    const value = fields[key];
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) reasons.push(`invalid_${key}`);
  }
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
  if (amounts.subtotalCents !== undefined && lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) !== BigInt(amounts.subtotalCents)) reasons.push("subtotal_arithmetic_mismatch");
  if (["subtotalCents", "taxCents", "freightCents", "discountCents", "totalCents"].every(key => amounts[key] !== undefined) && BigInt(amounts.subtotalCents!) + BigInt(amounts.taxCents!) + BigInt(amounts.freightCents!) - BigInt(amounts.discountCents!) !== BigInt(amounts.totalCents!)) reasons.push("total_arithmetic_mismatch");
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
    freightAllocations: context.coding && amounts.freightCents! > 0 ? [{...context.coding, amountCents: amounts.freightCents, period: fields.invoiceDate!.slice(0, 7)}] : [],
    discountAllocations: context.coding && amounts.discountCents! > 0 ? [{...context.coding, amountCents: amounts.discountCents, period: fields.invoiceDate!.slice(0, 7)}] : [],
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
