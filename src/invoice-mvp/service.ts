import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import "../core/env";
import type { DecisionInput, IngestBatchInput, RuntimeMode, SeatAuth } from "./contracts";
import { ConvexInvoiceBackend, InvoiceError, type InvoiceBackend } from "./backend";
import { idempotency, investigate, type InvestigationResult } from "./investigator";
import type { InvestigatorModel } from "./model";
import { parseSupportedSource } from "./parser";

// Convex transport has a bounded request size. Import larger collections in batches.
export const MAX_BATCH_BYTES = 9_500_000;
export const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
export const MAX_TEXT_BYTES = 750_000;
const sourceSchema = z.object({ externalId: z.string().min(1).max(500), name: z.string().min(1).max(500), mimeType: z.string().min(1).max(200), text: z.string().max(1_000_000), contentBase64: z.string().max(Math.ceil(MAX_SOURCE_BYTES / 3) * 4).optional(), replacesExternalId: z.string().min(1).max(500).optional() }).strict();
const batchSchema = z.object({ label: z.string().min(1).max(300), documents: z.array(sourceSchema).min(1).max(100), idempotencyKey: z.string().min(1).max(500).optional() }).strict();
const decisionSchema = z.object({ caseId: z.string().min(1), proposalId: z.string().min(1), evidenceVersion: z.number().int().positive(), idempotencyKey: z.string().min(1).max(500), action: z.enum(["accept", "exclude", "request_evidence"]), note: z.string().max(4000).optional() }).strict();
export type ProcessResult = { mode: RuntimeMode; processed: InvestigationResult[]; errors: { caseId: string; code: string; message: string }[]; remaining: number };

/** The same application boundary is used by the HTTP UI and evaluation adapters. */
export class InvoiceService {
  private processing: Promise<ProcessResult> | undefined;
  readonly mode: RuntimeMode;
  constructor(readonly backend: InvoiceBackend, readonly model?: InvestigatorModel) { this.mode = model?.mode ?? "deterministic"; }
  async workspace() { return { ...await this.backend.workspace(), runtimeMode: this.mode }; }
  async caseDetail(caseId: string) { return this.backend.caseDetail(z.string().min(1).parse(caseId)); }
  async ingestBatch(input: Omit<IngestBatchInput, "idempotencyKey"> & { idempotencyKey?: string }) {
    const parsed = batchSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_BATCH_BYTES) throw new InvoiceError("batch_too_large", "Batch exceeds 9,500,000 encoded bytes. Import smaller batches while preserving original bytes.", 413);
    for (const source of parsed.documents) {
      if (Buffer.byteLength(source.text) > MAX_TEXT_BYTES) throw new InvoiceError("text_too_large", "Extracted text exceeds 750,000 UTF-8 bytes.", 413);
      if (source.mimeType === "application/pdf" && !source.contentBase64) throw new InvoiceError("original_required", "PDF imports require original contentBase64 alongside extracted text.");
      if (source.contentBase64 !== undefined) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.contentBase64)) throw new InvoiceError("invalid_base64", "Original source bytes must be canonical base64.");
        const bytes = Buffer.from(source.contentBase64, "base64");
        if (bytes.length > MAX_SOURCE_BYTES || bytes.toString("base64") !== source.contentBase64) throw new InvoiceError("invalid_source_bytes", "Original source exceeds 6 MiB or is not canonical base64.");
        if (["text/plain", "text/csv", "application/json", "message/rfc822", "application/mbox"].includes(source.mimeType)) {
          let original: string;
          try { original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new InvoiceError("source_encoding_invalid", "Text originals must be valid UTF-8; preserve other encodings as unsupported evidence."); }
          if (original !== source.text && original.replaceAll("\r\n", "\n") !== source.text) throw new InvoiceError("source_text_mismatch", "Text import bytes must match extracted text exactly, except documented CRLF-to-LF normalization.");
        }
      }
    }
    return this.backend.ingestBatch({ ...parsed, idempotencyKey: parsed.idempotencyKey ?? idempotency("batch", [parsed.label, parsed.documents]) });
  }
  async decide(input: DecisionInput) {
    const result = await this.backend.decide(decisionSchema.parse(input));
    // The decision itself is already durable. A failed resume never undoes it.
    await this.processPending();
    return result;
  }
  async processPending(options: { maxCases?: number; allowLive?: boolean } = {}): Promise<ProcessResult> {
    if (this.mode === "live_model" && !options.allowLive) throw new InvoiceError("live_opt_in_required", "Each live processing batch requires explicit opt-in.");
    // Current backend cannot reserve a run-wide request budget atomically. Fail closed.
    if (this.mode === "live_model") throw new InvoiceError("live_budget_backend_required", "Live execution is blocked until the backend supports atomic run-wide budget reservation.", 409);
    if (this.processing) return this.processing;
    const maxCases = Math.min(200, Math.max(1, Math.floor(options.maxCases ?? 25)));
    this.processing = this.process(maxCases);
    try { return await this.processing; } finally { this.processing = undefined; }
  }
  private async process(maxCases: number): Promise<ProcessResult> {
    const results: InvestigationResult[] = [], errors: ProcessResult["errors"] = [];
    const pendingCases = await this.backend.pendingCases();
    // CRM sources are dependencies, regardless of filename/order within a batch.
    const prepared = await Promise.all(pendingCases.map(async (pending) => {
      try { const detail = await this.backend.caseDetail(pending.caseId); return { pending, isCustomer: parseSupportedSource(detail.source, detail.source).customers.length > 0 }; }
      catch { return { pending, isCustomer: false }; }
    }));
    prepared.sort((a, b) => Number(b.isCustomer) - Number(a.isCustomer));
    for (const { pending, isCustomer } of prepared.slice(0, maxCases)) {
      try {
        // Already-investigating work is reclaimable; no process-local state is authoritative.
        await this.backend.beginInvestigation(pending.caseId);
        const detail = await this.backend.caseDetail(pending.caseId);
        if (["recorded", "excluded", "superseded", "duplicate", "needs_review", "evidence_missing"].includes(detail.case.status)) continue;
        results.push(await investigate(this.backend, detail, isCustomer ? undefined : this.model));
      } catch (e) {
        errors.push({ caseId: pending.caseId, code: e instanceof InvoiceError ? e.code : "investigation_failed", message: e instanceof InvoiceError ? e.message : "Investigation failed; pending work remains durable for retry." });
        if (e instanceof InvoiceError && /stale|conflict|forbidden|unauthorized/.test(e.code)) continue;
        try {
          const detail = await this.backend.caseDetail(pending.caseId);
          if (detail.case.status !== "investigating") continue;
          await this.backend.submitProposal({ caseId: detail.case.caseId, evidenceVersion: detail.case.evidenceVersion, mode: this.mode,
            conclusion: { treatment: "needs_evidence", reason: "Processing could not establish a supported conclusion. The source and pending work are preserved.", evidence: [{ documentId: detail.source.documentId, version: detail.source.version, contentHash: detail.source.contentHash }], contradictions: [], missingEvidence: ["A complete investigation or corrected source evidence"], question: "Please review the preserved source and supply corrected invoice evidence, or exclude it if it is only supporting material." },
            idempotencyKey: idempotency("processing-error", [detail.case.caseId, detail.case.evidenceVersion, errors.at(-1)!.code]),
          });
        } catch { /* Backend outage cannot erase durable work; next startup/process recovers it. */ }
      }
    }
    return { mode: this.mode, processed: results, errors, remaining: (await this.backend.pendingCases()).length };
  }
}

/** No implicit admin setup, schema deployment, mock store, or model credential probing. */
export function createServiceFromEnv(): InvoiceService {
  const runId = process.env.INVOICE_MVP_RUN_ID;
  const url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
  if (!runId || !url) throw new InvoiceError("configuration_required", "Set INVOICE_MVP_RUN_ID and CONVEX_URL to an initialized invoice workspace.");
  const seatFile = process.env.INVOICE_MVP_SEATS_FILE;
  const tokens: Record<string, string> = seatFile ? JSON.parse(readFileSync(seatFile, "utf8")) : {};
  const humanId = process.env.INVOICE_MVP_HUMAN_SEAT ?? "human-cfo";
  const investigatorId = process.env.INVOICE_MVP_INVESTIGATOR_SEAT ?? "invoice-investigator";
  const humanToken = process.env.INVOICE_MVP_HUMAN_TOKEN ?? tokens[humanId];
  const investigatorToken = process.env.INVOICE_MVP_INVESTIGATOR_TOKEN ?? tokens[investigatorId];
  if (!humanToken || !investigatorToken) throw new InvoiceError("configuration_required", "Provide server-side human and investigator seat tokens using INVOICE_MVP_SEATS_FILE or dedicated environment variables.");
  if (process.env.INVOICE_MVP_MODE && process.env.INVOICE_MVP_MODE !== "deterministic") throw new InvoiceError("live_budget_backend_required", "The server supports deterministic mode until atomic budget reservation is available. Mock mode is test-only; live evaluation is NOT RUN.");
  const human: SeatAuth = { runId, seatId: humanId, token: humanToken }, investigator: SeatAuth = { runId, seatId: investigatorId, token: investigatorToken };
  return new InvoiceService(new ConvexInvoiceBackend(new ConvexHttpClient(url), human, investigator));
}
