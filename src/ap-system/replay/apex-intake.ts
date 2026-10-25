/** Builds an AP intake from original PDFs with the local text layer. No paid parser, model or network call. */
import { AP_CONTRACT_VERSION, intakeSchema, type APIntake, type Candidate, type FieldEvidence, type Processor, type PurchasingEvidence, type SourceDocument } from "../contracts";
import type { Upload } from "../ingestion";
import { inspectPdf, type OcrOptions } from "../ingestion/ocr";
import { canonical, inside, saveArtifact, sha256 } from "../ingestion/storage";
import { decimalString, keyValues, mapContractAttorneyInvoice, moneyCents, type MappedInvoice } from "./apex-invoice";
import { readTextLayer, TEXT_LAYER_IMPLEMENTATION, type TextPage, type TextWord } from "./text-layer";

export type TrustedSupplier = { supplierId: string; legalName: string };
export type TrustedCoding = { account: string; treatment: "expense" };
export type TextLayerOptions = { pdftotextPath: string; popplerVersion: string; ocr: OcrOptions };
const normalizedName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function readSource(upload: Upload, storageRoot: string, options: TextLayerOptions) {
  const { bytes, name, mimeType } = upload;
  if (mimeType !== "application/pdf" || !Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("text_layer_requires_pdf");
  const hash = sha256(bytes);
  const original = await saveArtifact(storageRoot, bytes, "pdf");
  const pdf = await inspectPdf(bytes, storageRoot, options.ocr);
  const layer = await readTextLayer(inside(storageRoot, original.ref), options.pdftotextPath);
  const config = canonical({ tool: "pdftotext", args: ["-bbox", "-enc", "UTF-8"], popplerVersion: options.popplerVersion, implementation: TEXT_LAYER_IMPLEMENTATION });
  const processor: Processor = {
    provider: "local-poppler-pdftotext", model: null, version: options.popplerVersion, configHash: sha256(config), jobId: null, resolvedVersion: null,
    implementationVersion: TEXT_LAYER_IMPLEMENTATION, configArtifact: await saveArtifact(storageRoot, config, "json"),
    rawArtifact: await saveArtifact(storageRoot, layer.xhtml, "html"), tokenArtifact: await saveArtifact(storageRoot, JSON.stringify(layer.pages), "json"),
    rasterArtifact: null, traineddata: null,
  };
  const frames = new Map(pdf.frames.map(f => [f.page, f]));
  const pageStatus = Array.from({ length: pdf.count }, (_, i) => {
    const page = layer.pages[i], frame = frames.get(i + 1);
    const status = !page || !page.words.length ? "failed" : frame?.rotation !== 0 || !frame || Math.abs(frame.width - page.width) > 0.5 || Math.abs(frame.height - page.height) > 0.5 ? "failed" : "complete";
    return { page: i + 1, status: status as "complete" | "failed", reason: status === "complete" ? null : !page?.words.length ? "no_native_text_layer" : "unsupported_page_geometry" };
  });
  const source: SourceDocument = {
    sourceId: upload.sourceId ?? `source-${hash.slice(0, 32)}`, revision: upload.revision ?? 1, sha256: hash,
    deliveryId: upload.deliveryId ?? `upload-${hash.slice(0, 16)}`, name, kind: upload.kind ?? "invoice", mimeType, originalRef: original.ref,
    byteLength: bytes.byteLength, originalBase64: Buffer.from(bytes).toString("base64"),
    extractedText: layer.pages.map(p => p.words.map(w => w.text).join(" ")).join("\n"),
    provenance: upload.provenance ?? { kind: "external_private", description: "User uploaded original; provenance supplied by operator, not supplier authentication.", license: "Private user input; no redistribution permission inferred", originalFilename: name },
    replaces: upload.replaces ?? null, pageCount: pdf.count, pageStatus, parser: processor,
  };
  return { source, pages: layer.pages, processor };
}

function evidence(source: SourceDocument, processor: Processor, page: TextPage, fieldPath: string, rawValue: string, normalizedValue: string | number, words: TextWord[]): FieldEvidence {
  return {
    evidenceId: `${source.sourceId}:r${source.revision}:${fieldPath}`,
    source: { sourceId: source.sourceId, revision: source.revision, sha256: source.sha256 }, fieldPath, rawValue, normalizedValue,
    contentStatus: "supported", quote: rawValue,
    grounding: {
      status: "native", method: "native", page: page.page,
      frame: { width: page.width, height: page.height, units: "point", origin: "top_left", rotation: 0, transform: [1, 0, 0, 1, 0, 0] },
      regions: words.map(w => ({ x: w.xMin, y: w.yMin, width: w.xMax - w.xMin, height: w.yMax - w.yMin, granularity: "word" as const, tokenRefs: [w.id] })),
      contextRegions: [], normalization: "html_decode+nfc+whitespace+casefold;no_character_substitution", processor, failureReason: null, elementPath: null,
    },
  };
}

function candidateFrom(invoice: MappedInvoice, source: SourceDocument, processor: Processor, page: TextPage, supplier: TrustedSupplier, coding: TrustedCoding): Candidate {
  const bound = normalizedName(invoice.supplierName) === normalizedName(supplier.legalName);
  return {
    candidateId: `${source.sourceId}:candidate:r${source.revision}`, revision: source.revision,
    sources: [{ sourceId: source.sourceId, revision: source.revision, sha256: source.sha256 }],
    extractedSupplierName: invoice.supplierName, supplierId: bound ? supplier.supplierId : null, invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate, dueDate: invoice.dueDate, terms: invoice.terms, currency: invoice.currency, kind: "invoice", appliesToBillId: null,
    lines: invoice.lines.map(l => ({
      lineId: l.lineId, sku: invoice.matterReference, description: l.description, quantity: { decimal: l.hours, unit: "hour" },
      unitPriceCents: l.rateCents, amountCents: l.amountCents, taxCents: 0,
      evidenceIds: ["sku", "description", "quantity", "unitPriceCents", "amountCents"].map(f => `${source.sourceId}:r${source.revision}:lines.${l.lineId}.${f}`),
      poLineId: null, receiptLineIds: [],
      allocations: [{ account: coding.account, amountCents: l.amountCents, store: null, department: null, project: null, period: invoice.invoiceDate.slice(0, 7), treatment: coding.treatment }],
    })),
    freightAllocations: [], discountAllocations: [], subtotalCents: invoice.subtotalCents, taxCents: 0, freightCents: 0, discountCents: 0, totalCents: invoice.totalCents,
    evidence: invoice.fields.map(f => evidence(source, processor, page, f.fieldPath, f.rawValue, f.normalizedValue, f.words)),
    parseWarnings: invoice.warnings,
  };
}

/** Reads a labeled simulated contract or service-acceptance PDF into same-case purchasing evidence. */
function purchasingFrom(source: SourceDocument, page: TextPage, candidate: Candidate): PurchasingEvidence | null {
  const kv = keyValues(page);
  const get = (k: string) => kv.get(k)?.value ?? null;
  const reference = get("Reference"), sku = get("Service item"), unit = get("Unit"), supplierId = get("Supplier ID");
  if (!reference || !sku || !unit || !supplierId || supplierId !== candidate.supplierId) return null;
  const line = candidate.lines.filter(l => l.sku === sku && l.quantity.unit === unit);
  if (line.length !== 1) return null;
  const binding = { sourceId: source.sourceId, revision: source.revision, sha256: source.sha256 };
  if (source.kind === "contract") {
    const hours = decimalString(get("Not-to-exceed hours") ?? ""), rate = moneyCents(get("Rate") ?? "");
    if (!hours || rate === null) return null;
    return { supplierId, source: binding, kind: "contract", reference, lines: [{ lineId: "C1", sku, quantity: { decimal: hours, unit }, unitPriceCents: rate, invoiceLineId: line[0]!.lineId }], acceptedBy: null, acceptedAt: null };
  }
  if (source.kind === "receipt") {
    const hours = decimalString(get("Accepted hours") ?? ""), by = get("Accepted by"), at = get("Accepted at");
    if (!hours || !by || !at || !Number.isFinite(Date.parse(at))) return null;
    return { supplierId, source: binding, kind: "service_acceptance", reference, lines: [{ lineId: "A1", sku, quantity: { decimal: hours, unit }, unitPriceCents: null, invoiceLineId: line[0]!.lineId }], acceptedBy: by, acceptedAt: at };
  }
  return null;
}

export async function apexTextLayerIntake(input: {
  uploads: Upload[]; storageRoot: string; idempotencyKey: string; explicitRevisionOf?: string | null;
  supplier: TrustedSupplier; coding: TrustedCoding; options: TextLayerOptions;
}): Promise<APIntake> {
  if (input.uploads.length < 1 || input.uploads.length > 10) throw new Error("upload_document_limit");
  if (input.uploads.filter(u => (u.kind ?? "invoice") === "invoice").length !== 1) throw new Error("exactly_one_invoice_required");
  const read = [];
  for (const upload of input.uploads) read.push(await readSource(upload, input.storageRoot, input.options));
  const invoice = read.find(r => r.source.kind === "invoice")!;
  const documents = read.map(r => r.source);
  const incomplete = documents.some(d => d.pageStatus.some(p => p.status !== "complete"));
  const mapped = invoice.pages.length === 1 ? mapContractAttorneyInvoice(invoice.pages[0]!) : { ok: false as const, reason: "unsupported_page_count" };
  let candidate: Candidate | null = null, extraction: APIntake["extraction"];
  const purchasingEvidence: PurchasingEvidence[] = [];
  if (!mapped.ok) extraction = { status: "failed", evidence: [], reasons: [mapped.reason] };
  else if (incomplete) extraction = { status: "incomplete", evidence: [], reasons: ["incomplete_supporting_pages"] };
  else {
    candidate = candidateFrom(mapped.invoice, invoice.source, invoice.processor, invoice.pages[0]!, input.supplier, input.coding);
    for (const r of read) {
      if (r === invoice) continue;
      const p = r.pages.length === 1 ? purchasingFrom(r.source, r.pages[0]!, candidate) : null;
      if (p) purchasingEvidence.push(p);
      else candidate.parseWarnings.push(`Supporting ${r.source.kind} ${r.source.name} produced no purchasing evidence for this invoice.`);
    }
    candidate.sources = documents.map(({ sourceId, revision, sha256 }) => ({ sourceId, revision, sha256 }));
    extraction = { status: "complete", evidence: [], reasons: [] };
  }
  return intakeSchema.parse({ contractVersion: AP_CONTRACT_VERSION, idempotencyKey: input.idempotencyKey, documents, candidate, extraction, purchasingEvidence, explicitRevisionOf: input.explicitRevisionOf ?? null });
}

/** Deterministic single-page Helvetica PDF. Used only for the replay's labeled simulated documents. */
export function simplePdf(lines: string[]): Uint8Array {
  if (lines.some(l => /[^\x20-\x7e]/.test(l))) throw new Error("simple_pdf_ascii_only");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = lines.map((l, i) => `BT /F1 ${i === 0 ? 13 : 10} Tf 56 ${740 - i * 18} Td (${esc(l)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
