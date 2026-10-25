import type {
  APIntake,
  SourceDocument,
  SourceBinding,
  Processor,
} from "../contracts";
import { AP_CONTRACT_VERSION, intakeSchema } from "../contracts";
import {
  parseWithLlama,
  type ParseOptions,
  type ProviderOutput,
} from "./provider";
import {
  extractCandidate,
  supportingEvidence,
  type TrustedContext,
} from "./extraction";
import { inspectPdf, inspectImage, type OcrOptions } from "./ocr";
import { saveArtifact, sha256 } from "./storage";
import { parseXml, extractXmlCandidate, type XmlOutput } from "./xml";
import { pageStatuses } from "./pages";
export { renderPage } from "./ocr";
export type { TrustedContext } from "./extraction";
export type Upload = {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  sourceId?: string;
  revision?: number;
  deliveryId?: string;
  kind?: SourceDocument["kind"];
  provenance?: SourceDocument["provenance"];
  replaces?: SourceBinding | null;
};
export type UploadOptions = ParseOptions & { ocr?: OcrOptions | false };
export type ParseUploadInput = Upload & {
  storageRoot: string;
  idempotencyKey?: string;
  explicitRevisionOf?: string | null;
  context?: TrustedContext;
  options?: UploadOptions;
};
export type ParsedDocument = {
  source: SourceDocument;
  output: ProviderOutput | null;
  failure: string | null;
  xml?: XmlOutput;
};
export async function parseDocument(
  input: Upload & { storageRoot: string; options?: UploadOptions },
): Promise<ParsedDocument> {
  const { bytes, name, mimeType, storageRoot } = input;
  if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("unsupported_upload_size");
  const xmlMime = [
    "application/xml",
    "text/xml",
    "application/ubl+xml",
  ].includes(mimeType);
  if (
    ![
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/tiff",
      "application/xml",
      "text/xml",
      "application/ubl+xml",
    ].includes(mimeType)
  )
    throw new Error("unsupported_document_mime");
  if (
    mimeType === "application/pdf" &&
    !Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-"))
  )
    throw new Error("invalid_pdf_signature");
  const hash = sha256(bytes),
    original = await saveArtifact(
      storageRoot,
      bytes,
      xmlMime ? "xml" : mimeType === "application/pdf" ? "pdf" : "image",
    );
  const pdf = xmlMime
    ? { count: 1, frames: [] }
    : mimeType === "application/pdf"
      ? await inspectPdf(bytes, storageRoot, input.options?.ocr || {})
      : await inspectImage(bytes, storageRoot, input.options?.ocr || {});
  const pageCount = pdf.count;
  const source: SourceDocument = {
    sourceId: input.sourceId ?? `source-${hash.slice(0, 32)}`,
    revision: input.revision ?? 1,
    sha256: hash,
    deliveryId: input.deliveryId ?? `upload-${hash.slice(0, 16)}`,
    name,
    kind: input.kind ?? "invoice",
    mimeType,
    originalRef: original.ref,
    byteLength: bytes.byteLength,
    originalBase64: Buffer.from(bytes).toString("base64"),
    extractedText: "",
    provenance: input.provenance ?? {
      kind: "external_private",
      description:
        "User uploaded original; provenance supplied by operator, not supplier authentication.",
      license: "Private user input; no redistribution permission inferred",
      originalFilename: name,
    },
    replaces: input.replaces ?? null,
    pageCount,
    pageStatus: Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      status: "missing" as const,
      reason: "Parsing not completed",
    })),
    parser: null,
  };
  try {
    if (xmlMime) {
      const xml = await parseXml(bytes, storageRoot);
      if (source.kind !== "invoice")
        xml.failure = "xml_document_kind_unsupported";
      source.parser = xml.processor;
      source.extractedText = Buffer.from(bytes).toString("utf8");
      source.pageStatus = [
        {
          page: 1,
          status: xml.failure ? "failed" : "complete",
          reason: xml.failure,
        },
      ];
      return { source, output: null, xml, failure: xml.failure };
    }
    const output = await parseWithLlama(
      bytes,
      name,
      mimeType,
      storageRoot,
      input.options,
    );
    if (pdf) output.result.__apOriginalFrames = pdf.frames;
    const pages = output.result.items?.pages ?? [];
    source.parser = output.processor;
    source.extractedText = String(
      output.result.text_full ?? output.result.markdown_full ?? "",
    );
    source.pageStatus = pageStatuses(pageCount, pages);
    output.result.__apPageCoverageValid = source.pageStatus.every(
      (p) => p.status === "complete",
    );
    return { source, output, failure: null };
  } catch (error) {
    const failure =
      error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)
        ? error.message
        : "provider_parse_failed";
    source.pageStatus = source.pageStatus.map((p) => ({
      ...p,
      status: "failed",
      reason: failure,
    }));
    return { source, output: null, failure };
  }
}
export async function parseUpload(input: ParseUploadInput): Promise<APIntake> {
  return combineUploads({
    uploads: [input],
    storageRoot: input.storageRoot,
    idempotencyKey: input.idempotencyKey ?? "ingest-" + sha256(input.bytes),
    explicitRevisionOf: input.explicitRevisionOf,
    context: input.context,
    options: input.options,
  });
}
export async function combineUploads(input: {
  uploads: Upload[];
  storageRoot: string;
  idempotencyKey: string;
  explicitRevisionOf?: string | null;
  context?: TrustedContext;
  options?: UploadOptions;
}): Promise<APIntake> {
  if (input.uploads.length < 1 || input.uploads.length > 10)
    throw new Error("upload_document_limit");
  if (
    input.uploads.reduce((n, u) => n + u.bytes.byteLength, 0) >
    8 * 1024 * 1024
  )
    throw new Error("upload_packet_size_limit");
  const invoiceInputs = input.uploads.filter(
    (u) => (u.kind ?? "invoice") === "invoice",
  );
  if (invoiceInputs.length !== 1)
    throw new Error("exactly_one_invoice_required");
  const parsed: ParsedDocument[] = [];
  for (const upload of input.uploads)
    parsed.push(
      await parseDocument({
        ...upload,
        storageRoot: input.storageRoot,
        options: input.options,
      }),
    );
  const invoice = parsed.find((p) => p.source.kind === "invoice")!;
  const context = input.context ?? {};
  let extraction: APIntake["extraction"] = {
    status: "failed",
    evidence: [],
    reasons: [invoice.failure ?? "invoice_parse_failed"],
  };
  let candidate: APIntake["candidate"] = null;
  if (invoice.xml) {
    const result = extractXmlCandidate(invoice.source, invoice.xml, context);
    candidate = result.candidate;
    extraction = result.extraction;
  } else if (invoice.output) {
    try {
      const result = await extractCandidate(
        invoice.source,
        invoice.output,
        input.storageRoot,
        context,
        input.options?.ocr,
      );
      candidate = result.candidate;
      extraction = result.extraction;
    } catch {
      extraction = {
        status: "failed",
        evidence: [],
        reasons: ["unusable_provider_extraction"],
      };
    }
  }
  const documents = [
    ...parsed.map((p) => p.source),
    ...(context.documents ?? []),
  ];
  const purchasingEvidence = [...(context.purchasingEvidence ?? [])];
  if (candidate) {
    for (const p of parsed)
      if (p.output && p.source.kind !== "invoice") {
        try {
          const evidence = supportingEvidence(
            p.source,
            p.output,
            candidate,
            context,
          );
          if (evidence) purchasingEvidence.push(evidence);
        } catch {
          p.source.pageStatus = p.source.pageStatus.map((s) => ({
            ...s,
            status: "failed",
            reason: "unusable_supporting_extraction",
          }));
        }
      }
    for (const line of candidate.lines) {
      const po = purchasingEvidence
        .filter((p) => p.kind === "purchase_order")
        .flatMap((p) => p.lines)
        .filter((l) => l.invoiceLineId === line.lineId);
      const receipt = purchasingEvidence
        .filter((p) => p.kind === "receipt")
        .flatMap((p) => p.lines)
        .filter((l) => l.invoiceLineId === line.lineId);
      line.poLineId = po.length === 1 ? po[0]!.lineId : null;
      line.receiptLineIds = receipt.map((l) => l.lineId);
    }
    candidate.sources = documents.map(({ sourceId, revision, sha256 }) => ({
      sourceId,
      revision,
      sha256,
    }));
    if (
      documents.some((s) => s.pageStatus.some((p) => p.status !== "complete"))
    ) {
      extraction = {
        status: "incomplete",
        evidence: candidate.evidence,
        reasons: ["incomplete_supporting_pages"],
      };
      candidate = null;
    }
  }
  return intakeSchema.parse({
    contractVersion: AP_CONTRACT_VERSION,
    idempotencyKey: input.idempotencyKey,
    documents,
    candidate,
    extraction,
    purchasingEvidence,
    explicitRevisionOf: input.explicitRevisionOf ?? null,
  });
}
